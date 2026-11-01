import { categoryCost, computeBudget, tierForCost } from "./budgetEngine.js";
import { applyChangeEvents } from "./changeEvents.js";
import { divFloor } from "./money.js";
import { normalisePriorities, rankOf } from "./priorities.js";

const roundedPct = (part, whole) => divFloor(part * 200 + whole, whole * 2);

function committedDeltas(before, after) {
  return after.categories.flatMap((category) => {
    const beforeMinor = before.categories.find(({ id }) => id === category.id)?.committedMinor ?? 0;
    return beforeMinor === category.committedMinor
      ? []
      : [{ categoryId: category.id, beforeMinor, afterMinor: category.committedMinor }];
  });
}

function isBelowTier(tiers, minTierId, tier) {
  const required = tiers.find(({ id }) => id === minTierId);
  return Boolean(required) && (!tier || tier.minMinor < required.minMinor);
}

function mustHaveConflicts(category, mustHaves, tierAfter, removedEntirely) {
  return mustHaves
    .filter(
      (mustHave) =>
        mustHave.categoryId === category.id &&
        (removedEntirely || isBelowTier(category.tiers, mustHave.minTierId, tierAfter)),
    )
    .map((mustHave) => mustHave.id);
}

function cutOption(category, costMinor, shortfallMinor, mustHaves) {
  if (shortfallMinor === 0 || costMinor === 0) return null;
  const cutMinor = Math.min(shortfallMinor, costMinor);
  const newTotalMinor = costMinor - cutMinor;
  const removedEntirely = newTotalMinor === 0;
  const tierAfter = tierForCost(category.tiers, newTotalMinor);
  return {
    cutMinor,
    newTotalMinor,
    pctDrop: roundedPct(cutMinor, costMinor),
    tierBefore: tierForCost(category.tiers, costMinor),
    tierAfter,
    removedEntirely,
    coversShortfall: costMinor >= shortfallMinor,
    mustHaveConflicts: mustHaveConflicts(category, mustHaves, tierAfter, removedEntirely),
  };
}

function inPriorityOrder(categories, priorities) {
  const ranked = priorities.map((id) => categories.find((category) => category.id === id));
  return [...ranked, ...categories.filter(({ id }) => !priorities.includes(id))];
}

function cutOptions(state, shortfall, profile) {
  const ids = state.categories.map(({ id }) => id);
  const priorities = normalisePriorities(profile?.priorities, ids);
  const mustHaves = profile?.mustHaves ?? [];
  return inPriorityOrder(state.categories, priorities).flatMap((category) => {
    if (category.locked) return [];
    const cost = categoryCost(category, state.guestCount);
    const atLow = cutOption(category, cost.lowMinor, shortfall.lowMinor, mustHaves);
    const atHigh = cutOption(category, cost.highMinor, shortfall.highMinor, mustHaves);
    if (!atLow && !atHigh) return [];
    return [{ categoryId: category.id, rank: rankOf(priorities, category.id), atLow, atHigh }];
  });
}

/**
 * States what change events do to the budget: shortfall or surplus at both estimate ends, and
 * what covering it from each category or a budget increase would mean. It never recommends.
 * @param {object} state BudgetState before the change.
 * @param {object[]} events Change events.
 * @param {object} profile EventProfile, for priorities and must-haves.
 * @returns {{after: object, deltas: object[], rejected: object[],
 *   shortfall: {lowMinor: number, highMinor: number}, surplusMinor: number,
 *   bufferAvailableMinor: number, options: object[], increaseBudget: {lowMinor: number, highMinor: number} | null}} The neutral consequences.
 */
export function computeConsequences(state, events, profile) {
  const { state: after, rejected } = applyChangeEvents(state, events);
  const budget = computeBudget(after);
  // The buffer isn't there to plan with, so it only closes a gap if the manager chooses that.
  const spendable = budget.totalMinor - budget.contingency.reservedMinor;
  const shortfall = {
    lowMinor: Math.max(0, budget.lowMinor - spendable),
    highMinor: Math.max(0, budget.highMinor - spendable),
  };
  return {
    after,
    deltas: committedDeltas(computeBudget(state), budget),
    rejected,
    shortfall,
    surplusMinor: Math.max(0, spendable - budget.highMinor),
    // Resizing the buffer is what opened this gap, so the buffer can't be what closes it.
    bufferAvailableMinor: events.some(({ type }) => type === "contingency_set")
      ? 0
      : budget.contingency.availableMinor,
    options: cutOptions(after, shortfall, profile),
    increaseBudget: shortfall.highMinor === 0 ? null : { ...shortfall },
  };
}

function costOfCut(options, categoryId) {
  const cut = options.find((option) => option.categoryId === categoryId);
  const chosen = cut?.atHigh ?? cut?.atLow;
  return chosen ? chosen.newTotalMinor + chosen.cutMinor : null;
}

/**
 * Turns the manager's choice into the extra events that close the gap: the buffer goes first if
 * chosen, then the chosen categories are cut in the order given, each only as far as the gap still
 * needs, and `raise` covers what is left.
 * @param {{shortfall: {highMinor: number}, options: object[], after: {totalMinor: number},
 *   bufferAvailableMinor?: number}} result Result of computeConsequences.
 * @param {{cuts?: string[], raise?: boolean, useBuffer?: boolean}} choice Categories to cut, and
 *   whether to raise the budget or draw on the buffer.
 * @returns {{events: object[], remainingMinor: number}} Events to add, and the gap still open.
 */
export function resolutionEvents(
  { shortfall, options, after, bufferAvailableMinor = 0 },
  { cuts = [], raise = false, useBuffer = false } = {},
) {
  const events = [];
  let remainingMinor = shortfall.highMinor;
  if (useBuffer) {
    const drawn = Math.min(remainingMinor, bufferAvailableMinor);
    if (drawn > 0) events.push({ type: "contingency_draw", amountMinor: drawn });
    remainingMinor -= drawn;
  }
  for (const categoryId of new Set(cuts)) {
    const costMinor = costOfCut(options, categoryId);
    if (costMinor === null || remainingMinor === 0) continue;
    const takenMinor = Math.min(remainingMinor, costMinor);
    events.push({
      type: "category_amount",
      category: categoryId,
      amountMinor: costMinor - takenMinor,
    });
    remainingMinor -= takenMinor;
  }
  if (raise && remainingMinor > 0) {
    events.push({ type: "budget_total", toMinor: after.totalMinor + remainingMinor });
    remainingMinor = 0;
  }
  return { events, remainingMinor };
}
