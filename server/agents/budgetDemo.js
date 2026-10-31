import { categoriesMentioned } from "./discoveryDemo.js";

export const CLARIFY =
  "I couldn't tell what to change. Try something like 'add 50 guests', 'raise the budget to 18 lakh' or 'swap the DJ for a live band in music'.";
const HIGH_CONFIDENCE = 0.9;

function guestProposal(text) {
  const add = text.match(
    /\b(?:add|adding|plus|another)\s+(\d+)\s+(?:more\s+)?guests?|\b(\d+)\s+(?:more|extra|additional)\s+guests?/i,
  );
  if (add) return { type: "guest_count", delta: Number(add[1] ?? add[2]) };
  const drop = text.match(
    /\b(?:remove|cut|drop|lose|fewer)\s+(\d+)\s+guests?|\b(\d+)\s+(?:fewer|less)\s+guests?/i,
  );
  if (drop) return { type: "guest_count", delta: -Number(drop[1] ?? drop[2]) };
  const total = text.match(/\b(?:now|to|is|are|be)\s+(\d+)\s*(?:guests?|people|pax)?\b/i);
  return total && /guest|people|pax|attendee|we are|we're/i.test(text)
    ? { type: "guest_count", to: Number(total[1]) }
    : null;
}

function budgetProposal(text) {
  const match = text.match(/\bbudget\b.*?\b(?:to|is|at|of)\s+(.+)$/i);
  return match ? { type: "budget_total", amountText: match[1].trim() } : null;
}

function swapProposal(text, template) {
  const match = text.match(
    /\b(?:swap|replace|change)\s+(?:the\s+)?(.+?)\s+(?:for|with|to)\s+(?:a\s+|an\s+)?(.+?)(?:\s+in\s+.+?)?(?:\s+(?:for|at)\s+(.+))?$/i,
  );
  const category = categoriesMentioned(text, template)[0];
  if (!match || !category) return null;
  const price = match[3]?.trim();
  return {
    type: "line_item_swap",
    category,
    remove: match[1].trim(),
    add: match[2].trim(),
    ...(price && { priceText: price }),
  };
}

function shiftProposal(text, template) {
  const match = text.match(/\b(?:move|shift|transfer)\s+(.+?)\s+from\s+(.+?)\s+to\s+(.+)$/i);
  if (!match) return null;
  const from = categoriesMentioned(match[2], template)[0];
  const to = categoriesMentioned(match[3], template)[0];
  return from && to ? { type: "category_shift", from, to, amountText: match[1].trim() } : null;
}

function adjustProposal(text, template) {
  const match = text.match(
    /\b(reduce|cut|lower|decrease|increase|raise)\s+(.+?)\s+by\s+(half|\d+\s*%|.+)$/i,
  );
  const category = match && categoriesMentioned(match[2], template)[0];
  if (!category) return null;
  const direction = /increase|raise/i.test(match[1]) ? "increase" : "decrease";
  const by = match[3].trim();
  if (/^half$/i.test(by)) return { type: "category_adjust", category, direction, percent: 50 };
  const percent = by.match(/^(\d+)\s*%$/);
  if (percent) return { type: "category_adjust", category, direction, percent: Number(percent[1]) };
  return { type: "category_adjust", category, direction, amountText: by };
}

/**
 * Offline stand-in for the Budget model: recognises a few plain-English change patterns (guest
 * count changes, a new budget total, swapping one item for another) and proposes them.
 * @param {{text: string, template: object, facts?: string[]}} input The user's request, the event
 *   template, and the budget as facts, which answer a plain question.
 * @returns {object} An object shaped like the budget output schema.
 */
export function demoBudget({ text, template, facts = [] }) {
  const found =
    shiftProposal(text, template) ??
    adjustProposal(text, template) ??
    swapProposal(text, template) ??
    budgetProposal(text) ??
    guestProposal(text);
  if (
    !found &&
    /\?|^\s*(?:how|what|which|where|can|do|does|is|are|show)\b/i.test(text) &&
    facts.length
  )
    return {
      proposals: [],
      explanation: "",
      answer: `Here is where the budget stands.\n${facts.slice(0, 7).join("\n")}`,
      rationale: "I can only show the figures right now.",
    };
  if (!found)
    return {
      proposals: [],
      explanation: "",
      clarifyingQuestion: CLARIFY,
      rationale: "I wasn't sure what you meant.",
    };
  return {
    proposals: [{ ...found, confidence: HIGH_CONFIDENCE }],
    explanation: "Here is what that change does to your plan.",
    rationale: "I read your request with simple rules.",
  };
}
