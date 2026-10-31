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
 *   shortfall: {lowMinor: number, highMinor: number}, surplusMinor: number, options: object[],
 *   increaseBudget: {lowMinor: number, highMinor: number} | null}} The neutral consequences.
 */
export function computeConsequences(state, events, profile) {
  const { state: after, rejected } = applyChangeEvents(state, events);
  const budget = computeBudget(after);
  const shortfall = {
    lowMinor: Math.max(0, budget.lowMinor - budget.totalMinor),
    highMinor: Math.max(0, budget.highMinor - budget.totalMinor),
  };
  return {
    after,
    deltas: committedDeltas(computeBudget(state), budget),
    rejected,
    shortfall,
    surplusMinor: Math.max(0, budget.totalMinor - budget.highMinor),
    options: cutOptions(after, shortfall, profile),
    increaseBudget: shortfall.highMinor === 0 ? null : { ...shortfall },
  };
}
