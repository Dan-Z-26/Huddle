/**
 * Vendor rules shared by routes and the Planner: who works on a category, which room it uses, and
 * what the comparison table shows.
 */
import { computeBudget } from "../core/budgetEngine.js";
import { quoteWarnings, scoreReasons } from "../core/hiring.js";
import { wholeMoney } from "../core/money.js";
import { canView } from "../core/permissions.js";
import { normaliseQuote, scoreQuotes } from "../core/quoteScoring.js";
import { categoryName, getTemplate, groupsForCategory } from "../core/templates.js";
import { badRequest, forbidden, ownRecord } from "../http.js";
import { CORE_TEAM, groupIdFor } from "../store/ids.js";

/**
 * Who may work on a category's vendors: the manager, and core members who own the category.
 * @param {{kind: string, categoryIds?: string[]}} role The person's role.
 * @param {string} categoryId The category.
 * @returns {boolean} Whether they may.
 */
export function mayWorkOn(role, categoryId) {
  return role.kind === "manager" || (role.kind === "core" && role.categoryIds.includes(categoryId));
}

/**
 * Refuses a request about a category that doesn't exist or that this person doesn't work on.
 * @param {import("express").Request} req The request.
 * @param {object} template The event type's template.
 * @param {string} categoryId The category.
 * @throws {Error} 400 for an unknown category, 403 for someone else's.
 */
export function requireCategory(req, template, categoryId) {
  if (!template.categories.some(({ id }) => id === categoryId))
    throw badRequest("Unknown category.");
  const role = req.app.locals.store.roleOf(req.user);
  if (!canView(role, { type: "quotes" }) || !mayWorkOn(role, categoryId))
    throw forbidden("You don't work on this category.");
}

const vendorRoomSlug = (categoryId) => `vendor-${categoryId}`;

/**
 * The room that works on a category: its booked vendor's room if it has one, then the room the
 * template names, then Core team if the manager has removed that.
 * @param {object} store The store.
 * @param {{id: string}} event The event.
 * @param {object} template The event type's template.
 * @param {string} categoryId The category.
 * @returns {object | undefined} The group.
 */
export function categoryGroup(store, event, template, categoryId) {
  const slug = groupsForCategory(template.categoryGroupMap, categoryId)[0];
  return (
    store.groups.get(groupIdFor(event.id, vendorRoomSlug(categoryId))) ??
    store.groups.get(groupIdFor(event.id, slug)) ??
    store.groups.get(groupIdFor(event.id, CORE_TEAM))
  );
}

/**
 * The room a booked vendor joins. Core team talks budgets and rival quotes, so a category with no
 * room of its own gets one, holding the manager and the category's owners.
 * @param {object} store The store.
 * @param {{id: string}} event The event.
 * @param {object} template The event type's template.
 * @param {string} categoryId The category.
 * @returns {object} The group.
 */
export function vendorRoomFor(store, event, template, categoryId) {
  const existing = categoryGroup(store, event, template, categoryId);
  if (existing?.kind === "category") return existing;
  const slug = vendorRoomSlug(categoryId);
  const owners = template.roles.filter(
    ({ kind, categoryIds }) => kind === "manager" || categoryIds?.includes(categoryId),
  );
  const agents = template.groups.find(({ kind }) => kind === "core")?.memberRoleIds ?? [];
  const room = {
    id: groupIdFor(event.id, slug),
    eventId: event.id,
    slug,
    name: categoryName(template, categoryId),
    kind: "category",
    memberRoleIds: [
      ...owners.map(({ id }) => id),
      ...agents.filter((id) => id.startsWith("agent-")),
    ],
    categoryIds: [categoryId],
  };
  store.groups.set(room.id, room);
  return room;
}

/**
 * All of an event's quotes.
 * @param {object} store The store.
 * @param {string} eventId The event.
 * @returns {object[]} The quotes.
 */
export const eventQuotes = (store, eventId) =>
  [...store.quotes.values()].filter((quote) => quote.eventId === eventId);

/**
 * A quote with its total at this guest count and what it leaves unanswered.
 * @param {object} quote The quote.
 * @param {number} guestCount The confirmed guest count.
 * @returns {object} The quote to show.
 */
export function quoteView(quote, guestCount) {
  const { totalMinor, missing } = normaliseQuote(quote, guestCount);
  return { ...quote, totalMinor, missing };
}

/**
 * The quote a request names, once it is known this person may work on its category.
 * @param {import("express").Request} req The request.
 * @returns {{quote: object, event: object}} The quote and its event.
 * @throws {Error} 404 for another event's quote, 403 for another person's category.
 */
export function findQuote(req) {
  const { store } = req.app.locals;
  const quote = ownRecord(req, store.quotes, "quote");
  const event = store.events.get(quote.eventId);
  requireCategory(req, getTemplate(event.eventType), quote.categoryId);
  return { quote, event };
}

/**
 * The quote's comparison fields, read in code from what a person typed or confirmed.
 * @param {object} body The validated request body.
 * @returns {object} Fields in the shape of the quote extraction schema.
 */
export function fromFields(body) {
  return {
    vendorName: body.vendorName,
    perGuestText: body.perGuestText,
    fixedText: body.fixedText,
    taxPercent: body.taxPercent,
    includes: Array.isArray(body.includes)
      ? body.includes
      : (body.includes ?? "")
          .split(",")
          .map((item) => item.trim())
          .filter(Boolean),
    exclusions: body.exclusions,
    minGuests: body.minGuests,
    validUntil: body.validUntil,
    mustHaveIdsMet: body.mustHaveIdsMet,
    answers: body.answers,
  };
}

/**
 * The comparison table for one category: one row per quote, best fit first, with why it scored as
 * it did and what to look out for.
 * @param {{store: object, event: object, state: object, categoryId: string,
 *   viewerIsManager: boolean}} input The event, its budget, the category, and who is looking.
 * @returns {object[]} The rows.
 */
export function comparisonRows({ store, event, state, categoryId, viewerIsManager }) {
  const quotes = eventQuotes(store, event.id);
  const scored = scoreQuotes(quotes, {
    guestCount: state.guestCount,
    // Only the manager's score reflects the ranking: rank plus amount would reveal the total.
    priorities: viewerIsManager ? event.priorities : [],
    mustHaves: event.mustHaves,
    categoryId,
    absoluteMustHaveId: event.absoluteMustHaveId,
  });
  const byId = new Map(quotes.map((quote) => [quote.id, quote]));
  const planMinor = computeBudget(state).categories.find(
    ({ id }) => id === categoryId,
  ).committedMinor;
  const money = (minor) => wholeMoney(minor, state.currency);
  const cheapest = Math.min(...scored.map(({ totalMinor }) => totalMinor));
  const mustHaveCount = event.mustHaves.filter((item) => item.categoryId === categoryId).length;
  return scored
    .map((row) => {
      const quote = byId.get(row.quoteId);
      const { status, includes, answers, mustHaveIdsMet, taxStated } = quote;
      return {
        ...row,
        status,
        includes,
        answers,
        mustHaveIdsMet,
        reasons: scoreReasons(row, { cheapestMinor: cheapest, mustHaveCount, taxStated }),
        warnings: quoteWarnings(quote, {
          guestCount: state.guestCount,
          totalMinor: row.totalMinor,
          planMinor,
          money,
        }),
      };
    })
    .sort((a, b) => b.score - a.score);
}
