/** Choosing how to close a budget gap: the option cards, and what each choice would do. */
import { $, clear, el, formatMoney } from "../shared/dom.js";
import { renderBudget } from "./budgetChart.js";
import { optionCard, plainCard } from "./gapCards.js";
import { optionCost, planOf, previewOf } from "./gapPlan.js";

const moneyOf = (panel) => (minor) => formatMoney(minor, panel.currentBudget().currency);

function cutFigures(card, { plan, open, options }, money) {
  const cost = optionCost(options.find(({ categoryId }) => categoryId === card.dataset.id));
  const take = plan.taken.get(card.dataset.id) ?? Math.min(open, cost);
  card.querySelector(".option-figures").textContent = take
    ? `${money(cost)} to ${money(cost - take)}, ${Math.round((take / cost) * 100)}% less`
    : `Stays at ${money(cost)}. The gap is already covered.`;
  card
    .querySelector(".option-bar span")
    .style.setProperty("--fill", `${Math.round(((cost - take) / cost) * 100)}%`);
}

function drawFigures(card, numbers, panel) {
  const money = moneyOf(panel);
  const { id } = card.dataset;
  const figures = card.querySelector(".option-figures");
  const { plan, open, gap, buffer } = numbers;
  if (id === "buffer")
    figures.textContent = `Uses ${money(Math.min(gap, buffer))} of the ${money(buffer)} left. No category changes.`;
  else if (id === "raise")
    figures.textContent = `Adds ${money(panel.raise ? plan.left : open)} to the total. No category changes.`;
  else cutFigures(card, numbers, money);
}

function applyLabel(panel) {
  const parts = [];
  if (panel.useBuffer) parts.push("use the buffer");
  if (panel.chosen.length) parts.push(`cut ${panel.chosen.map(panel.nameOf).join(" and ")}`);
  if (panel.raise) parts.push("raise the budget");
  return parts.length ? `Apply and ${parts.join(", ")}` : "Apply and stay over budget";
}

/**
 * Redraws the options and the preview chart for what the manager has chosen so far.
 * @param {object} panel The panel's state: the result, the choices, and the budget on screen.
 */
export function updateChoice(panel) {
  const money = moneyOf(panel);
  const { result, chosen, raise, useBuffer } = panel;
  const { options, shortfall, bufferAvailableMinor: buffer } = result.consequences;
  const gap = shortfall.highMinor;
  const plan = planOf(options, gap, chosen, useBuffer ? buffer : 0);
  const closed = gap - plan.left + (raise ? plan.left : 0);
  const open = gap - closed;
  $("gap-meter").max = gap;
  $("gap-meter").value = closed;
  $("gap-status").textContent = open
    ? `${money(closed)} of ${money(gap)} covered, ${money(open)} still open`
    : `The ${money(gap)} gap is covered`;
  const special = { raise, buffer: useBuffer };
  for (const card of document.querySelectorAll("#options .option")) {
    const { id } = card.dataset;
    const on = id in special ? special[id] : chosen.includes(id);
    card.setAttribute("aria-pressed", String(on));
    card.querySelector(".option-state").textContent = on ? "Chosen" : "Choose";
    drawFigures(card, { plan, open, gap, buffer, options }, panel);
  }
  $("result-apply").textContent = applyLabel(panel);
  renderBudget(previewOf(result, panel.currentBudget(), plan, raise), { preview: true });
}

/**
 * Draws one card for each way of closing the gap.
 * @param {object} data The change's consequences and insight.
 * @param {object} panel The panel's state, which the cards change.
 */
export function drawOptions(data, panel) {
  const list = $("options");
  clear(list);
  const add = (card) => list.append(el("li", {}, card));
  const toggled = (change) => () => {
    change();
    updateChoice(panel);
  };
  if (data.consequences.bufferAvailableMinor > 0)
    add(
      plainCard(
        "buffer",
        "Use the contingency buffer",
        toggled(() => (panel.useBuffer = !panel.useBuffer)),
      ),
    );
  for (const option of data.consequences.options) {
    const { categoryId } = option;
    const context = {
      nameOf: panel.nameOf,
      mustHaveText: panel.mustHaveText,
      note: data.insight?.optionNotes?.[categoryId],
    };
    const toggle = toggled(() => {
      panel.chosen = panel.chosen.includes(categoryId)
        ? panel.chosen.filter((id) => id !== categoryId)
        : [...panel.chosen, categoryId];
    });
    add(optionCard(option, context, toggle));
  }
  add(
    plainCard(
      "raise",
      "Raise the budget",
      toggled(() => (panel.raise = !panel.raise)),
    ),
  );
}
