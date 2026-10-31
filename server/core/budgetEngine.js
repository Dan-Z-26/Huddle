const sumBy = (items, key) => items.reduce((sum, item) => sum + item[key], 0);

/**
 * Splits a total across ranked categories, weighting rank r of n by n-r+1, summing exactly.
 * @param {number} totalMinor Non-negative integer total.
 * @param {string[]} priorities Category ids, highest priority first.
 * @returns {Record<string, number>} Allocation per category; empty when nothing is ranked.
 * @throws {RangeError} When the total is negative or not an integer.
 */
export function allocate(totalMinor, priorities) {
  if (!Number.isSafeInteger(totalMinor) || totalMinor < 0) {
    throw new RangeError("totalMinor must be a non-negative integer");
  }
  const ids = [...new Set(priorities)];
  const weightSum = (ids.length * (ids.length + 1)) / 2;
  const shares = ids.map((id, index) => {
    const scaled = totalMinor * (ids.length - index);
    const remainder = scaled % weightSum;
    return { id, minor: (scaled - remainder) / weightSum, remainder };
  });
  const leftover = totalMinor - sumBy(shares, "minor");
  // A stable sort gives ties to the higher-ranked category.
  const byRemainder = shares.toSorted((a, b) => b.remainder - a.remainder);
  byRemainder.slice(0, leftover).forEach((share) => (share.minor += 1));
  return Object.fromEntries(shares.map((share) => [share.id, share.minor]));
}

/**
 * Finds the step that prices a guest count: the first that holds it, else the last.
 * @param {Array<{upToGuests: number}>} steps Steps in ascending upToGuests order.
 * @param {number} guestCount Guest count.
 * @returns {object | undefined} The matching step, or undefined when there are no steps.
 */
export function stepFor(steps, guestCount) {
  return steps.find((step) => guestCount <= step.upToGuests) ?? steps.at(-1);
}

function pricedCost(driver, guests) {
  switch (driver.kind) {
    case "fixed":
      return driver.unitMinor;
    case "perGuest":
      return driver.unitMinor * guests;
    case "perUnit":
      return driver.unitMinor * driver.units;
    case "stepped":
      return stepFor(driver.steps ?? [], guests)?.amountMinor ?? 0;
    default:
      throw new RangeError(`unknown driver kind: ${driver.kind}`);
  }
}

function estimateMultiplier(driver, guests) {
  if (driver.kind === "perGuest") return guests;
  if (driver.kind === "perUnit") return driver.units;
  return 1;
}

/**
 * Prices one cost driver; estimates add nothing to committed, only to the low and high ends.
 * @param {object} driver Driver.
 * @param {number} guestCount Guest count; negative values count as 0.
 * @returns {{committedMinor: number, lowMinor: number, highMinor: number}} Cost at each end.
 */
export function driverCost(driver, guestCount) {
  const guests = Math.max(0, guestCount);
  if (driver.source === "estimate") {
    const multiplier = estimateMultiplier(driver, guests);
    return {
      committedMinor: 0,
      lowMinor: (driver.estimate?.lowMinor ?? 0) * multiplier,
      highMinor: (driver.estimate?.highMinor ?? 0) * multiplier,
    };
  }
  const cost = pricedCost(driver, guests);
  return { committedMinor: cost, lowMinor: cost, highMinor: cost };
}

/**
 * Prices a category by summing its drivers.
 * @param {object} category Category.
 * @param {number} guestCount Guest count.
 * @returns {{committedMinor: number, lowMinor: number, highMinor: number}} Cost at each end.
 */
export function categoryCost(category, guestCount) {
  const costs = category.drivers.map((driver) => driverCost(driver, guestCount));
  return {
    committedMinor: sumBy(costs, "committedMinor"),
    lowMinor: sumBy(costs, "lowMinor"),
    highMinor: sumBy(costs, "highMinor"),
  };
}

/**
 * Computes committed and estimate-inclusive totals for a budget state.
 * @param {object} state BudgetState.
 * @returns {{categories: object[], committedMinor: number, lowMinor: number, highMinor: number,
 *   totalMinor: number, remainingMinor: number}} remainingMinor is negative when over budget.
 */
export function computeBudget(state) {
  const categories = state.categories.map((category) => ({
    id: category.id,
    name: category.name,
    ...categoryCost(category, state.guestCount),
  }));
  const committedMinor = sumBy(categories, "committedMinor");
  return {
    categories,
    committedMinor,
    lowMinor: sumBy(categories, "lowMinor"),
    highMinor: sumBy(categories, "highMinor"),
    totalMinor: state.totalMinor,
    remainingMinor: state.totalMinor - committedMinor,
  };
}

/**
 * Finds the highest quote tier a cost still qualifies for.
 * @param {Array<{minMinor: number}>} tiers Tiers of a category, in any order.
 * @param {number} costMinor Category cost.
 * @returns {object | null} The tier, or null when none qualifies.
 */
export function tierForCost(tiers, costMinor) {
  return tiers.reduce(
    (best, tier) =>
      tier.minMinor <= costMinor && (!best || tier.minMinor >= best.minMinor) ? tier : best,
    null,
  );
}
