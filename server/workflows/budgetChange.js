/** Proposed budget changes: keeping one until the manager decides, then applying it in code. */
import { describeChange } from "../agents/budget.js";
import { computeConsequences, resolutionEvents } from "../core/consequences.js";
import { getTemplate } from "../core/templates.js";
import { flagAtRisk } from "../core/timelinePlanner.js";
import { badRequest } from "../http.js";
import { newId } from "../store/ids.js";
import { bookVendor } from "./booking.js";
import { postNotices } from "./budgetNotices.js";
import { saveTasks } from "./timeline.js";
import { eventQuotes } from "./vendors.js";

const MAX_PENDING_PER_EVENT = 100;

const pendingOf = (store, eventId) =>
  [...store.pendingChanges.values()].filter((change) => change.eventId === eventId);

/**
 * Keeps a proposed change until the manager applies it. At most MAX_PENDING_PER_EVENT wait at once.
 * @param {object} store The store.
 * @param {{event: {id: string}, state: object, events: object[], quoteGuard?: object | null}} change
 *   The event, the budget the change was worked out against, and the change events. `quoteGuard`
 *   holds the prices the manager was shown when accepting a quote: if the quote is edited
 *   afterwards, applying is refused, so the manager only ever accepts what they reviewed.
 * @returns {string} The change id.
 */
export function storePending(store, { event, state, events, quoteGuard = null }) {
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

/**
 * Works out what a change made in code would do, and keeps it if it can be applied.
 * @param {object} store The store.
 * @param {{event: object, state: object, events: object[], text: string, seenState?: object,
 *   quoteGuard?: object}} change What is proposed, in words and as events. `seenState` is the budget
 *   to work it out against when that needs more than `state` holds.
 * @returns {Promise<object>} The response for the page: the change id, if any, and its consequences.
 */
export async function proposeInCode(store, { event, state, events, text, seenState, quoteGuard }) {
  const described = await describeChange({
    profile: event,
    state: seenState ?? state,
    events,
    template: getTemplate(event.eventType),
    text,
  });
  const applies = described.consequences.rejected.length === 0;
  const changeId = applies ? storePending(store, { event, state, events, quoteGuard }) : null;
  return { changeId, answer: "", estimates: [], rationale: "", ...described };
}

// A quote guard holds the prices the manager saw; a quote edited since then can't be accepted.
function refuseStaleChange(store, pending, before) {
  const guard = pending.quoteGuard;
  const quoteNow = guard && store.quotes.get(guard.quoteId);
  const edited =
    guard &&
    (!quoteNow ||
      ["perGuestMinor", "fixedMinor", "taxBps"].some((key) => quoteNow[key] !== guard[key]));
  if (edited) throw badRequest("The quote changed since. Please ask again.");
  if (pending.baseState !== before)
    throw badRequest("The budget has changed since. Please ask again.");
}

// Re-applied here in code, so what is stored is never just what the model proposed. Quotes live
// beside the budget; a quote_accepted event needs them to be applied.
function workOutAccepted(store, { event, before, pending, choice }) {
  const working = { ...before, quotes: eventQuotes(store, event.id) };
  const first = computeConsequences(working, pending.events, event);
  const { events: extra } = resolutionEvents(first, choice);
  const allEvents = [...pending.events, ...extra];
  const { after: applied, deltas, rejected } = computeConsequences(working, allEvents, event);
  if (rejected.length > 0) throw badRequest("That change can no longer be applied.");
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
    const count = after.guestCount;
    event.guests = { min: count, max: count, suggested: count, confirmed: count };
  }
  event.budget = { ...event.budget, totalMinor: after.totalMinor };
  saveTasks(store, flagAtRisk(store.tasksForEvent(event.id), nowIso));
  for (const { type, quoteId } of allEvents)
    if (type === "quote_accepted")
      bookVendor({ store, event, template, quote: store.quotes.get(quoteId), nowIso });
  return after;
}

/**
 * Applies a change the manager has reviewed, with how they chose to close any gap, and tells the
 * groups it affects.
 * @param {object} store The store.
 * @param {{event: object, before: object, pending: object, choice: object}} change The event, its
 *   budget now, the kept proposal, and the manager's choice.
 * @returns {Promise<{after: object, noticesPosted: number}>} The new budget, and the notices sent.
 * @throws {Error} 400 when the proposal has gone stale or can no longer be applied.
 */
export async function applyChange(store, { event, before, pending, choice }) {
  refuseStaleChange(store, pending, before);
  const { applied, deltas, allEvents } = workOutAccepted(store, { event, before, pending, choice });
  const nowIso = new Date().toISOString();
  const template = getTemplate(event.eventType);
  const after = saveAccepted({ store, event, template, before, applied, allEvents, nowIso });
  const notices = await postNotices({ store, event, template, before, after, deltas, nowIso });
  store.nudge(event.id, "budget.updated", "timeline.updated");
  return { after, noticesPosted: notices.length };
}
