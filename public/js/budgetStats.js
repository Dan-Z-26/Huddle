import { clear, el } from "./dom.js";

const $ = (id) => document.getElementById(id);

/** A whole-number percentage, or 0 when there is nothing to divide by. */
export const percentOf = (part, whole) => (whole ? Math.round((part / whole) * 100) : 0);

/** A bar showing how much of something is used. */
export function bar(valuePct, tone = "") {
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
 * Draws the headline figures. A core member's summary has no totals, so they get only their areas.
 * @param {object} summary The expense summary.
 * @param {(minor: number) => string} money How to show money.
 */
export function drawStats({ categories, totalMinor, spentMinor, leftMinor, contingency }, money) {
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

/**
 * Draws the contingency buffer: what was set aside, what it paid, and what is left.
 * @param {object} summary The expense summary.
 * @param {(minor: number) => string} money How to show money.
 */
export function drawBuffer({ contingency, totalMinor, coveredMinor }, money) {
  $("buffer-box").hidden = contingency === undefined;
  if (!contingency) return;
  const { reservedMinor, spentMinor, availableMinor } = contingency;
  // A cover shrinks what is set aside, so the size it started at includes what moved out.
  const startMinor = reservedMinor + coveredMinor;
  const parts = [`${money(spentMinor)} paid from it`];
  if (coveredMinor > 0) parts.push(`${money(coveredMinor)} moved to cover overspending`);
  parts.push(`${money(availableMinor)} left`);
  $("buffer-status").textContent =
    `${money(startMinor)} set aside, ${percentOf(startMinor, totalMinor)}% of your budget. ` +
    `${parts.join(", ")}.`;
  const shown = $("buffer-bar");
  clear(shown);
  shown.append(bar(percentOf(spentMinor + coveredMinor, startMinor)));
  // Drawing on the buffer can leave a size that isn't one of the listed ones.
  const size = $("buffer-percent");
  const percent = String(percentOf(reservedMinor, totalMinor));
  size.querySelector("[data-current]")?.remove();
  if (![...size.options].some(({ value }) => value === percent))
    size.append(el("option", { value: percent, text: `${percent}%`, "data-current": "true" }));
  size.value = percent;
}
