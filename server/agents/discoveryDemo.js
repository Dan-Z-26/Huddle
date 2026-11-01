/** Offline stand-ins for the Discovery model: read an answer with plain patterns. */
import { parseEventDate } from "../core/dateText.js";
import { categoryOfOption } from "./questions.js";

// Long enough for any profile field, short enough to keep the patterns fast.
const MAX_ANSWER = 500;
const MAX_MUST_HAVES = 10;

const plain = (text) => text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
const CONSTRAINT_HINTS = [
  ["dietary", /veg|vegan|jain|halal|kosher|allerg|gluten|nut|diet/],
  ["accessibility", /wheelchair|access|ramp|hearing|sign language|mobility/],
  ["brand", /brand|logo|colou?r|guideline|font/],
  ["venue", /venue|capacity|noise|curfew|power|parking|permit/],
];

/**
 * Category ids in the order the answer first mentions them (by id or name words).
 * @param {string} answer The words.
 * @param {{categories: object[]}} template The event template.
 * @returns {string[]} The ids.
 */
export function categoriesMentioned(answer, template) {
  const text = plain(answer);
  return template.categories
    .map(({ id, name }) => {
      const words = [...id.split("-"), ...plain(name).split(/[^a-z0-9]+/)].filter(
        (word) => word.length > 1,
      );
      const hits = words
        .map((word) => text.search(new RegExp(`\\b${word}s?\\b`)))
        .filter((at) => at >= 0);
      return { id, at: hits.length ? Math.min(...hits) : -1 };
    })
    .filter(({ at }) => at >= 0)
    .sort((a, b) => a.at - b.at)
    .map(({ id }) => id);
}

function mustHavesFrom(answer, template) {
  return answer
    .split(/[,;\n]|\band\b/i)
    .map((item) => item.trim())
    .filter((item) => item.length >= 3)
    .slice(0, MAX_MUST_HAVES)
    .map((text) => ({ text, categoryId: categoriesMentioned(text, template)[0] ?? null }));
}

function absoluteFrom(answer, profile) {
  const number = answer.match(/^\s*(\d+)/);
  if (number) return profile.mustHaves[Number(number[1]) - 1]?.text;
  const text = answer.toLowerCase();
  return profile.mustHaves.find((item) => text.includes(item.text.toLowerCase()))?.text;
}

function constraintsFrom(answer) {
  const lists = { deadlines: [], dietary: [], accessibility: [], brand: [], venue: [] };
  for (const part of answer
    .split(/[,;\n]/)
    .map((item) => item.trim())
    .filter(Boolean)) {
    const [key] = CONSTRAINT_HINTS.find(([, hint]) => hint.test(part.toLowerCase())) ?? [
      "deadlines",
    ];
    lists[key].push(part.slice(0, 120));
  }
  return lists;
}

function vendorNeedsFrom(answer, profile, template) {
  const mentioned = categoriesMentioned(answer, template);
  const targets = mentioned.length ? mentioned : profile.priorities.slice(0, 1);
  return Object.fromEntries(targets.map((id) => [id, answer.trim().slice(0, 300)]));
}

const MONEY =
  /(?:₹|\brs\.?\s*|\binr\s*)\s*\d[\d,.]*(?:\s*(?:lakhs?|lacs?|crores?|cr|k)\b)?|\b\d[\d,.]*\s*(?:lakhs?|lacs?|crores?|cr)\b/i;
const GUESTS =
  /(?:\b(?:around|about|roughly|maybe|approximately)\s+)?\b\d[\d,]*(?:\s*(?:-|–|to)\s*\d[\d,]*)?\s*(?:guests?|people|pax|attendees)\b/i;

// Details the user volunteered while answering something else, so the agent can skip those questions.
function volunteered(field, answer) {
  const extra = {};
  if (field !== "date" && parseEventDate(answer)) extra.date = answer;
  const money = field === "budget" ? null : answer.match(MONEY);
  if (money) extra.budgetText = money[0];
  const guests = answer.match(GUESTS);
  if (guests) extra.guestText = guests[0];
  return extra;
}

const NOT_A_CITY = /^(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i;
const NAMED = /\b(?:called|named)\s+["“']?(.{2,60}?)(?=["”']|\s+(?:in|on|at|for|with)\b|[.,]|$)/i;

// An opening description: whatever plain patterns can find, and the words themselves as the purpose.
function openingFrom(text) {
  const city = text.match(/\b(?:in|at)\s+(\p{Lu}\p{L}+)/u)?.[1];
  const name = text.match(NAMED)?.[1]?.trim();
  return {
    ...volunteered("opening", text),
    purpose: text,
    ...(city && !NOT_A_CITY.test(city) ? { city } : {}),
    ...(name ? { name } : {}),
  };
}

/**
 * Offline stand-in for the Discovery model: reads the answer to the current question with plain
 * patterns. Used when no API key is set, and as the safe fallback when a model call fails.
 * @param {{field: string, answer: string, profile: object, template: object}} input The question
 *   being answered, the reply, and the context.
 * @returns {object} An object shaped like the extraction schema.
 */
export function demoExtract({ field, answer, profile, template }) {
  const text = answer.trim().slice(0, MAX_ANSWER);
  if (field === "opening") return openingFrom(text);
  const byField = {
    date: { date: text },
    budget: { budgetText: text },
    priorities: { priorities: categoriesMentioned(text, template) },
    mustHaves: { mustHaves: mustHavesFrom(text, template) },
    absoluteMustHave: { absoluteMustHave: absoluteFrom(text, profile) },
    constraints: { constraints: constraintsFrom(text) },
    vendorNeeds: { vendorNeeds: vendorNeedsFrom(text, profile, template) },
  };
  const own = byField[field] ?? { [field]: text };
  return { ...volunteered(field, text), ...own };
}

const lines = (answer) =>
  answer
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

/**
 * Reads an answer the user tapped or picked rather than typed, so no model is needed. A list arrives
 * one item per line: a must-have like "Food and drinks" stays whole, and a ranking arrives as ids.
 * @param {{field: string, answer: string, profile: object, template: object}} input The question
 *   being answered, the answer, and the context.
 * @returns {object} An object shaped like the extraction schema.
 */
export function directExtract({ field, answer, profile, template }) {
  const text = answer.trim();
  const items = lines(text);
  const byField = {
    date: { date: text },
    budget: { budgetText: text },
    priorities: { priorities: items },
    mustHaves: {
      mustHaves: items.map((item) => ({
        text: item,
        categoryId:
          categoryOfOption(item, profile, template) ??
          categoriesMentioned(item, template)[0] ??
          null,
      })),
    },
    absoluteMustHave: { absoluteMustHave: text },
    constraints: { constraints: constraintsFrom(items.join("\n")) },
    vendorNeeds: { vendorNeeds: vendorNeedsFrom(text, profile, template) },
  };
  return byField[field] ?? { [field]: text };
}
