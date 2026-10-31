// Works out what the chosen cuts would do, to preview them. The server recalculates on apply.

export const optionCost = ({ atHigh, atLow }) => {
  const cut = atHigh ?? atLow;
  return cut.newTotalMinor + cut.cutMinor;
};

// Same rule as the server: the buffer goes first, then cuts in the order chosen, each only as far
// as the gap still needs.
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
