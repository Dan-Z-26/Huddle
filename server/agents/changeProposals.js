import { parseAmount } from "../core/amount.js";

export const MIN_CONFIDENCE = 0.7;
const PAISE_PER_RUPEE = 100;

const toEstimate = ({ lowRupees, highRupees }) => ({
  lowMinor: lowRupees * PAISE_PER_RUPEE,
  highMinor: highRupees * PAISE_PER_RUPEE,
});

// Returns a core pricing object, null when the proposal names no price, or a string reason.
function pricingOf(proposal) {
  const kind = proposal.priceKind ?? "fixed";
  const units = kind === "perUnit" ? { units: proposal.units ?? 1 } : {};
  if (proposal.estimate) {
    return { kind, source: "estimate", estimate: toEstimate(proposal.estimate), ...units };
  }
  if (!proposal.priceText) return null;
  const amount = parseAmount(proposal.priceText);
  if (!amount) return "I couldn't read that price";
  return { kind, source: "user", unitMinor: amount.minor, ...units };
}

function guestCountEvent({ delta, to, confidence }) {
  const given = [delta, to].filter((value) => value !== undefined);
  if (given.length !== 1) return "I need either how many guests to add or the new total";
  return { type: "guest_count", ...(to !== undefined ? { to } : { delta }), confidence };
}

function amountEvent(proposal, build) {
  const amount = parseAmount(proposal.amountText);
  return amount ? build(amount.minor) : "I couldn't read that amount";
}

function lineItemEvent(proposal) {
  const pricing = pricingOf(proposal);
  if (typeof pricing === "string") return pricing;
  const { type, category, confidence } = proposal;
  if (type === "line_item_swap") {
    const swap = { type, category, remove: proposal.remove, add: proposal.add, confidence };
    return pricing ? { ...swap, price: pricing } : swap;
  }
  if (!pricing) return "I need a price (or an estimate) for the new item";
  return { type, category, item: { label: proposal.label, ...pricing }, confidence };
}

function convert(proposal) {
  switch (proposal.type) {
    case "guest_count":
      return guestCountEvent(proposal);
    case "budget_total":
      return amountEvent(proposal, (toMinor) => ({
        type: "budget_total",
        toMinor,
        confidence: proposal.confidence,
      }));
    case "category_amount":
      return amountEvent(proposal, (amountMinor) => ({
        type: "category_amount",
        category: proposal.category,
        amountMinor,
        confidence: proposal.confidence,
      }));
    case "line_item_add":
    case "line_item_swap":
      return lineItemEvent(proposal);
    default:
      return { ...proposal };
  }
}

/**
 * Turns the Budget model's proposals into validated core change events. All money is parsed from
 * text here, in code. Anything unsure, unreadable or about an unknown category becomes a question
 * for the user instead of an event.
 * @param {object[]} proposals Proposals that passed the changeProposal schema.
 * @param {{categoryIds: string[]}} context Categories that exist on this event.
 * @returns {{events: object[], questions: Array<{proposal: object, reason: string}>}} Events ready
 *   for the core engine, and what to ask the user.
 */
export function toChangeEvents(proposals, { categoryIds }) {
  const events = [];
  const questions = [];
  for (const proposal of proposals) {
    const ask = (reason) => questions.push({ proposal, reason });
    if (proposal.confidence < MIN_CONFIDENCE) {
      ask("I'm not sure I understood this change");
    } else if (proposal.category !== undefined && !categoryIds.includes(proposal.category)) {
      ask(`I don't know the category "${proposal.category.slice(0, 40)}"`);
    } else {
      const converted = convert(proposal);
      if (typeof converted === "string") ask(converted);
      else events.push(converted);
    }
  }
  return { events, questions };
}
