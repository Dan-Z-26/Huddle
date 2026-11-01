/** The Budget page: what was spent against the plan, the buffer, and adding expenses. */
import { api } from "../shared/api.js";
import {
  $,
  announce,
  announceError,
  clear,
  el,
  formatMoney,
  keepFocus,
  whileBusy,
} from "../shared/dom.js";
import { drawCategories, drawExpenses } from "./budgetRows.js";
import { drawBuffer, drawStats } from "./budgetStats.js";

const BUFFER = "buffer";

function fillCategorySelect(categories, isManager) {
  const select = $("expense-category");
  const was = select.value;
  clear(select);
  for (const { id, name } of categories) select.append(el("option", { value: id, text: name }));
  if (isManager)
    select.append(el("option", { value: BUFFER, text: "Unexpected: pay from the buffer" }));
  if ([...select.options].some(({ value }) => value === was)) select.value = was;
}

async function refresh(page) {
  const { expenses, summary } = await api.expenses(page.event.id);
  keepFocus(() => {
    drawStats(summary, page.money);
    drawBuffer(summary, page.money);
    drawCategories(summary, page);
    drawExpenses(expenses, summary.categories, page);
    fillCategorySelect(summary.categories, page.isManager);
  });
}

async function addExpense(e, page) {
  e.preventDefault();
  const error = $("expense-error");
  error.textContent = "";
  const description = $("expense-description");
  const amount = $("expense-amount");
  const chosen = $("expense-category").value;
  try {
    await api.addExpense(page.event.id, {
      description: description.value,
      amount: amount.value,
      ...(chosen === BUFFER ? { fromBuffer: true } : { categoryId: chosen }),
    });
    description.value = "";
    amount.value = "";
    await page.reload();
    announce("Expense added.");
    description.focus();
  } catch (err) {
    error.textContent = err.message;
  }
}

async function changeBufferSize(e, page) {
  e.preventDefault();
  const percent = Number($("buffer-percent").value);
  try {
    await whileBusy($("buffer-send"), "Working it out…", async () => {
      const data = await api.setBuffer(page.event.id, percent);
      page.showProposal(`Set the contingency buffer to ${percent}%`, data);
    });
  } catch (err) {
    announceError(err.message);
  }
}

/**
 * Wires the Budget page. All figures come from a route that filters by role, so a core member's page
 * simply has less to draw.
 * @param {{event: object, me: object, isManager: boolean, budget: () => object,
 *   showProposal: (text: string, data: object) => void, askAbout: (text: string) => void,
 *   reload: () => Promise<void>}} context The event, the person, the budget on screen, how to show
 *   a proposed change, how to start a question in Ask Huddle, and how to redraw.
 * @returns {() => Promise<void>} Fetches and draws the page.
 */
export function setUpBudgetPage(context) {
  const page = {
    ...context,
    money: (minor) => formatMoney(minor, context.budget().currency),
  };
  $("expense-form").onsubmit = (e) => addExpense(e, page);
  $("buffer-form").onsubmit = (e) => changeBufferSize(e, page);
  return () => refresh(page);
}
