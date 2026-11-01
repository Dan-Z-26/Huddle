/**
 * Works out what the chosen cuts would do, so the chart can preview them. No drawing happens here,
 * and the server recalculates when the change is applied.
 */

/**
 * What a category costs before any cut.
 * @param {{atHigh?: object, atLow?: object}} option An option from the server.
 * @returns {number} The cost in minor units.
 */
export const optionCost = ({ atHigh, atLow }) => {
  const cut = atHigh ?? atLow;
  return cut.newTotalMinor + cut.cutMinor;
};

/**
 * Works out what each choice takes, by the server's own rule: the buffer goes first, then cuts in
 * the order chosen, each only as far as the gap still needs.
 * @param {object[]} options The options from the server.
 * @param {number} gapMinor The gap to close.
 * @param {string[]} chosen The categories chosen, in order.
 * @param {number} [bufferMinor] What the buffer can give.
 * @returns {{taken: Map<string, number>, left: number, drawn: number}} What each gives, what is left
 *   open, and what came from the buffer.
 */
export function planOf(options, gapMinor, chosen, bufferMinor = 0) {
  const taken = new Map();
  const drawn = Math.min(gapMinor, bufferMinor);
  let left = gapMinor - drawn;
  for (const id of chosen) {
    const option = options.find(({ categoryId }) => categoryId === id);
    const amount = Math.min(left, optionCost(option));
    taken.set(id, amount);
    left -= amount;
  }
  return { taken, left, drawn };
}

/**
 * The budget as it would look if this choice were applied.
 * @param {{consequences: {budgetAfter: object}}} result The proposed change.
 * @param {object} current The budget on screen.
 * @param {{taken: Map<string, number>, left: number, drawn?: number}} plan From `planOf`.
 * @param {boolean} raise Whether the total goes up to cover what is left.
 * @returns {object} A budget the chart can draw.
 */
export function previewOf(result, current, plan, raise) {
  const after = result.consequences.budgetAfter;
  const ranks = new Map(current.categories.map((item) => [item.id, item]));
  const categories = after.categories.map((category) => {
    const take = plan.taken.get(category.id) ?? 0;
    const committedMinor = category.committedMinor - take;
    return {
      ...category,
      committedMinor,
      lowMinor: category.lowMinor - take,
      highMinor: category.highMinor - take,
      rank: ranks.get(category.id)?.rank,
      tierLabel: take ? null : ranks.get(category.id)?.tierLabel,
    };
  });
  const totalMinor = after.totalMinor + (raise ? plan.left : 0);
  const committedMinor = categories.reduce((sum, item) => sum + item.committedMinor, 0);
  const drawn = plan.drawn ?? 0;
  const contingency = {
    ...after.contingency,
    reservedMinor: after.contingency.reservedMinor - drawn,
    availableMinor: after.contingency.availableMinor - drawn,
  };
  return {
    ...after,
    categories,
    totalMinor,
    committedMinor,
    contingency,
    remainingMinor: totalMinor - contingency.reservedMinor - committedMinor,
    currency: current.currency,
  };
}
