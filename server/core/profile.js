import { allocate, categoryCost, stepFor } from "./budgetEngine.js";
import { divFloor, shareOfBps } from "./money.js";
import { normalisePriorities } from "./priorities.js";

const hasText = (value) => typeof value === "string" && value.trim() !== "";
const hasItems = (value) => Array.isArray(value) && value.length > 0;

// "None" is a valid answer only for the fields marked skippable.
const FIELD_CHECKS = [
  ["name", (p) => hasText(p.name)],
  ["purpose", (p) => hasText(p.purpose)],
  ["date", (p) => hasText(p.date)],
  ["city", (p) => hasText(p.city)],
  ["venueType", (p) => hasText(p.venueType)],
  ["guests", (p) => Number.isInteger(p.guests?.confirmed) && p.guests.confirmed >= 1],
  ["budget", (p) => p.budget?.totalMinor > 0],
  ["priorities", (p) => hasItems(p.priorities)],
  ["attendeeExperience", (p) => hasText(p.attendeeExperience)],
  ["mustHaves", (p) => hasItems(p.mustHaves), true],
  ["absoluteMustHave", (p) => hasText(p.absoluteMustHaveId), true],
  ["constraints", (p) => Object.values(p.constraints ?? {}).some(hasItems), true],
  ["vendorNeeds", (p) => Object.keys(p.vendorNeeds ?? {}).length > 0, true],
];

/**
 * Lists the intake fields still unanswered, in the order they should be asked.
 * @param {object} profile EventProfile.
 * @returns {string[]} Missing field names; an unconfirmed guest count is always included.
 */
export function missingProfileFields(profile) {
  const skipped = profile.skippedFields ?? [];
  return FIELD_CHECKS.filter(
    ([field, isAnswered, skippable]) =>
      !isAnswered(profile) && !(skippable && skipped.includes(field)),
  ).map(([field]) => field);
}

function resolveSteps(driver, part, guests) {
  const pricingStep = stepFor(driver.steps, guests);
  return driver.steps.map((step) => ({
    upToGuests: step.upToGuests,
    amountMinor: divFloor(part * step.shareBps, pricingStep.shareBps),
  }));
}

function unitPrice(driver, part, guests) {
  if (driver.kind === "fixed") return part;
  if (driver.kind === "perGuest") return divFloor(part, guests);
  if (driver.kind === "perUnit") return divFloor(part, driver.units);
  return 0;
}

function resolveDriver(driver, allocationMinor, guests) {
  const part = shareOfBps(allocationMinor, driver.shareBps);
  return {
    id: driver.id,
    label: driver.label,
    kind: driver.kind,
    unitMinor: unitPrice(driver, part, guests),
    units: driver.units ?? 0,
    steps: driver.kind === "stepped" ? resolveSteps(driver, part, guests) : [],
    source: "user",
    estimate: null,
    unpriced: false,
  };
}

function resolveCategory(category, allocationMinor, guests) {
  const resolved = {
    id: category.id,
    name: category.name,
    locked: false,
    tiers: category.tiers.map((tier) => ({
      id: tier.id,
      label: tier.label,
      minMinor: shareOfBps(allocationMinor, tier.minBps),
    })),
    drivers: category.drivers.map((driver) => resolveDriver(driver, allocationMinor, guests)),
  };
  const firstFixed = resolved.drivers.find((driver) => driver.kind === "fixed");
  if (firstFixed) {
    firstFixed.unitMinor += allocationMinor - categoryCost(resolved, guests).committedMinor;
  }
  return resolved;
}

/**
 * Builds the opening budget from a confirmed profile and its event template's shares.
 * @param {object} profile EventProfile with a confirmed guest count.
 * @param {object} template Result of getTemplate.
 * @returns {object} BudgetState with drivers of source "user" and no quotes.
 * @throws {Error} When the guest count is not a confirmed positive integer.
 */
export function buildBudgetState(profile, template) {
  const guests = profile.guests?.confirmed;
  if (!Number.isInteger(guests) || guests < 1) {
    throw new Error("buildBudgetState needs a confirmed guest count");
  }
  const totalMinor = profile.budget.totalMinor;
  const categoryIds = template.categories.map((category) => category.id);
  const allocation = allocate(totalMinor, normalisePriorities(profile.priorities, categoryIds));
  return {
    guestCount: guests,
    totalMinor,
    currency: profile.budget.currency ?? "INR",
    categories: template.categories.map((category) =>
      resolveCategory(category, allocation[category.id] ?? 0, guests),
    ),
    quotes: [],
  };
}
