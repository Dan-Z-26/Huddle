import { api } from "./api.js";
import {
  announce,
  announceError,
  clear,
  el,
  formatMoney,
  formatShortDate,
  keepFocus,
} from "./dom.js";

const $ = (id) => document.getElementById(id);
const BUFFER = "buffer";
const percentOf = (part, whole) => (whole ? Math.round((part / whole) * 100) : 0);

function bar(valuePct, tone = "") {
  const fill = el("span");
  fill.style.width = `${Math.min(valuePct, 100)}%`;
  return el("span", { class: `money-bar ${tone}`, "aria-hidden": "true" }, fill);
}

function stat(label, value, note) {
  return el(
    "div",
    { class: "stat" },
    el("dt", { text: label }),
    el("dd", { text: value }),
    note ? el("dd", { class: "stat-note", text: note }) : null,
  );
}

/**
 * Wires the Budget page: what was spent against the plan, the contingency buffer, and adding
 * expenses. All figures come from a route that filters by role, so a core member's page simply has
 * less to draw.
 * @param {{event: object, me: object, isManager: boolean, budget: () => object,
 *   showProposal: (text: string, data: object) => void, reload: () => Promise<void>}} context The
 *   event, the person, the budget on screen, how to show a proposed change, and how to redraw.
 * @returns {() => Promise<void>} Fetches and draws the page.
 */
export function setUpBudgetPage({ event, me, isManager, budget, showProposal, reload }) {
  const money = (minor) => formatMoney(minor, budget().currency);
  let summary = null;

  function drawStats({ categories, totalMinor, spentMinor, leftMinor, contingency }) {
    const box = $("money-stats");
    clear(box);
    if (totalMinor === undefined) {
      const planned = categories.reduce((sum, { plannedMinor }) => sum + plannedMinor, 0);
      const spent = categories.reduce((sum, item) => sum + item.spentMinor, 0);
      box.append(stat("Planned for your areas", money(planned)), stat("Spent", money(spent)));
      return;
    }
    box.append(
      stat("Total budget", money(totalMinor)),
      stat("Spent so far", money(spentMinor), `${percentOf(spentMinor, totalMinor)}% of the total`),
      stat("Left to spend", money(leftMinor)),
      stat("Buffer left", money(contingency.availableMinor)),
    );
  }

  function drawBuffer({ contingency, totalMinor }) {
    $("buffer-box").hidden = contingency === undefined;
    if (!contingency) return;
    const { reservedMinor, spentMinor, availableMinor } = contingency;
    $("buffer-status").textContent =
      `${money(reservedMinor)} set aside, ${percentOf(reservedMinor, totalMinor)}% of your budget. ` +
      `${money(spentMinor)} used, ${money(availableMinor)} left.`;
    const shown = $("buffer-bar");
    clear(shown);
    shown.append(bar(percentOf(spentMinor, reservedMinor)));
    // Drawing on the buffer can leave a size that isn't one of the listed ones.
    const size = $("buffer-percent");
    const percent = String(percentOf(reservedMinor, totalMinor));
    size.querySelector("[data-current]")?.remove();
    if (![...size.options].some(({ value }) => value === percent))
      size.append(el("option", { value: percent, text: `${percent}%`, "data-current": "true" }));
    size.value = percent;
  }

  function whyLine(category, totalMinor) {
    const { rank, typicalBps, committedMinor } = category;
    if (totalMinor === undefined || !typicalBps) return "";
    const priority = rank ? `Priority ${rank}. ` : "Not ranked. ";
    return `${priority}Usually about ${Math.round(typicalBps / 100)}%, here ${percentOf(committedMinor, totalMinor)}%.`;
  }

  function coverButton(row, available) {
    const amount = Math.min(row.overMinor, available);
    return el("button", {
      type: "button",
      class: "button small",
      text: `Cover ${money(amount)} from the buffer`,
      "data-focus-key": `cover:${row.id}`,
      onclick: async () => {
        try {
          const { coveredMinor } = await api.coverFromBuffer(event.id, row.id);
          await reload();
          announce(`${money(coveredMinor)} moved from the buffer to ${row.name}.`);
          $("budget-title").focus();
        } catch (err) {
          announceError(err.message);
        }
      },
    });
  }

  function drawCategories({ categories, contingency, totalMinor }) {
    const list = $("money-categories");
    clear(list);
    const shown = new Map(budget().categories.map((item) => [item.id, item]));
    const available = contingency?.availableMinor ?? 0;
    for (const row of categories) {
      const over = row.overMinor > 0;
      const status = over
        ? el("span", { class: "risk", text: `${money(row.overMinor)} over plan` })
        : el("span", { class: "muted", text: `${money(row.leftMinor)} left` });
      list.append(
        el(
          "li",
          { class: "money-row" },
          el(
            "div",
            { class: "money-head" },
            el("strong", { text: row.name }),
            el("span", { text: `${money(row.spentMinor)} of ${money(row.plannedMinor)}` }),
          ),
          bar(percentOf(row.spentMinor, row.plannedMinor), over ? "is-over" : ""),
          el(
            "div",
            { class: "money-foot" },
            status,
            el("span", { class: "muted", text: whyLine(shown.get(row.id) ?? {}, totalMinor) }),
            over && isManager && available > 0 ? coverButton(row, available) : null,
          ),
        ),
      );
    }
  }

  function drawExpenses(expenses, categories) {
    const list = $("expense-list");
    clear(list);
    $("expense-empty").hidden = expenses.length > 0;
    const nameOf = (id) => categories.find((item) => item.id === id)?.name ?? "";
    for (const expense of expenses.toReversed()) {
      const where = expense.fromBuffer
        ? ["From the buffer", nameOf(expense.categoryId)].filter(Boolean).join(", ")
        : nameOf(expense.categoryId);
      const mayRemove = isManager || expense.createdById === me.id;
      list.append(
        el(
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
          el("span", { class: "expense-amount", text: money(expense.amountMinor) }),
          mayRemove
            ? el("button", {
                type: "button",
                class: "link-button",
                text: "Remove",
                "aria-label": `Remove ${expense.description}`,
                onclick: async () => {
                  try {
                    await api.deleteExpense(expense.id);
                    await reload();
                    announce(`${expense.description} removed.`);
                    $("expense-description").focus();
                  } catch (err) {
                    announceError(err.message);
                  }
                },
              })
            : null,
        ),
      );
    }
  }

  function fillCategorySelect(categories) {
    const select = $("expense-category");
    const was = select.value;
    clear(select);
    for (const { id, name } of categories) select.append(el("option", { value: id, text: name }));
    if (isManager)
      select.append(el("option", { value: BUFFER, text: "Unexpected: pay from the buffer" }));
    if ([...select.options].some(({ value }) => value === was)) select.value = was;
  }

  async function refresh() {
    const { expenses, summary: next } = await api.expenses(event.id);
    summary = next;
    keepFocus(() => {
      drawStats(summary);
      drawBuffer(summary);
      drawCategories(summary);
      drawExpenses(expenses, summary.categories);
      fillCategorySelect(summary.categories);
    });
  }

  $("expense-form").onsubmit = async (e) => {
    e.preventDefault();
    const error = $("expense-error");
    error.textContent = "";
    const description = $("expense-description");
    const amount = $("expense-amount");
    const chosen = $("expense-category").value;
    const fromBuffer = chosen === BUFFER;
    try {
      await api.addExpense(event.id, {
        description: description.value,
        amount: amount.value,
        ...(fromBuffer ? { fromBuffer: true } : { categoryId: chosen }),
      });
      description.value = "";
      amount.value = "";
      await reload();
      announce("Expense added.");
      description.focus();
    } catch (err) {
      error.textContent = err.message;
    }
  };

  $("buffer-form").onsubmit = async (e) => {
    e.preventDefault();
    const percent = Number($("buffer-percent").value);
    const button = $("buffer-send");
    button.disabled = true;
    button.textContent = "Working it out…";
    try {
      const data = await api.setBuffer(event.id, percent);
      showProposal(`Set the contingency buffer to ${percent}%`, data);
    } catch (err) {
      announceError(err.message);
    } finally {
      button.disabled = false;
      button.textContent = "See what changes";
    }
  };

  return refresh;
}
