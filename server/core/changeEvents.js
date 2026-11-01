import { contingencyOf, COVER_LABEL } from "./budgetEngine.js";
import {
  findDriver,
  isAmount,
  isCount,
  makeDriver,
  newDriverId,
  pricingProblem,
} from "./drivers.js";
import { MAX_GUESTS } from "./money.js";
import { quotePricesWithTax } from "./quoteScoring.js";

const ACCEPTABLE_QUOTE_STATUSES = ["confirmed", "accepted"];

const applied = (state) => ({ state });
const rejected = (reason) => ({ reason });
// Rejection reasons echo hostile values, so show a short string or just the type.
const show = (value) => (typeof value === "string" ? value.slice(0, 40) : typeof value);
const isLabel = (value) => typeof value === "string" && value.trim() !== "";
const findCategory = (state, id) => state.categories.find((category) => category.id === id);

function replaceDrivers(state, categoryId, drivers) {
  return {
    ...state,
    categories: state.categories.map((category) =>
      category.id === categoryId ? { ...category, drivers } : category,
    ),
  };
}

function applyGuestCount(state, event) {
  const guestCount = event.to ?? state.guestCount + event.delta;
  if (Number.isInteger(guestCount) && guestCount > MAX_GUESTS) {
    return rejected(`guest count can be at most ${MAX_GUESTS}`);
  }
  if (!isCount(guestCount) || guestCount < 1) {
    return rejected("guest count must be an integer of at least 1");
  }
  return applied({ ...state, guestCount });
}

function applyLineItemAdd(state, event) {
  const category = findCategory(state, event.category);
  if (!category) return rejected(`unknown category: ${show(event.category)}`);
  if (!isLabel(event.item?.label)) return rejected("item needs a label");
  const problem = pricingProblem(event.item);
  if (problem) return rejected(problem);
  const { id, label } = event.item;
  const isFreeId = isLabel(id) && !category.drivers.some((driver) => driver.id === id);
  const driver = makeDriver(isFreeId ? id : newDriverId(category, label), label, event.item);
  return applied(replaceDrivers(state, category.id, [...category.drivers, driver]));
}

function applyLineItemRemove(state, event) {
  const category = findCategory(state, event.category);
  if (!category) return rejected(`unknown category: ${show(event.category)}`);
  const driver = findDriver(category, event.itemId);
  if (!driver) return rejected(`unknown driver: ${show(event.itemId)}`);
  const drivers = category.drivers.filter((candidate) => candidate !== driver);
  return applied(replaceDrivers(state, category.id, drivers));
}

function swappedDriver(category, label, price) {
  const id = newDriverId(category, label);
  if (price) return makeDriver(id, label, price);
  const unknownPrice = {
    kind: "fixed",
    source: "estimate",
    estimate: { lowMinor: 0, highMinor: 0 },
  };
  return { ...makeDriver(id, label, unknownPrice), unpriced: true };
}

function applyLineItemSwap(state, event) {
  const category = findCategory(state, event.category);
  if (!category) return rejected(`unknown category: ${show(event.category)}`);
  const driver = findDriver(category, event.remove);
  if (!driver) return rejected(`unknown driver: ${show(event.remove)}`);
  if (!isLabel(event.add)) return rejected("swap needs the new item's label");
  const problem = event.price ? pricingProblem(event.price) : null;
  if (problem) return rejected(problem);
  const replacement = swappedDriver(category, event.add, event.price);
  const drivers = category.drivers.map((item) => (item === driver ? replacement : item));
  return applied(replaceDrivers(state, category.id, drivers));
}

const coveredIn = (category) =>
  category.drivers
    .filter(({ label }) => label === COVER_LABEL)
    .reduce((sum, { unitMinor }) => sum + unitMinor, 0);

// What a cover moved out of the buffer goes back when the plan it was for no longer needs it.
function returnToBuffer(state, amountMinor) {
  if (amountMinor === 0) return state;
  const { reservedMinor, spentMinor } = contingencyOf(state);
  return { ...state, contingency: { reservedMinor: reservedMinor + amountMinor, spentMinor } };
}

// The new amount includes what the buffer covered, which stays its own line so it can go back.
function applyCategoryAmount(state, event) {
  const category = findCategory(state, event.category);
  if (!category) return rejected(`unknown category: ${show(event.category)}`);
  if (!isAmount(event.amountMinor)) return rejected("amountMinor must be a non-negative integer");
  const covered = coveredIn(category);
  const kept = Math.min(covered, event.amountMinor);
  const fixed = (id, label, unitMinor) =>
    makeDriver(id, label, { kind: "fixed", unitMinor, source: "user" });
  const drivers = [
    fixed(`${category.id}-amount`, `${category.name} amount`, event.amountMinor - kept),
    ...(kept > 0 ? [fixed(`${category.id}-covered`, COVER_LABEL, kept)] : []),
  ];
  return applied(returnToBuffer(replaceDrivers(state, category.id, drivers), covered - kept));
}

function quoteDrivers(quote) {
  const { perGuestMinor, fixedMinor } = quotePricesWithTax(quote);
  if (!isAmount(perGuestMinor) || !isAmount(fixedMinor)) return null;
  const pricing = (kind, unitMinor) => ({ kind, unitMinor, source: "quote" });
  const label = `${quote.vendorName} quote`;
  return [
    {
      ...makeDriver(
        `${quote.id}-per-guest`,
        `${label}, per guest`,
        pricing("perGuest", perGuestMinor),
      ),
      ...(isCount(quote.minGuests) ? { minGuests: quote.minGuests } : {}),
    },
    makeDriver(`${quote.id}-fixed`, `${label}, fixed`, pricing("fixed", fixedMinor)),
  ];
}

function nextQuoteStatus(candidate, accepted) {
  if (candidate.id === accepted.id) return "accepted";
  const isRival = candidate.categoryId === accepted.categoryId && candidate.status === "accepted";
  return isRival ? "confirmed" : candidate.status;
}

function applyQuoteAccepted(state, event) {
  const quote = (state.quotes ?? []).find((candidate) => candidate.id === event.quoteId);
  if (!quote) return rejected(`unknown quote: ${show(event.quoteId)}`);
  if (!ACCEPTABLE_QUOTE_STATUSES.includes(quote.status)) {
    return rejected(
      `quote must be confirmed before it is accepted, status is ${show(quote.status)}`,
    );
  }
  if (!findCategory(state, quote.categoryId)) {
    return rejected(`unknown category: ${show(quote.categoryId)}`);
  }
  const drivers = quoteDrivers(quote);
  if (!drivers) return rejected("quote prices must be non-negative integers");
  const quotes = state.quotes.map((q) => ({ ...q, status: nextQuoteStatus(q, quote) }));
  // A real price replaces the plan, so what the buffer covered for the old plan goes back.
  const covered = coveredIn(findCategory(state, quote.categoryId));
  return applied(
    returnToBuffer({ ...replaceDrivers(state, quote.categoryId, drivers), quotes }, covered),
  );
}

function applyBudgetTotal(state, event) {
  if (!isAmount(event.toMinor)) return rejected("toMinor must be a non-negative integer");
  return applied({ ...state, totalMinor: event.toMinor });
}

// Drawing on the buffer lowers what is set aside, which frees that money for the plan.
function applyContingencyDraw(state, event) {
  const { availableMinor, reservedMinor, spentMinor } = contingencyOf(state);
  if (!isAmount(event.amountMinor)) return rejected("amountMinor must be a non-negative integer");
  if (event.amountMinor > availableMinor) return rejected("the buffer doesn't hold that much");
  const contingency = { reservedMinor: reservedMinor - event.amountMinor, spentMinor };
  return applied({ ...state, contingency });
}

function applyContingencySet(state, event) {
  const { spentMinor } = contingencyOf(state);
  if (!isAmount(event.toMinor)) return rejected("toMinor must be a non-negative integer");
  if (event.toMinor < spentMinor) return rejected("that is less than the buffer has already paid");
  if (event.toMinor > state.totalMinor) return rejected("the buffer can't exceed the budget");
  return applied({ ...state, contingency: { reservedMinor: event.toMinor, spentMinor } });
}

const HANDLERS = new Map([
  ["guest_count", applyGuestCount],
  ["line_item_add", applyLineItemAdd],
  ["line_item_remove", applyLineItemRemove],
  ["line_item_swap", applyLineItemSwap],
  ["category_amount", applyCategoryAmount],
  ["quote_accepted", applyQuoteAccepted],
  ["budget_total", applyBudgetTotal],
  ["contingency_draw", applyContingencyDraw],
  ["contingency_set", applyContingencySet],
]);

/**
 * Applies validated change events in order to a budget state, without mutating the input.
 * @param {object} state BudgetState.
 * @param {object[]} events Change events; each is judged against the result of those before it.
 * @returns {{state: object, rejected: Array<{event: object, reason: string}>}} New state and
 *   the events that could not be applied.
 */
export function applyChangeEvents(state, events) {
  const rejections = [];
  let current = structuredClone(state);
  for (const event of events) {
    const handler = HANDLERS.get(event?.type);
    const result = handler
      ? handler(current, event)
      : rejected(`unknown event type: ${show(event?.type)}`);
    if (result.state) current = result.state;
    else rejections.push({ event, reason: result.reason });
  }
  return { state: current, rejected: rejections };
}
