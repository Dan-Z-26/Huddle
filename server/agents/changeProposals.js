import { parseAmount } from "../core/amount.js";
import { categoryCost } from "../core/budgetEngine.js";
import { wholeMoney } from "../core/money.js";

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

const costOf = (state, id) => {
  const category = state.categories.find((item) => item.id === id);
  return categoryCost(category, state.guestCount).committedMinor;
};

// "Move 1 lakh from décor to food": code reads the amount and works out both new category totals.
function shiftEvents({ from, to, amountText, confidence }, state) {
  const amount = parseAmount(amountText);
  if (!amount) return "I couldn't read that amount";
  const available = costOf(state, from);
  if (amount.minor > available)
    return `That category only has ${wholeMoney(available, state.currency)} to move`;
  return [
    { type: "category_amount", category: from, amountMinor: available - amount.minor, confidence },
    {
      type: "category_amount",
      category: to,
      amountMinor: costOf(state, to) + amount.minor,
      confidence,
    },
  ];
}

// "Reduce gifting by half" or "add 50,000 to décor": the change comes as a percent or an amount.
function adjustEvent({ category, direction, amountText, percent, confidence }, state) {
  const cost = costOf(state, category);
  const amount = amountText
    ? parseAmount(amountText)?.minor
    : percent && Math.round((cost * percent) / 100);
  if (!amount) return "I need to know how much to change it by";
  if (direction === "decrease" && amount > cost)
    return `That category only has ${wholeMoney(cost, state.currency)}`;
  const amountMinor = direction === "increase" ? cost + amount : cost - amount;
  return { type: "category_amount", category, amountMinor, confidence };
}

function convert(proposal, state) {
  switch (proposal.type) {
    case "category_shift":
      return shiftEvents(proposal, state);
    case "category_adjust":
      return adjustEvent(proposal, state);
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
 * @param {{categoryIds: string[], state?: object}} context Categories that exist on this event, and
 *   the budget, which moving or scaling a category's money is worked out from.
 * @returns {{events: object[], questions: Array<{proposal: object, reason: string}>}} Events ready
 *   for the core engine, and what to ask the user.
 */
export function toChangeEvents(proposals, { categoryIds, state }) {
  const events = [];
  const questions = [];
  for (const proposal of proposals) {
    const ask = (reason) => questions.push({ proposal, reason });
    if (proposal.confidence < MIN_CONFIDENCE) {
      ask("I'm not sure I understood this change");
    } else {
      const shift = proposal.type === "category_shift";
      const named = shift ? [proposal.from, proposal.to] : [proposal.category];
      const unknown = named.find((id) => id !== undefined && !categoryIds.includes(id));
      if (unknown !== undefined) ask(`I don't know the category "${unknown.slice(0, 40)}"`);
      else if (
        !state &&
        (proposal.type === "category_shift" || proposal.type === "category_adjust")
      )
        ask("I need the current budget to work that out");
      else {
        const converted = convert(proposal, state);
        if (typeof converted === "string") ask(converted);
        else events.push(...[converted].flat());
      }
    }
  }
  return { events, questions };
}
