import { parseAmount } from "../core/amount.js";
import { parseEventDate } from "../core/dateText.js";
import { parseGuestCount } from "../core/guestCount.js";
import { MAX_GUESTS } from "../core/money.js";
import { normalisePriorities } from "../core/priorities.js";
import { isGrounded } from "./grounded.js";

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

// What one answer is doing to the profile: the copy being changed, and what was taken or refused.
function take(change, key, value, acceptedAs = key) {
  change.next[key] = value;
  change.accepted.add(acceptedAs);
}

const refuse = (change, field, reason) => change.rejected.push({ field, reason });
const inAnswer = (change, text) => isGrounded(text, change.answer);

function readText(change, extracted) {
  for (const [key, max] of TEXT_FIELDS) {
    const text = clean(extracted[key], max);
    if (text) take(change, key, text);
  }
}

function readDate(change, { date }) {
  if (!date || (change.answering !== "date" && change.next.date)) return;
  const iso = inAnswer(change, date) ? parseEventDate(date) : null;
  if (!iso) refuse(change, "date", "I need the full date, including the year");
  else if (iso.slice(0, 10) < change.nowIso.slice(0, 10))
    refuse(change, "date", "that date has already passed");
  else take(change, "date", iso);
}

function readBudget(change, { budgetText }) {
  const { next } = change;
  if (!budgetText || (change.answering !== "budget" && next.budget.totalMinor)) return;
  const amount = inAnswer(change, budgetText) ? parseAmount(budgetText) : null;
  if (!amount) refuse(change, "budget", "I couldn't read that budget");
  else
    take(change, "budget", {
      totalMinor: amount.minor,
      currency: amount.currency ?? next.budget.currency,
    });
}

function readGuests(change, { guestText }) {
  if (!guestText || !inAnswer(change, guestText) || change.next.guests.confirmed !== null) return;
  const { profile, understood } = resolveGuests(change.next, guestText);
  if (understood) take(change, "guests", profile.guests);
}

function readPriorities(change, { priorities }) {
  if (!priorities) return;
  const categoryIds = change.template.categories.map(({ id }) => id);
  const ranking = normalisePriorities(priorities, categoryIds);
  if (ranking.length === 0) refuse(change, "priorities", "I didn't recognise those categories");
  else take(change, "priorities", ranking);
}

function readMustHaves(change, { mustHaves, absoluteMustHave }) {
  if (mustHaves?.length) {
    addMustHaves(change.next, mustHaves, change.template);
    change.accepted.add("mustHaves");
  }
  if (!absoluteMustHave) return;
  const wanted = absoluteMustHave.toLowerCase();
  const match = change.next.mustHaves.find(
    ({ text }) => text.toLowerCase().includes(wanted) || wanted.includes(text.toLowerCase()),
  );
  if (match) take(change, "absoluteMustHaveId", match.id, "absoluteMustHave");
  else refuse(change, "absoluteMustHave", "that isn't one of your must-haves");
}

function readConstraints(change, { constraints }) {
  const known = change.next.constraints;
  for (const key of CONSTRAINT_KEYS) {
    const merged = mergeUnique(known[key], constraints?.[key]);
    if (merged.length !== known[key].length) {
      known[key] = merged;
      change.accepted.add("constraints");
    }
  }
}

function readVendorNeeds(change, { vendorNeeds }) {
  for (const [categoryId, need] of Object.entries(vendorNeeds ?? {})) {
    const text = clean(need, 300);
    if (change.template.categories.some(({ id }) => id === categoryId) && text) {
      change.next.vendorNeeds[categoryId] = text;
      change.accepted.add("vendorNeeds");
    }
  }
}

// In this order: a must-have named as the absolute one can arrive in the same answer.
const READERS = [
  readText,
  readDate,
  readBudget,
  readGuests,
  readPriorities,
  readMustHaves,
  readConstraints,
  readVendorNeeds,
];

/**
 * Validates what the Discovery model extracted and merges the good parts into a copy of the
 * profile. Dates, money and guest counts are parsed here, and only when the model's copy is made of
 * figures found in the user's own answer, so a model never supplies a committed number.
 * @param {object} profile EventProfile.
 * @param {object} extracted Output of the extraction schema.
 * @param {{template: object, nowIso: string, answer: string, field: string}} context The event
 *   template, the current time, the user's reply and the field it answers. A date or budget that is
 *   already set changes only when that field is being answered, so an amount mentioned in passing
 *   can never replace the total.
 * @returns {{profile: object, accepted: string[], rejected: Array<{field: string, reason: string}>}}
 *   The updated copy, the fields that changed, and what was refused and why.
 */
export function applyExtracted(profile, extracted, { template, nowIso, answer, field }) {
  const change = {
    next: structuredClone(profile),
    accepted: new Set(),
    rejected: [],
    template,
    nowIso,
    answer,
    answering: field,
  };
  for (const read of READERS) read(change, extracted);
  return { profile: change.next, accepted: [...change.accepted], rejected: change.rejected };
}
