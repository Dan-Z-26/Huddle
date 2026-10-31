import { quotePricesWithTax } from "./quoteScoring.js";

const DRIVER_KINDS = ["perGuest", "fixed", "perUnit", "stepped"];
const PRICE_SOURCES = ["quote", "user", "estimate"];
const ACCEPTABLE_QUOTE_STATUSES = ["confirmed", "accepted"];

const applied = (state) => ({ state });
const rejected = (reason) => ({ reason });
// Rejection reasons echo hostile values, so show a short string or just the type.
const show = (value) => (typeof value === "string" ? value.slice(0, 40) : typeof value);
// Caps keep perGuest price x guests (and sums of a few drivers) inside Number.MAX_SAFE_INTEGER.
const MAX_MINOR = 5e10;
const MAX_GUESTS = 100000;
const isAmount = (value) => Number.isSafeInteger(value) && value >= 0 && value <= MAX_MINOR;
const isCount = (value) => Number.isSafeInteger(value) && value >= 0 && value <= MAX_GUESTS;
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

function findDriver(category, idOrLabel) {
  if (typeof idOrLabel !== "string") return undefined;
  const wanted = idOrLabel.toLowerCase();
  return category.drivers.find(
    (driver) => driver.id === idOrLabel || driver.label.toLowerCase() === wanted,
  );
}

function newDriverId(category, label) {
  const slug =
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "item";
  const taken = new Set(category.drivers.map((driver) => driver.id));
  let counter = 1;
  while (taken.has(`${slug}-${counter}`)) counter += 1;
  return `${slug}-${counter}`;
}

function areValidSteps(steps) {
  return (
    Array.isArray(steps) &&
    steps.length > 0 &&
    steps.every(
      (step, index) =>
        isCount(step?.upToGuests) &&
        step.upToGuests >= 1 &&
        isAmount(step.amountMinor) &&
        (index === 0 || step.upToGuests > steps[index - 1].upToGuests),
    )
  );
}

function pricingProblem(pricing) {
  if (!DRIVER_KINDS.includes(pricing?.kind)) return "unknown driver kind";
  if (!PRICE_SOURCES.includes(pricing.source)) return "unknown price source";
  if (pricing.kind === "perUnit" && !isCount(pricing.units)) {
    return "units must be a non-negative integer";
  }
  if (pricing.source === "estimate") {
    const { lowMinor, highMinor } = pricing.estimate ?? {};
    const isRange = isAmount(lowMinor) && isAmount(highMinor) && lowMinor <= highMinor;
    return isRange ? null : "estimate needs integer lowMinor <= highMinor";
  }
  if (pricing.kind === "stepped") {
    return areValidSteps(pricing.steps) ? null : "steps must ascend with integer amounts";
  }
  return isAmount(pricing.unitMinor) ? null : "unitMinor must be a non-negative integer";
}

// Copies only the fields pricingProblem validated for this kind and source.
function makeDriver(id, label, pricing) {
  const isEstimate = pricing.source === "estimate";
  const isStepped = pricing.kind === "stepped";
  return {
    id,
    label,
    kind: pricing.kind,
    unitMinor: isEstimate || isStepped ? 0 : pricing.unitMinor,
    units: pricing.kind === "perUnit" ? pricing.units : 0,
    steps: !isEstimate && isStepped ? structuredClone(pricing.steps) : [],
    source: pricing.source,
    estimate: isEstimate ? { ...pricing.estimate } : null,
    unpriced: false,
  };
}

function applyGuestCount(state, event) {
  const guestCount = event.to ?? state.guestCount + event.delta;
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

function applyCategoryAmount(state, event) {
  const category = findCategory(state, event.category);
  if (!category) return rejected(`unknown category: ${show(event.category)}`);
  if (!isAmount(event.amountMinor)) return rejected("amountMinor must be a non-negative integer");
  const driver = makeDriver(`${category.id}-amount`, `${category.name} amount`, {
    kind: "fixed",
    unitMinor: event.amountMinor,
    source: "user",
  });
  return applied(replaceDrivers(state, category.id, [driver]));
}

function quoteDrivers(quote) {
  const { perGuestMinor, fixedMinor } = quotePricesWithTax(quote);
  if (!isAmount(perGuestMinor) || !isAmount(fixedMinor)) return null;
  const pricing = (kind, unitMinor) => ({ kind, unitMinor, source: "quote" });
  const label = `${quote.vendorName} quote`;
  return [
    makeDriver(`${quote.id}-per-guest`, `${label}, per guest`, pricing("perGuest", perGuestMinor)),
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
  return applied({ ...replaceDrivers(state, quote.categoryId, drivers), quotes });
}

function applyBudgetTotal(state, event) {
  if (!isAmount(event.toMinor)) return rejected("toMinor must be a non-negative integer");
  return applied({ ...state, totalMinor: event.toMinor });
}

const HANDLERS = new Map([
  ["guest_count", applyGuestCount],
  ["line_item_add", applyLineItemAdd],
  ["line_item_remove", applyLineItemRemove],
  ["line_item_swap", applyLineItemSwap],
  ["category_amount", applyCategoryAmount],
  ["quote_accepted", applyQuoteAccepted],
  ["budget_total", applyBudgetTotal],
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
