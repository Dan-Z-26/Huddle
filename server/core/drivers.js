import { MAX_GUESTS, MAX_MINOR } from "./money.js";

const DRIVER_KINDS = ["perGuest", "fixed", "perUnit", "stepped"];
const PRICE_SOURCES = ["quote", "user", "estimate"];

export const isAmount = (value) => Number.isSafeInteger(value) && value >= 0 && value <= MAX_MINOR;
export const isCount = (value) => Number.isSafeInteger(value) && value >= 0 && value <= MAX_GUESTS;

/**
 * Finds a driver by id or by its label in any case.
 * @param {{drivers: object[]}} category The category.
 * @param {*} idOrLabel What was asked for.
 * @returns {object | undefined} The driver.
 */
export function findDriver(category, idOrLabel) {
  if (typeof idOrLabel !== "string") return undefined;
  const wanted = idOrLabel.toLowerCase();
  return category.drivers.find(
    (driver) => driver.id === idOrLabel || driver.label.toLowerCase() === wanted,
  );
}

/**
 * Makes an id from a label that no driver in this category has yet.
 * @param {{drivers: object[]}} category The category.
 * @param {string} label The new driver's label.
 * @returns {string} The id.
 */
export function newDriverId(category, label) {
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

/**
 * Says what is wrong with a driver's pricing.
 * @param {*} pricing Pricing from a change event, not yet trusted.
 * @returns {string | null} The reason, or null when it is valid.
 */
export function pricingProblem(pricing) {
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

/**
 * Builds a cost driver, copying only the fields pricingProblem validated for this kind and source.
 * @param {string} id The driver's id.
 * @param {string} label What it is called.
 * @param {object} pricing Pricing that pricingProblem accepted.
 * @returns {object} The driver.
 */
export function makeDriver(id, label, pricing) {
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
