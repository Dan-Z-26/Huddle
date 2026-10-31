import { randomUUID } from "node:crypto";
import { Router } from "express";
import { interpretChange } from "../agents/budget.js";
import { noticeFacts, noticeTargets, word } from "../agents/notices.js";
import { computeBudget, tierForCost } from "../core/budgetEngine.js";
import { computeConsequences, resolutionEvents } from "../core/consequences.js";
import { canSeeBudget } from "../core/permissions.js";
import { rankOf } from "../core/priorities.js";
import { getTemplate } from "../core/templates.js";
import { flagAtRisk } from "../core/timelinePlanner.js";
import { HttpError, managerOnly, ownEvent, requireBudget, requireUser, validate } from "../http.js";
import { postAgentMessage } from "../store/workspace.js";
import * as schemas from "../validation/schemas.js";
import { saveTasks, timelineView } from "./timeline.js";

const MAX_PENDING_PER_EVENT = 100;

/** The budget as a user may see it: core members get only the categories they own, and no totals. */
function budgetFor(event, state, role) {
  const computed = computeBudget(state);
  const categories = computed.categories
    .filter(({ id }) => canSeeBudget(role, { categoryId: id }))
    .map((category) => {
      const { tiers, locked } = state.categories.find(({ id }) => id === category.id);
      const tier = tierForCost(tiers, category.committedMinor);
      return {
        ...category,
        locked,
        // Only the manager: rank plus a category's amount would reveal the total.
        ...(canSeeBudget(role, "total") ? { rank: rankOf(event.priorities, category.id) } : {}),
        // With nothing allocated, every tier "fits", so naming one would mislead.
        tierLabel: category.committedMinor > 0 ? (tier?.label ?? null) : null,
      };
    });
  const scope = { guestCount: state.guestCount, currency: state.currency, categories };
  return canSeeBudget(role, "total") ? { ...computed, ...scope } : scope;
}

const pendingOf = (store, eventId) =>
  [...store.pendingChanges.values()].filter((change) => change.eventId === eventId);

// Each affected group gets a notice worded from only the facts it may see.
async function postNotices({ store, event, template, before, after, deltas, nowIso }) {
  const guests = { before: before.guestCount, after: after.guestCount };
  const targets = noticeTargets({ deltas, categoryGroupMap: template.categoryGroupMap });
  const posted = await Promise.all(
    targets.map(async ({ slug, categoryIds }) => {
      const group = store.groups.get(`g-${event.id}-${slug}`);
      if (!group) return null;
      const facts = noticeFacts({
        guests,
        deltas,
        categoryIds,
        groupSlug: slug,
        template,
        currency: after.currency,
      });
      // The change is already applied, so a failed notice must not report the change as failed.
      try {
        const { wording, rationale } = await word({ facts, groupName: group.name });
        return postAgentMessage(store, {
          groupId: group.id,
          authorId: `agent-budget@${event.id}`,
          authorKind: "system",
          text: wording,
          rationale,
          nowIso,
        });
      } catch (err) {
        console.error(`Notice failed with ${err.name}`);
        return null;
      }
    }),
  );
  return posted.filter(Boolean);
}

/** Budget and consequences. Reads top to bottom: user, validate, permission, work, store. */
export function budgetRoutes({ ai }) {
  const router = Router();

  router.get("/events/:id/budget", requireUser, validate(schemas.eventParam), (req, res) => {
    const { store } = req.app.locals;
    const event = ownEvent(req);
    const state = requireBudget(store, event);
    res.json(budgetFor(event, state, store.roleOf(req.user)));
  });

  router.post(
    "/events/:id/changes",
    requireUser,
    ai,
    validate(schemas.proposeChange),
    async (req, res) => {
      const { store } = req.app.locals;
      const event = managerOnly(req);
      const state = requireBudget(store, event);
      const result = await interpretChange({
        profile: event,
        state,
        actor: store.roleOf(req.user),
        text: req.valid.body.text,
        template: getTemplate(event.eventType),
      });
      // Only a change that applies cleanly can be accepted later.
      const applies =
        result.changeEvents.length > 0 &&
        result.consequences?.rejected.length === 0 &&
        !result.clarifyingQuestion;
      let changeId = null;
      if (applies) {
        changeId = `c-${randomUUID().slice(0, 8)}`;
        store.pendingChanges.set(changeId, {
          id: changeId,
          eventId: event.id,
          events: result.changeEvents,
          baseState: state,
        });
        const own = pendingOf(store, event.id);
        if (own.length > MAX_PENDING_PER_EVENT) store.pendingChanges.delete(own[0].id);
      }
      const { consequences, consequenceText, estimates, explanation, clarifyingQuestion } = result;
      res.json({
        changeId,
        answer: result.answer,
        insight: result.insight,
        offline: result.offline,
        consequences,
        consequenceText,
        estimates,
        explanation,
        clarifyingQuestion,
        rationale: result.rationale,
      });
    },
  );

  router.post(
    "/events/:id/changes/:changeId/accept",
    requireUser,
    ai,
    validate(schemas.acceptChange),
    async (req, res) => {
      const { store } = req.app.locals;
      const event = managerOnly(req);
      const before = requireBudget(store, event);
      const pending = store.pendingChanges.get(req.valid.params.changeId);
      if (!pending || pending.eventId !== event.id)
        throw HttpError(404, "NOT_FOUND", "That change is no longer available.");
      if (pending.baseState !== before)
        throw HttpError(400, "BAD_REQUEST", "The budget has changed since. Please ask again.");

      // Re-applied here in code, so what is stored is never just what the model proposed.
      const first = computeConsequences(before, pending.events, event);
      const { events: extra } = resolutionEvents(first, req.valid.body);
      const allEvents = [...pending.events, ...extra];
      const { after, deltas, rejected } = computeConsequences(before, allEvents, event);
      if (rejected.length > 0)
        throw HttpError(400, "BAD_REQUEST", "That change can no longer be applied.");
      const nowIso = new Date().toISOString();
      store.budgets.set(event.id, after);
      // Any other proposal was worked out against the old budget, so it is stale now.
      for (const { id } of pendingOf(store, event.id)) store.pendingChanges.delete(id);
      if (after.guestCount !== before.guestCount) {
        const n = after.guestCount;
        event.guests = { min: n, max: n, suggested: n, confirmed: n };
      }
      event.budget = { ...event.budget, totalMinor: after.totalMinor };
      saveTasks(store, flagAtRisk(store.tasksForEvent(event.id), nowIso));

      const notices = await postNotices({
        store,
        event,
        template: getTemplate(event.eventType),
        before,
        after,
        deltas,
        nowIso,
      });
      res.json({
        budget: budgetFor(event, after, store.roleOf(req.user)),
        tasks: timelineView(store, event.id),
        noticesPosted: notices.length,
      });
    },
  );

  return router;
}
