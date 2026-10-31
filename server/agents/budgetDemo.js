import { categoriesMentioned } from "./discoveryDemo.js";

const CLARIFY =
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

/**
 * Offline stand-in for the Budget model: recognises a few plain-English change patterns (guest
 * count changes, a new budget total, swapping one item for another) and proposes them.
 * @param {{text: string, template: object}} input The user's request and the event template.
 * @returns {object} An object shaped like the budget output schema.
 */
export function demoBudget({ text, template }) {
  const found = swapProposal(text, template) ?? budgetProposal(text) ?? guestProposal(text);
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
