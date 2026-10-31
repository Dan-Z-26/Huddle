import { parseEventDate } from "../core/dateText.js";

const plain = (text) => text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
const CONSTRAINT_HINTS = [
  ["dietary", /veg|vegan|jain|halal|kosher|allerg|gluten|nut|diet/],
  ["accessibility", /wheelchair|access|ramp|hearing|sign language|mobility/],
  ["brand", /brand|logo|colou?r|guideline|font/],
  ["venue", /venue|capacity|noise|curfew|power|parking|permit/],
];

/** Category ids in the order the answer first mentions them (by id or name words). */
export function categoriesMentioned(answer, template) {
  const text = plain(answer);
  return template.categories
    .map(({ id, name }) => {
      const words = [...id.split("-"), ...plain(name).split(/[^a-z0-9]+/)].filter(
        (w) => w.length > 1,
      );
      const hits = words
        .map((word) => text.search(new RegExp(`\\b${word}`)))
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
    .slice(0, 10)
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
    .map((p) => p.trim())
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

// Details the user volunteered while answering something else, so the agent can skip those questions.
function volunteered(field, answer) {
  const extra = {};
  if (field !== "date" && parseEventDate(answer)) extra.date = answer;
  if (field !== "budget" && /₹|\brs\.?\s*\d|\binr\b|lakh|crore/i.test(answer))
    extra.budgetText = answer;
  const guests = answer.match(/\b\d[\d,]*\s*(?:guests?|people|pax|attendees)\b/i);
  if (guests) extra.guestText = guests[0];
  return extra;
}

/**
 * Offline stand-in for the Discovery model: reads the answer to the current question with plain
 * patterns. Used when no API key is set, and as the safe fallback when a model call fails.
 * @param {{field: string, answer: string, profile: object, template: object}} input The question
 *   being answered, the reply, and the context.
 * @returns {object} An object shaped like the extraction schema.
 */
export function demoExtract({ field, answer, profile, template }) {
  const text = answer.trim();
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
