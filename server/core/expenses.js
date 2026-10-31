import { computeBudget, contingencyOf } from "./budgetEngine.js";

const spentOn = (expenses, categoryId) =>
  expenses
    .filter((expense) => expense.categoryId === categoryId && !expense.fromBuffer)
    .reduce((sum, { amountMinor }) => sum + amountMinor, 0);

/**
 * Compares what was spent with what was planned. Buffer expenses count against the buffer, not
 * against any category's plan.
 * @param {object} state BudgetState.
 * @param {object[]} expenses The event's expenses.
 * @returns {{categories: Array<{id: string, name: string, plannedMinor: number, spentMinor: number,
 *   leftMinor: number, overMinor: number}>, spentMinor: number, leftMinor: number,
 *   totalMinor: number, contingency: object}} Per category, and for the whole event.
 */
export function expenseSummary(state, expenses) {
  const budget = computeBudget(state);
  const categories = budget.categories.map(({ id, name, committedMinor }) => {
    const spentMinor = spentOn(expenses, id);
    return {
      id,
      name,
      plannedMinor: committedMinor,
      spentMinor,
      leftMinor: Math.max(0, committedMinor - spentMinor),
      overMinor: Math.max(0, spentMinor - committedMinor),
    };
  });
  const spentMinor = expenses.reduce((sum, { amountMinor }) => sum + amountMinor, 0);
  return {
    categories,
    spentMinor,
    leftMinor: budget.totalMinor - spentMinor,
    totalMinor: budget.totalMinor,
    contingency: budget.contingency,
  };
}

/**
 * The events that cover a category's overspend from the buffer: the buffer shrinks and the plan
 * grows by as much of the overspend as the buffer can pay, so the total stays the same.
 * @param {object} state BudgetState.
 * @param {object[]} expenses The event's expenses.
 * @param {string} categoryId The overspent category.
 * @returns {{events: object[], coveredMinor: number}} No events when there is nothing to cover.
 */
export function coverEvents(state, expenses, categoryId) {
  const category = expenseSummary(state, expenses).categories.find(({ id }) => id === categoryId);
  const coveredMinor = Math.min(category?.overMinor ?? 0, contingencyOf(state).availableMinor);
  if (coveredMinor === 0) return { events: [], coveredMinor };
  return {
    coveredMinor,
    events: [
      { type: "contingency_draw", amountMinor: coveredMinor },
      {
        type: "line_item_add",
        category: categoryId,
        item: {
          label: "Covered from the buffer",
          kind: "fixed",
          unitMinor: coveredMinor,
          source: "user",
        },
      },
    ],
  };
}
