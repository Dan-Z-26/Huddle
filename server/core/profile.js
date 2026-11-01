/** The EventProfile: what setup still has to ask, and the opening budget it leads to. */
import { allocate, categoryCost, DEFAULT_BUFFER_BPS, stepFor } from "./budgetEngine.js";
import { divFloor, shareOfBps } from "./money.js";
import { normalisePriorities } from "./priorities.js";

const hasText = (value) => typeof value === "string" && value.trim() !== "";
const hasItems = (value) => Array.isArray(value) && value.length > 0;

// "None" is a valid answer only for the fields marked skippable.
const FIELD_CHECKS = [
  ["name", (profile) => hasText(profile.name)],
  ["purpose", (profile) => hasText(profile.purpose)],
  ["date", (profile) => hasText(profile.date)],
  ["city", (profile) => hasText(profile.city)],
  ["venueType", (profile) => hasText(profile.venueType)],
  [
    "guests",
    (profile) => Number.isInteger(profile.guests?.confirmed) && profile.guests.confirmed >= 1,
  ],
  ["budget", (profile) => profile.budget?.totalMinor > 0],
  ["priorities", (profile) => hasItems(profile.priorities)],
  ["attendeeExperience", (profile) => hasText(profile.attendeeExperience)],
  ["mustHaves", (profile) => hasItems(profile.mustHaves), true],
  ["absoluteMustHave", (profile) => hasText(profile.absoluteMustHaveId), true],
  ["constraints", (profile) => Object.values(profile.constraints ?? {}).some(hasItems), true],
  ["vendorNeeds", (profile) => Object.keys(profile.vendorNeeds ?? {}).length > 0, true],
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
    typicalBps: category.typicalBps,
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
 * Builds the opening budget from a confirmed profile: the buffer is set aside, and the rest is split
 * by the event type's usual shares and the user's ranking.
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
  const reservedMinor = shareOfBps(totalMinor, DEFAULT_BUFFER_BPS);
  const allocation = allocate(
    totalMinor - reservedMinor,
    template.categories,
    normalisePriorities(profile.priorities, categoryIds),
  );
  return {
    guestCount: guests,
    totalMinor,
    currency: profile.budget.currency ?? "INR",
    contingency: { reservedMinor, spentMinor: 0 },
    categories: template.categories.map((category) =>
      resolveCategory(category, allocation[category.id] ?? 0, guests),
    ),
    quotes: [],
  };
}

/**
 * Creates the blank EventProfile that intake fills in.
 * @param {string} eventType corporate_launch, wedding, birthday or community.
 * @param {string} id Event id.
 * @returns {object} A profile where every field is still unanswered.
 */
export function emptyProfile(eventType, id) {
  return {
    id,
    eventType,
    name: "",
    purpose: "",
    date: "",
    city: "",
    venueType: "",
    guests: { min: 0, max: 0, suggested: 0, confirmed: null },
    budget: { totalMinor: 0, currency: "INR" },
    priorities: [],
    attendeeExperience: "",
    mustHaves: [],
    absoluteMustHaveId: null,
    constraints: { deadlines: [], dietary: [], accessibility: [], brand: [], venue: [] },
    vendorNeeds: {},
    skippedFields: [],
    intakeStatus: "in_progress",
  };
}
