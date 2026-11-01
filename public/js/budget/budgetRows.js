/** The rows on the Budget page: one per category, and one per expense. */
import { api } from "../shared/api.js";
import { $, announce, announceError, clear, el, formatShortDate } from "../shared/dom.js";
import { bar, percentOf } from "./budgetStats.js";

function whyLine(category, totalMinor) {
  const { rank, typicalBps, committedMinor } = category;
  if (totalMinor === undefined || !typicalBps) return "";
  const priority = rank ? `Priority ${rank}. ` : "Not ranked. ";
  return `${priority}Usually about ${Math.round(typicalBps / 100)}%, here ${percentOf(committedMinor, totalMinor)}%.`;
}

// When the buffer can't clear it: the lowest priority category with enough left, for the manager to
// try in Ask Huddle. Nothing moves until they apply it there.
function donorFor(row, categories, budget) {
  const rankOf = (id) => budget.categories.find((item) => item.id === id)?.rank ?? Infinity;
  return categories
    .filter(({ id, leftMinor }) => id !== row.id && leftMinor >= row.overMinor)
    .toSorted((a, b) => rankOf(b.id) - rankOf(a.id))[0];
}

function moveButton(row, categories, available, page) {
  const donor = donorFor(row, categories, page.budget());
  const gap = row.overMinor - available;
  if (!donor)
    return el("span", {
      class: "muted",
      text: "No other category has enough left. Ask Huddle about raising the budget.",
    });
  return el("button", {
    type: "button",
    class: "button small",
    text: `Try moving ${page.money(gap)} from ${donor.name}`,
    "data-focus-key": `move:${row.id}`,
    onclick: () => page.askAbout(`Move ${page.money(gap)} from ${donor.name} to ${row.name}`),
  });
}

async function coverFromBuffer(row, page) {
  try {
    const { coveredMinor } = await api.coverFromBuffer(page.event.id, row.id);
    await page.reload();
    announce(`${page.money(coveredMinor)} moved from the buffer to ${row.name}.`);
    $("budget-title").focus();
  } catch (err) {
    announceError(err.message);
  }
}

function coverButton(row, available, page) {
  const amount = Math.min(row.overMinor, available);
  return el("button", {
    type: "button",
    class: "button small",
    text: `Cover ${page.money(amount)} from the buffer`,
    "data-focus-key": `cover:${row.id}`,
    onclick: () => coverFromBuffer(row, page),
  });
}

function overspendActions(row, categories, available, page) {
  if (row.overMinor <= 0 || !page.isManager) return [];
  return [
    available > 0 ? coverButton(row, available, page) : null,
    row.overMinor > available ? moveButton(row, categories, available, page) : null,
  ];
}

function statusOf(row, money) {
  if (row.overMinor > 0)
    return el("span", {
      class: "risk",
      text: `${money(row.overMinor)} ${row.coveredMinor ? "still " : ""}over plan`,
    });
  return el("span", { class: "muted", text: `${money(row.leftMinor)} left` });
}

function categoryRow(row, { categories, contingency, totalMinor }, page) {
  const { money } = page;
  const shown = page.budget().categories.find((item) => item.id === row.id) ?? {};
  const available = contingency?.availableMinor ?? 0;
  return el(
    "li",
    { class: "money-row" },
    el(
      "div",
      { class: "money-head" },
      el("strong", { text: row.name }),
      el("span", { text: `${money(row.spentMinor)} of ${money(row.plannedMinor)}` }),
    ),
    row.coveredMinor
      ? el("p", {
          class: "money-covered",
          text: `${money(row.plannedMinor - row.coveredMinor)} plan + ${money(row.coveredMinor)} from the buffer`,
        })
      : null,
    bar(percentOf(row.spentMinor, row.plannedMinor), row.overMinor > 0 ? "is-over" : ""),
    el(
      "div",
      { class: "money-foot" },
      statusOf(row, money),
      el("span", { class: "muted", text: whyLine(shown, totalMinor) }),
      ...overspendActions(row, categories, available, page),
    ),
  );
}

/**
 * Draws each category's spending against its plan, with what the manager can do about an overspend.
 * @param {object} summary The expense summary.
 * @param {object} page The page's context: money, the budget on screen and who is looking.
 */
export function drawCategories(summary, page) {
  const list = $("money-categories");
  clear(list);
  list.append(...summary.categories.map((row) => categoryRow(row, summary, page)));
}

async function removeExpense(expense, page) {
  try {
    await api.deleteExpense(expense.id);
    await page.reload();
    announce(`${expense.description} removed.`);
    $("expense-description").focus();
  } catch (err) {
    announceError(err.message);
  }
}

function expenseRow(expense, categories, page) {
  const nameOf = (id) => categories.find((item) => item.id === id)?.name ?? "";
  const where = expense.fromBuffer
    ? ["From the buffer", nameOf(expense.categoryId)].filter(Boolean).join(", ")
    : nameOf(expense.categoryId);
  const mayRemove = page.isManager || expense.createdById === page.me.id;
  return el(
    "li",
    { class: "expense" },
    el(
      "div",
      {},
      el("strong", { text: expense.description }),
      el("span", {
        class: "muted",
        text: `${formatShortDate(expense.createdAt)}, ${where}`,
      }),
    ),
    el("span", { class: "expense-amount", text: page.money(expense.amountMinor) }),
    mayRemove
      ? el("button", {
          type: "button",
          class: "link-button",
          text: "Remove",
          "data-focus-key": `remove:${expense.id}`,
          "aria-label": `Remove ${expense.description}`,
          onclick: () => removeExpense(expense, page),
        })
      : null,
  );
}

/**
 * Draws the expenses, newest first.
 * @param {object[]} expenses The expenses.
 * @param {object[]} categories The categories this person may see.
 * @param {object} page The page's context.
 */
export function drawExpenses(expenses, categories, page) {
  const list = $("expense-list");
  clear(list);
  $("expense-empty").hidden = expenses.length > 0;
  list.append(...expenses.toReversed().map((expense) => expenseRow(expense, categories, page)));
}
