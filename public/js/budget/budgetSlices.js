/** Works out the donut's slices and the line above it. No drawing happens here. */
import { formatMoney } from "../shared/dom.js";

// Checked for colour-blind separation in this order, led by the app's own accent. Each slice also
// carries its row number, in whichever ink is readable on it.
const COLORS = [
  ["#b5175c", "#fff"],
  ["#eda100", "#2b1d25"],
  ["#6250d6", "#fff"],
  ["#008300", "#fff"],
  ["#e87ba4", "#2b1d25"],
  ["#2a78d6", "#fff"],
  ["#eb6834", "#2b1d25"],
  ["#1baf7a", "#2b1d25"],
];
const SPARE = ["#9a8791", "#2b1d25"];
const BUFFER = ["#6d5d66", "#fff"];

const colors = new Map();

/**
 * The colour a category has in the chart, so other parts of the page can match it.
 * @param {string} id The category.
 * @returns {string} The colour.
 */
export const colorOf = (id) => (colors.get(id) ?? SPARE)[0];
const inkOf = (id) => (colors.get(id) ?? SPARE)[1];

// Dividing a budget per guest leaves a few rupees over; under half a percent isn't worth a row or a slice.
const UNRANKED_LAST = 99;
const isTiny = (remainingMinor, totalMinor) => remainingMinor < totalMinor / 200;

/**
 * How much a category costs, as a range when part of it is still an estimate.
 * @param {{committedMinor: number, lowMinor: number, highMinor: number}} cost The cost at each end.
 * @param {string} currency The currency.
 * @returns {string} The amount.
 */
export function amountText({ committedMinor, lowMinor, highMinor }, currency) {
  if (lowMinor === highMinor) return formatMoney(committedMinor, currency);
  return `${formatMoney(lowMinor, currency)} to ${formatMoney(highMinor, currency)} (estimate)`;
}

/**
 * The one line above the chart.
 * @param {object} budget The budget.
 * @returns {string} The line.
 */
export function summaryText(budget) {
  const { totalMinor, remainingMinor, currency, guestCount, contingency } = budget;
  if (totalMinor === undefined)
    return `Your areas, for ${guestCount} guests. The total is visible to the event manager.`;
  const buffer = contingency?.reservedMinor
    ? ` ${formatMoney(contingency.availableMinor, currency)} left in the buffer.`
    : "";
  if (remainingMinor < 0)
    return `${formatMoney(-remainingMinor, currency)} over budget, for ${guestCount} guests.${buffer}`;
  if (isTiny(remainingMinor, totalMinor))
    return `Fully allocated, for ${guestCount} guests.${buffer}`;
  return `${formatMoney(remainingMinor, currency)} not yet committed, for ${guestCount} guests.${buffer}`;
}

/**
 * Works out the chart's slices: categories in priority order, then the buffer and what is spare.
 * @param {object} budget The budget.
 * @returns {{total: number, slices: object[]}} The slices with their numbers, colours and shares.
 */
export function slicesOf(budget) {
  const ordered = [...budget.categories].sort(
    (a, b) => (a.rank ?? UNRANKED_LAST) - (b.rank ?? UNRANKED_LAST),
  );
  for (const { id } of ordered) {
    if (!colors.has(id)) colors.set(id, COLORS[colors.size % COLORS.length]);
  }
  colors.set("buffer", BUFFER);
  const shown = ordered.map((category) => ({
    ...category,
    amount: category.committedMinor,
    color: colorOf(category.id),
    ink: inkOf(category.id),
  }));
  const { contingency, currency } = budget;
  if (contingency?.reservedMinor > 0)
    shown.push({
      id: "buffer",
      name: "Contingency buffer",
      amount: contingency.reservedMinor,
      color: BUFFER[0],
      ink: BUFFER[1],
      spare: true,
      tierLabel: contingency.spentMinor
        ? `${formatMoney(contingency.spentMinor, currency)} used`
        : "For sudden expenses",
    });
  if (budget.remainingMinor > 0 && !isTiny(budget.remainingMinor, budget.totalMinor))
    shown.push({
      id: "spare",
      name: "Not committed",
      amount: budget.remainingMinor,
      color: SPARE[0],
      ink: SPARE[1],
      spare: true,
    });
  const total = shown.reduce((sum, { amount }) => sum + amount, 0);
  return {
    total,
    slices: shown.map((slice, i) => ({
      ...slice,
      number: i + 1,
      share: total ? Math.round((slice.amount / total) * 100) : 0,
    })),
  };
}
