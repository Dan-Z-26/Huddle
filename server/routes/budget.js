import { randomUUID } from "node:crypto";
import { Router } from "express";
import { interpretChange } from "../agents/budget.js";
import { noticeFacts, noticeTargets, word } from "../agents/notices.js";
import { computeBudget, tierForCost } from "../core/budgetEngine.js";
import { computeConsequences, resolutionEvents } from "../core/consequences.js";
import { canSeeBudget } from "../core/permissions.js";
import { rankOf } from "../core/priorities.js";
import { getTemplate, groupsForCategory } from "../core/templates.js";
import { flagAtRisk } from "../core/timelinePlanner.js";
import { HttpError, managerOnly, ownEvent, requireBudget, requireUser, validate } from "../http.js";
import { eventExpenses, postAgentMessage } from "../store/workspace.js";
import * as schemas from "../validation/schemas.js";
import { bookVendor, vendorsOf } from "./hiringSupport.js";
import { saveTasks, timelineView } from "./timeline.js";
import { directiveView, groupPeople } from "./views.js";

const MAX_PENDING_PER_EVENT = 100;

/** The budget as a user may see it: core members get only the categories they own, and no totals. */
function budgetFor(event, state, role) {
  const computed = computeBudget(state);
  const categories = computed.categories
    .filter(({ id }) => canSeeBudget(role, { categoryId: id }))
    .map((category) => {
      const { tiers, locked, typicalBps } = state.categories.find(({ id }) => id === category.id);
      const tier = tierForCost(tiers, category.committedMinor);
      return {
        ...category,
        locked,
        // Only the manager: rank plus a category's amount would reveal the total.
        ...(canSeeBudget(role, "total")
          ? { rank: rankOf(event.priorities, category.id), typicalBps }
          : {}),
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
  // A category whose group was removed is told to Core team instead, so nobody is left out.
  const merged = new Map();
  for (const { slug, categoryIds } of noticeTargets({
    deltas,
    categoryGroupMap: template.categoryGroupMap,
  })) {
    const to = store.groups.has(`g-${event.id}-${slug}`) ? slug : "core-team";
    merged.set(to, [...new Set([...(merged.get(to) ?? []), ...categoryIds])]);
  }
  // A booked vendor hears about a new guest count even if their own price didn't move.
  if (guests.before !== guests.after)
    for (const { categoryIds } of vendorsOf(store, event.id)) {
      const [slug] = groupsForCategory(template.categoryGroupMap, categoryIds[0]);
      merged.set(slug, [...new Set([...(merged.get(slug) ?? []), categoryIds[0]])]);
    }
  const targets = [...merged].map(([slug, categoryIds]) => ({ slug, categoryIds }));
  const posted = await Promise.all(
    targets.map(async ({ slug, categoryIds }) => {
      const group = store.groups.get(`g-${event.id}-${slug}`);
      if (!group) return null;
      const vendors = groupPeople(store, group).filter(({ kind }) => kind === "vendor");
      const facts = noticeFacts({
        guests,
        deltas,
        categoryIds,
        groupSlug: slug,
        template,
        currency: after.currency,
        hideCosts: vendors.length > 0,
        memberRoleIds: group.memberRoleIds,
      });
      if (facts.length === 0) return null;
      // The change is already applied, so a failed notice must not report the change as failed.
      try {
        const { wording, rationale } = await word({ facts, groupName: group.name });
        const message = postAgentMessage(store, {
          groupId: group.id,
          authorId: `agent-budget@${event.id}`,
          authorKind: "system",
          text: wording,
          rationale,
          nowIso,
        });
        // Someone booked by this very change has nothing to catch up on.
        const existing = vendors.filter(({ joinedAt }) => joinedAt !== nowIso);
        if (existing.length) askVendorsToAcknowledge(store, event, message, existing, nowIso);
        return message;
      } catch (err) {
        console.error(`Notice failed with ${err.name}`);
        return null;
      }
    }),
  );
  return posted.filter(Boolean);
}

// A booked vendor has to confirm they saw a change, the same way the team confirms a directive.
function askVendorsToAcknowledge(store, event, message, vendors, nowIso) {
  const directive = {
    id: `d-${randomUUID().slice(0, 8)}`,
    messageId: message.id,
    groupId: message.groupId,
    addressedUserIds: vendors.map(({ id }) => id),
    acks: [],
    createdAt: nowIso,
    remindedAt: null,
    taskId: null,
  };
  store.directives.set(directive.id, directive);
  store.publish({
    type: "directive.updated",
    eventId: event.id,
    groupId: message.groupId,
    directive: { ...directiveView(store, directive), text: message.text },
  });
  store.publish({ type: "attention.updated", eventId: event.id });
}

/**
 * Keeps a proposed change until the manager applies it. At most MAX_PENDING_PER_EVENT wait at once.
 * @param {object} store The store.
 * @param {{id: string}} event The event.
 * @param {object} state The budget the change was worked out against.
 * @param {object[]} events The change events.
 * @param {{quoteId: string, perGuestMinor: number, fixedMinor: number, taxBps: number} | null}
 *   [quoteGuard] For accepting a quote: the prices the manager was shown. If the quote is edited
 *   afterwards, applying is refused, so the manager only ever accepts what they reviewed.
 * @returns {string} The change id.
 */
export function storePending(store, event, state, events, quoteGuard = null) {
  const changeId = `c-${randomUUID().slice(0, 8)}`;
  store.pendingChanges.set(changeId, {
    id: changeId,
    eventId: event.id,
    events,
    baseState: state,
    quoteGuard,
  });
  const own = pendingOf(store, event.id);
  if (own.length > MAX_PENDING_PER_EVENT) store.pendingChanges.delete(own[0].id);
  return changeId;
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
        expenses: eventExpenses(store, event.id),
      });
      // Only a change that applies cleanly can be accepted later.
      const applies =
        result.changeEvents.length > 0 &&
        result.consequences?.rejected.length === 0 &&
        !result.clarifyingQuestion;
      const changeId = applies ? storePending(store, event, state, result.changeEvents) : null;
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
      const guard = pending.quoteGuard;
      const quoteNow = guard && store.quotes.get(guard.quoteId);
      if (
        guard &&
        (!quoteNow ||
          ["perGuestMinor", "fixedMinor", "taxBps"].some((key) => quoteNow[key] !== guard[key]))
      )
        throw HttpError(400, "BAD_REQUEST", "The quote changed since. Please ask again.");
      if (pending.baseState !== before)
        throw HttpError(400, "BAD_REQUEST", "The budget has changed since. Please ask again.");

      // Re-applied here in code, so what is stored is never just what the model proposed.
      // Quotes live beside the budget; a quote_accepted event needs them to be applied.
      const quotes = [...store.quotes.values()].filter(({ eventId }) => eventId === event.id);
      const working = { ...before, quotes };
      const first = computeConsequences(working, pending.events, event);
      const { events: extra } = resolutionEvents(first, req.valid.body);
      const allEvents = [...pending.events, ...extra];
      const { after: applied, deltas, rejected } = computeConsequences(working, allEvents, event);
      if (rejected.length > 0)
        throw HttpError(400, "BAD_REQUEST", "That change can no longer be applied.");
      const nowIso = new Date().toISOString();
      // Accepting a quote changes the status of quotes; they are kept beside the budget, not in it.
      for (const quote of applied.quotes ?? [])
        store.quotes.set(quote.id, { ...store.quotes.get(quote.id), status: quote.status });
      const after = { ...applied, quotes: [] };
      store.budgets.set(event.id, after);
      // Any other proposal was worked out against the old budget, so it is stale now.
      for (const { id } of pendingOf(store, event.id)) store.pendingChanges.delete(id);
      if (after.guestCount !== before.guestCount) {
        const n = after.guestCount;
        event.guests = { min: n, max: n, suggested: n, confirmed: n };
      }
      event.budget = { ...event.budget, totalMinor: after.totalMinor };
      saveTasks(store, flagAtRisk(store.tasksForEvent(event.id), nowIso));
      const template = getTemplate(event.eventType);
      for (const { type, quoteId } of allEvents)
        if (type === "quote_accepted")
          bookVendor({ store, event, template, quote: store.quotes.get(quoteId), nowIso });

      const notices = await postNotices({
        store,
        event,
        template,
        before,
        after,
        deltas,
        nowIso,
      });
      store.publish({ type: "budget.updated", eventId: event.id });
      store.publish({ type: "timeline.updated", eventId: event.id });
      res.json({
        budget: budgetFor(event, after, store.roleOf(req.user)),
        tasks: timelineView(store, event.id),
        noticesPosted: notices.length,
      });
    },
  );

  return router;
}
