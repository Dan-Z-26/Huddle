const sumBy = (items, key) => items.reduce((sum, item) => sum + item[key], 0);

const TOP_RANK_PCT = 160;
const LAST_RANK_PCT = 100;
const UNRANKED_PCT = 50;
const FALLBACK_TYPICAL_BPS = 1000;

/** The share of a new budget set aside for the unexpected. */
export const DEFAULT_BUFFER_BPS = 1000;

function rankPct(index, rankedCount) {
  if (index < 0) return UNRANKED_PCT;
  if (rankedCount === 1) return TOP_RANK_PCT;
  const step = ((TOP_RANK_PCT - LAST_RANK_PCT) * index) / (rankedCount - 1);
  return Math.round(TOP_RANK_PCT - step);
}

/**
 * Splits a total across categories: each starts from its usual share for this event type, raised
 * or lowered by where the user ranked it. Nothing unranked drops to zero. Sums exactly.
 * @param {number} totalMinor Non-negative integer total.
 * @param {Array<{id: string, typicalBps?: number}>} categories The event's categories.
 * @param {string[]} priorities Category ids, highest priority first.
 * @returns {Record<string, number>} Allocation per category.
 * @throws {RangeError} When the total is negative or not an integer.
 */
export function allocate(totalMinor, categories, priorities) {
  if (!Number.isSafeInteger(totalMinor) || totalMinor < 0) {
    throw new RangeError("totalMinor must be a non-negative integer");
  }
  const known = new Set(categories.map(({ id }) => id));
  const ranked = [...new Set(priorities)].filter((id) => known.has(id));
  const weightOf = ({ id, typicalBps }) =>
    (typicalBps ?? FALLBACK_TYPICAL_BPS) * rankPct(ranked.indexOf(id), ranked.length);
  const weightSum = categories.reduce((sum, category) => sum + weightOf(category), 0);
  if (weightSum === 0) return Object.fromEntries(categories.map(({ id }) => [id, 0]));
  // BigInt: a large budget times a weight goes past what a Number holds exactly.
  const shares = categories.map((category) => {
    const scaled = BigInt(totalMinor) * BigInt(weightOf(category));
    const sum = BigInt(weightSum);
    return { id: category.id, minor: Number(scaled / sum), remainder: Number(scaled % sum) };
  });
  const leftover = totalMinor - sumBy(shares, "minor");
  // A stable sort gives ties to the category listed first.
  shares
    .toSorted((a, b) => b.remainder - a.remainder)
    .slice(0, leftover)
    .forEach((share) => (share.minor += 1));
  return Object.fromEntries(shares.map((share) => [share.id, share.minor]));
}

/**
 * What the contingency buffer holds.
 * @param {{contingency?: {reservedMinor: number, spentMinor: number}}} state BudgetState.
 * @returns {{reservedMinor: number, spentMinor: number, availableMinor: number}} Set aside, already
 *   paid from it, and what is left.
 */
export function contingencyOf({ contingency }) {
  const reservedMinor = contingency?.reservedMinor ?? 0;
  const spentMinor = contingency?.spentMinor ?? 0;
  return { reservedMinor, spentMinor, availableMinor: reservedMinor - spentMinor };
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
 *   totalMinor: number, contingency: object, remainingMinor: number}} remainingMinor leaves out the
 *   buffer, and is negative when over budget.
 */
export function computeBudget(state) {
  const categories = state.categories.map((category) => ({
    id: category.id,
    name: category.name,
    ...categoryCost(category, state.guestCount),
  }));
  const committedMinor = sumBy(categories, "committedMinor");
  const contingency = contingencyOf(state);
  return {
    categories,
    committedMinor,
    lowMinor: sumBy(categories, "lowMinor"),
    highMinor: sumBy(categories, "highMinor"),
    totalMinor: state.totalMinor,
    contingency,
    remainingMinor: state.totalMinor - contingency.reservedMinor - committedMinor,
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
