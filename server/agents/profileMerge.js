import { parseAmount } from "../core/amount.js";
import { parseEventDate } from "../core/dateText.js";
import { parseGuestCount } from "../core/guestCount.js";
import { MAX_GUESTS } from "../core/money.js";
import { normalisePriorities } from "../core/priorities.js";

const YES =
  /^\s*(?:y|yes|yeah|yep|ok|okay|sure|confirm(?:ed)?|go ahead|sounds good|that works|fine)\b/i;
const TEXT_FIELDS = [
  ["name", 120],
  ["purpose", 500],
  ["city", 80],
  ["venueType", 80],
  ["attendeeExperience", 500],
];
const CONSTRAINT_KEYS = ["deadlines", "dietary", "accessibility", "brand", "venue"];
const MAX_LIST = 10;

const clean = (value, max) => (typeof value === "string" ? value.trim().slice(0, max) : "");

function mergeUnique(existing, incoming = []) {
  const seen = new Set(existing.map((text) => text.toLowerCase()));
  const added = incoming
    .map((text) => clean(text, 120))
    .filter((text) => {
      const fresh = text && !seen.has(text.toLowerCase());
      if (fresh) seen.add(text.toLowerCase());
      return fresh;
    });
  return [...existing, ...added].slice(0, MAX_LIST);
}

function tierIdFor(template, categoryId, tierId) {
  const category = template.categories.find(({ id }) => id === categoryId);
  return category?.tiers.some(({ id }) => id === tierId) ? tierId : null;
}

function addMustHaves(next, items, template) {
  const known = new Set(next.mustHaves.map(({ text }) => text.toLowerCase()));
  for (const item of items) {
    const text = clean(item.text, 120);
    if (!text || known.has(text.toLowerCase()) || next.mustHaves.length >= MAX_LIST) continue;
    known.add(text.toLowerCase());
    const categoryId = template.categories.some(({ id }) => id === item.categoryId)
      ? item.categoryId
      : null;
    next.mustHaves.push({
      id: `mh-${next.mustHaves.length + 1}`,
      text,
      categoryId,
      minTierId: tierIdFor(template, categoryId, item.minTierId),
    });
  }
}

/**
 * Answers a guest-count question in code: captures a fuzzy range, or confirms the one planning
 * number. The plan never proceeds until `guests.confirmed` is set.
 * @param {object} profile EventProfile.
 * @param {string} answer The user's reply.
 * @returns {{profile: object, understood: boolean}} The updated copy, and whether the reply held a
 *   usable count or a yes.
 */
export function resolveGuests(profile, answer) {
  const next = structuredClone(profile);
  const waiting = next.guests.suggested > 0 && next.guests.confirmed === null;
  if (waiting && YES.test(answer)) {
    next.guests.confirmed = next.guests.suggested;
    return { profile: next, understood: true };
  }
  const parsed = parseGuestCount(answer);
  if (!parsed || parsed.max > MAX_GUESTS) return { profile: next, understood: false };
  const { min, max, suggested, needsConfirmation } = parsed;
  next.guests = { min, max, suggested, confirmed: needsConfirmation ? null : max };
  return { profile: next, understood: true };
}

/**
 * Validates what the Discovery model extracted and merges the good parts into a copy of the
 * profile. Dates, money and guest counts are parsed here from the user's own words, so a model
 * never supplies a committed number.
 * @param {object} profile EventProfile.
 * @param {object} extracted Output of the extraction schema.
 * @param {{template: object, nowIso: string}} context The event template and the current time.
 * @returns {{profile: object, accepted: string[], rejected: Array<{field: string, reason: string}>}}
 *   The updated copy, the fields that changed, and what was refused and why.
 */
export function applyExtracted(profile, extracted, { template, nowIso }) {
  const next = structuredClone(profile);
  const accepted = new Set();
  const rejected = [];
  const take = (field, value, key = field) => {
    next[field] = value;
    accepted.add(key);
  };
  const categoryIds = template.categories.map(({ id }) => id);

  for (const [field, max] of TEXT_FIELDS) {
    const text = clean(extracted[field], max);
    if (text) take(field, text);
  }
  if (extracted.date) {
    const iso = parseEventDate(extracted.date);
    if (!iso) rejected.push({ field: "date", reason: "I need the full date, including the year" });
    else if (iso.slice(0, 10) < nowIso.slice(0, 10))
      rejected.push({ field: "date", reason: "that date has already passed" });
    else take("date", iso);
  }
  if (extracted.budgetText) {
    const amount = parseAmount(extracted.budgetText);
    if (!amount) rejected.push({ field: "budget", reason: "I couldn't read that budget" });
    else {
      next.budget = { totalMinor: amount.minor, currency: amount.currency ?? next.budget.currency };
      accepted.add("budget");
    }
  }
  if (extracted.guestText && next.guests.confirmed === null) {
    const { profile: withGuests, understood } = resolveGuests(next, extracted.guestText);
    if (understood) take("guests", withGuests.guests);
  }
  if (extracted.priorities) {
    const ranking = normalisePriorities(extracted.priorities, categoryIds);
    if (ranking.length === 0)
      rejected.push({ field: "priorities", reason: "I didn't recognise those categories" });
    else take("priorities", ranking);
  }
  if (extracted.mustHaves?.length) {
    addMustHaves(next, extracted.mustHaves, template);
    accepted.add("mustHaves");
  }
  if (extracted.absoluteMustHave) {
    const wanted = extracted.absoluteMustHave.toLowerCase();
    const match = next.mustHaves.find(
      ({ text }) => text.toLowerCase().includes(wanted) || wanted.includes(text.toLowerCase()),
    );
    if (match) take("absoluteMustHaveId", match.id, "absoluteMustHave");
    else rejected.push({ field: "absoluteMustHave", reason: "that isn't one of your must-haves" });
  }
  for (const key of CONSTRAINT_KEYS) {
    const merged = mergeUnique(next.constraints[key], extracted.constraints?.[key]);
    if (merged.length !== next.constraints[key].length) {
      next.constraints[key] = merged;
      accepted.add("constraints");
    }
  }
  for (const [categoryId, need] of Object.entries(extracted.vendorNeeds ?? {})) {
    const text = clean(need, 300);
    if (categoryIds.includes(categoryId) && text) {
      next.vendorNeeds[categoryId] = text;
      accepted.add("vendorNeeds");
    }
  }
  return { profile: next, accepted: [...accepted], rejected };
}
