import { computeBudget, contingencyOf, COVER_LABEL } from "./budgetEngine.js";

const NEAR_PLAN_PCT = 80;
const LOW_BUFFER_PCT = 25;

// What earlier covers added to a category's plan. They are its own line items, so they survive a
// guest change and can be given back.
const coverItems = (category) =>
  (category?.drivers ?? []).filter(({ label }) => label === COVER_LABEL);
const coveredIn = (category) =>
  coverItems(category).reduce((sum, { unitMinor }) => sum + unitMinor, 0);

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
 *   leftMinor: number, overMinor: number, coveredMinor: number}>, spentMinor: number,
 *   leftMinor: number, totalMinor: number, coveredMinor: number, contingency: object}} Per category
 *   and for the whole event. coveredMinor is the part of a plan that came from the buffer.
 */
export function expenseSummary(state, expenses) {
  const budget = computeBudget(state);
  const categories = budget.categories.map(({ id, name, committedMinor }, index) => {
    const spentMinor = spentOn(expenses, id);
    return {
      id,
      name,
      plannedMinor: committedMinor,
      spentMinor,
      leftMinor: Math.max(0, committedMinor - spentMinor),
      overMinor: Math.max(0, spentMinor - committedMinor),
      coveredMinor: coveredIn(state.categories[index]),
    };
  });
  const spentMinor = expenses.reduce((sum, { amountMinor }) => sum + amountMinor, 0);
  return {
    categories,
    spentMinor,
    leftMinor: budget.totalMinor - spentMinor,
    totalMinor: budget.totalMinor,
    coveredMinor: categories.reduce((sum, { coveredMinor }) => sum + coveredMinor, 0),
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
          label: COVER_LABEL,
          kind: "fixed",
          unitMinor: coveredMinor,
          source: "user",
        },
      },
    ],
  };
}

/**
 * The events that return money to the buffer once a category needs less of it, such as after an
 * expense is removed. Only what the category no longer needs goes back.
 * @param {object} state BudgetState.
 * @param {object[]} expenses The event's expenses, without any that were removed.
 * @param {string} categoryId The category.
 * @returns {{events: object[], returnedMinor: number}} No events when nothing goes back.
 */
export function uncoverEvents(state, expenses, categoryId) {
  const category = state.categories.find(({ id }) => id === categoryId);
  const row = expenseSummary(state, expenses).categories.find(({ id }) => id === categoryId);
  const coveredMinor = coveredIn(category);
  if (!row || coveredMinor === 0) return { events: [], returnedMinor: 0 };
  const neededMinor = Math.min(
    coveredMinor,
    Math.max(0, row.spentMinor - (row.plannedMinor - coveredMinor)),
  );
  const returnedMinor = coveredMinor - neededMinor;
  if (returnedMinor === 0) return { events: [], returnedMinor };
  const { reservedMinor } = contingencyOf(state);
  return {
    returnedMinor,
    events: [
      ...coverItems(category).map(({ id }) => ({
        type: "line_item_remove",
        category: categoryId,
        itemId: id,
      })),
      ...(neededMinor > 0
        ? [
            {
              type: "line_item_add",
              category: categoryId,
              item: { label: COVER_LABEL, kind: "fixed", unitMinor: neededMinor, source: "user" },
            },
          ]
        : []),
      { type: "contingency_set", toMinor: reservedMinor + returnedMinor },
    ],
  };
}

function planStatus({ plannedMinor, spentMinor }) {
  if (spentMinor > plannedMinor) return "over";
  return spentMinor > 0 && spentMinor * 100 >= plannedMinor * NEAR_PLAN_PCT ? "near" : "ok";
}

const SEVERITY = { ok: 0, near: 1, over: 2 };

/**
 * Which categories just crossed a line in their plan, so the team is told once and not on every
 * expense after that.
 * @param {{categories: object[]}} before The summary before a change.
 * @param {{categories: object[]}} after The summary after it.
 * @returns {Array<{categoryId: string, name: string, status: "near" | "over"}>} What got worse.
 */
export function expenseAlerts(before, after) {
  const was = new Map(before.categories.map((row) => [row.id, planStatus(row)]));
  return after.categories
    .map((row) => ({ categoryId: row.id, name: row.name, status: planStatus(row) }))
    .filter(({ categoryId, status }) => SEVERITY[status] > SEVERITY[was.get(categoryId) ?? "ok"]);
}

/**
 * What in the spending wants someone's attention right now: categories near or over their plan,
 * worst first, and whether the buffer is running low.
 * @param {{categories: object[], contingency?: object, coveredMinor?: number}} summary From
 *   `expenseSummary`, already filtered to what this person may see.
 * @returns {{categories: Array<{categoryId: string, name: string, status: string, overMinor: number,
 *   leftMinor: number}>, bufferLeftMinor: number | null}} bufferLeftMinor is null unless the buffer
 *   is low and this person may see it.
 */
export function spendingWatch({ categories, contingency, coveredMinor = 0 }) {
  const watched = categories
    .map((row) => ({ row, status: planStatus(row) }))
    .filter(({ status }) => status !== "ok")
    .toSorted((a, b) => SEVERITY[b.status] - SEVERITY[a.status])
    .map(({ row: { id, name, overMinor, leftMinor }, status }) => ({
      categoryId: id,
      name,
      status,
      overMinor,
      leftMinor,
    }));
  const startMinor = (contingency?.reservedMinor ?? 0) + coveredMinor;
  const low =
    contingency && startMinor > 0 && contingency.availableMinor * 100 < startMinor * LOW_BUFFER_PCT;
  return { categories: watched, bufferLeftMinor: low ? contingency.availableMinor : null };
}
