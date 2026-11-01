import { Router } from "express";
import { interpretChange } from "../agents/budget.js";
import { computeBudget, tierForCost } from "../core/budgetEngine.js";
import { computeConsequences, resolutionEvents } from "../core/consequences.js";
import { canSeeBudget } from "../core/permissions.js";
import { rankOf } from "../core/priorities.js";
import { getTemplate } from "../core/templates.js";
import { flagAtRisk } from "../core/timelinePlanner.js";
import { HttpError, managerOnly, ownEvent, requireBudget, requireUser, validate } from "../http.js";
import { eventExpenses } from "../store/workspace.js";
import * as schemas from "../validation/schemas.js";
import { postNotices } from "./budgetNotices.js";
import { bookVendor } from "./hiringSupport.js";
import { saveTasks, timelineView } from "./timeline.js";
import { eventQuotes } from "./vendorSupport.js";
import { newId } from "../store/ids.js";

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
  const changeId = newId("c");
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

// A quote guard holds the prices the manager saw; a quote edited since then can't be accepted.
function refuseStaleChange(store, pending, before) {
  const guard = pending.quoteGuard;
  const quoteNow = guard && store.quotes.get(guard.quoteId);
  const edited =
    guard &&
    (!quoteNow ||
      ["perGuestMinor", "fixedMinor", "taxBps"].some((key) => quoteNow[key] !== guard[key]));
  if (edited) throw HttpError(400, "BAD_REQUEST", "The quote changed since. Please ask again.");
  if (pending.baseState !== before)
    throw HttpError(400, "BAD_REQUEST", "The budget has changed since. Please ask again.");
}

// Re-applied here in code, so what is stored is never just what the model proposed. Quotes live
// beside the budget; a quote_accepted event needs them to be applied.
function workOutAccepted(store, event, before, pending, choice) {
  const working = { ...before, quotes: eventQuotes(store, event.id) };
  const first = computeConsequences(working, pending.events, event);
  const { events: extra } = resolutionEvents(first, choice);
  const allEvents = [...pending.events, ...extra];
  const { after: applied, deltas, rejected } = computeConsequences(working, allEvents, event);
  if (rejected.length > 0)
    throw HttpError(400, "BAD_REQUEST", "That change can no longer be applied.");
  return { applied, deltas, allEvents };
}

// Stores the result and everything that follows from it: quote statuses, the guest count, stale
// proposals, tasks now at risk, and the vendor any accepted quote books.
function saveAccepted({ store, event, template, before, applied, allEvents, nowIso }) {
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
  for (const { type, quoteId } of allEvents)
    if (type === "quote_accepted")
      bookVendor({ store, event, template, quote: store.quotes.get(quoteId), nowIso });
  return after;
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
      refuseStaleChange(store, pending, before);
      const { applied, deltas, allEvents } = workOutAccepted(
        store,
        event,
        before,
        pending,
        req.valid.body,
      );
      const nowIso = new Date().toISOString();
      const template = getTemplate(event.eventType);
      const after = saveAccepted({ store, event, template, before, applied, allEvents, nowIso });
      const notices = await postNotices({ store, event, template, before, after, deltas, nowIso });
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
