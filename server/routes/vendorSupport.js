import { computeBudget } from "../core/budgetEngine.js";
import { quoteWarnings, scoreReasons } from "../core/hiring.js";
import { wholeMoney } from "../core/money.js";
import { normaliseQuote, scoreQuotes } from "../core/quoteScoring.js";
import { canView } from "../core/permissions.js";
import { categoryName, getTemplate, groupsForCategory } from "../core/templates.js";
import { HttpError } from "../http.js";

/** Who may work on a category's vendors: the manager, and core members who own the category. */
export function mayWorkOn(role, categoryId) {
  return role.kind === "manager" || (role.kind === "core" && role.categoryIds.includes(categoryId));
}

export function requireCategory(req, template, categoryId) {
  if (!template.categories.some(({ id }) => id === categoryId))
    throw HttpError(400, "BAD_REQUEST", "Unknown category.");
  const role = req.app.locals.store.roleOf(req.user);
  if (!canView(role, { type: "quotes" }) || !mayWorkOn(role, categoryId))
    throw HttpError(403, "FORBIDDEN", "You don't work on this category.");
}

const vendorRoomSlug = (categoryId) => `vendor-${categoryId}`;

/**
 * The room that works on a category: its booked vendor's room if it has one, then the room the
 * template names, then Core team if the manager has removed that.
 * @returns {object | undefined} The group.
 */
export const categoryGroup = (store, event, template, categoryId) => {
  const slug = groupsForCategory(template.categoryGroupMap, categoryId)[0];
  return (
    store.groups.get(`g-${event.id}-${vendorRoomSlug(categoryId)}`) ??
    store.groups.get(`g-${event.id}-${slug}`) ??
    store.groups.get(`g-${event.id}-core-team`)
  );
};

/**
 * The room a booked vendor joins. Core team talks budgets and rival quotes, so a category with no
 * room of its own gets one, holding the manager and the category's owners.
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
    id: `g-${event.id}-${slug}`,
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

export const eventQuotes = (store, eventId) =>
  [...store.quotes.values()].filter((quote) => quote.eventId === eventId);

export function quoteView(quote, guestCount) {
  const { totalMinor, missing } = normaliseQuote(quote, guestCount);
  return { ...quote, totalMinor, missing };
}

export function findQuote(req) {
  const { store } = req.app.locals;
  const quote = store.quotes.get(req.valid.params.id);
  if (!quote || quote.eventId !== req.user.eventId)
    throw HttpError(404, "NOT_FOUND", "No such quote.");
  const event = store.events.get(quote.eventId);
  requireCategory(req, getTemplate(event.eventType), quote.categoryId);
  return { quote, event };
}

/** The quote's comparison fields, read in code from what a person typed or confirmed. */
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
