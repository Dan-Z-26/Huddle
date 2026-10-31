import { clear, el, formatMoney } from "./dom.js";

const SVG_NS = "http://www.w3.org/2000/svg";
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
const RADIUS = 80;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;
const MIN_LABEL_SHARE = 4;

const colors = new Map();

/** The colour a category has in the chart, so other parts of the page can match it. */
export const colorOf = (id) => (colors.get(id) ?? SPARE)[0];
const inkOf = (id) => (colors.get(id) ?? SPARE)[1];

function svg(tag, attrs = {}) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  return node;
}

// Dividing a budget per guest leaves a few rupees over; that isn't worth a row or a slice.
const isTiny = (remainingMinor, totalMinor) => remainingMinor < totalMinor / 200;

function amountText({ committedMinor, lowMinor, highMinor }, currency) {
  if (lowMinor === highMinor) return formatMoney(committedMinor, currency);
  return `${formatMoney(lowMinor, currency)} to ${formatMoney(highMinor, currency)} (estimate)`;
}

function summaryText(budget) {
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

function slicesOf(budget) {
  const ordered = [...budget.categories].sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99));
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

let parts = null;

function ensureDonut() {
  if (parts) return parts;
  const chart = document.getElementById("budget-chart");
  clear(chart);
  const donut = svg("svg", { viewBox: "0 0 200 200", class: "donut", role: "img" });
  donut.append(svg("circle", { cx: 100, cy: 100, r: RADIUS, class: "donut-track" }));
  const center = el("div", { class: "donut-center", "aria-hidden": "true" });
  const big = el("strong");
  const small = el("span");
  center.append(big, small);
  chart.append(donut, center);
  parts = { chart, donut, big, small, circles: new Map(), numbers: new Map() };
  return parts;
}

function focusSlice(id, slices, budget, defaults) {
  const { chart, circles, big, small } = parts;
  const slice = slices.find((item) => item.id === id);
  chart.classList.toggle("is-focused", Boolean(slice));
  for (const [key, circle] of circles) circle.classList.toggle("is-on", key === id);
  for (const row of document.querySelectorAll("#budget-rows tr"))
    row.classList.toggle("is-on", row.dataset.id === id);
  big.textContent = slice ? formatMoney(slice.amount, budget.currency) : defaults.big;
  small.textContent = slice ? `${slice.name}, ${slice.share}%` : defaults.small;
}

function drawDonut(slices, total, budget, preview) {
  const { chart, donut, big, small, circles, numbers } = ensureDonut();
  const defaults = {
    big: formatMoney(budget.totalMinor ?? total, budget.currency),
    small: preview
      ? "If you apply this"
      : budget.totalMinor === undefined
        ? "Your areas"
        : "Total budget",
  };
  chart.classList.toggle("is-preview", Boolean(preview));
  chart.classList.remove("is-focused");
  big.textContent = defaults.big;
  small.textContent = defaults.small;
  const named = slices.filter(({ amount }) => amount > 0);
  donut.setAttribute(
    "aria-label",
    `Budget split: ${named.map(({ name, share }) => `${name} ${share}%`).join(", ")}.`,
  );

  const seen = new Set();
  let used = 0;
  for (const slice of slices) {
    seen.add(slice.id);
    let circle = circles.get(slice.id);
    if (!circle) {
      circle = svg("circle", { cx: 100, cy: 100, r: RADIUS, class: "donut-slice" });
      circle.style.strokeDasharray = `0 ${CIRCUMFERENCE}`;
      circle.style.strokeDashoffset = `${-used * CIRCUMFERENCE}`;
      donut.append(circle);
      circles.set(slice.id, circle);
    }
    // Set every time: a category's colour can change when a different person is viewing.
    circle.setAttribute("stroke", slice.color);
    circle.onmouseenter = () => focusSlice(slice.id, slices, budget, defaults);
    circle.onmouseleave = () => focusSlice(null, slices, budget, defaults);
    const fraction = total ? slice.amount / total : 0;
    const length = fraction * CIRCUMFERENCE;
    const gap = length > 3 ? 1.5 : 0;
    // Set on the next frame, so a new slice grows from nothing.
    const offset = -used * CIRCUMFERENCE;
    requestAnimationFrame(() => {
      circle.style.strokeDasharray = `${Math.max(length - gap, 0)} ${CIRCUMFERENCE}`;
      circle.style.strokeDashoffset = `${offset}`;
    });

    let number = numbers.get(slice.id);
    if (!number) {
      number = svg("text", { class: "donut-num", "aria-hidden": "true" });
      numbers.set(slice.id, number);
    }
    const angle = 2 * Math.PI * (used + fraction / 2);
    number.setAttribute("x", 100 + RADIUS * Math.cos(angle - Math.PI / 2));
    number.setAttribute("y", 100 + RADIUS * Math.sin(angle - Math.PI / 2));
    number.textContent = slice.number;
    number.style.fill = slice.ink;
    number.style.opacity = slice.share >= MIN_LABEL_SHARE ? "1" : "0";
    used += fraction;
  }
  for (const [id, circle] of circles) {
    if (!seen.has(id)) {
      circle.style.strokeDasharray = `0 ${CIRCUMFERENCE}`;
      numbers.get(id).style.opacity = "0";
    }
  }
  // Numbers go in an upright overlay: the ring itself is rotated to start at twelve o'clock.
  let overlay = parts.overlay;
  if (!overlay) {
    overlay = svg("svg", { viewBox: "0 0 200 200", class: "donut-labels", "aria-hidden": "true" });
    overlay.style.position = "absolute";
    overlay.style.inset = "0";
    overlay.style.pointerEvents = "none";
    chart.append(overlay);
    parts.overlay = overlay;
  }
  overlay.replaceChildren(...numbers.values());
  return defaults;
}

function drawRows(slices, budget, defaults) {
  const rows = document.getElementById("budget-rows");
  clear(rows);
  for (const slice of slices) {
    const number = el("span", { class: "row-num", "aria-hidden": "true", text: slice.number });
    number.style.setProperty("--dot", slice.color);
    number.style.setProperty("--dot-ink", slice.ink);
    const name = el(
      "button",
      {
        type: "button",
        class: "row-name",
        onmouseenter: () => focusSlice(slice.id, slices, budget, defaults),
        onmouseleave: () => focusSlice(null, slices, budget, defaults),
        onfocus: () => focusSlice(slice.id, slices, budget, defaults),
        onblur: () => focusSlice(null, slices, budget, defaults),
      },
      number,
      el(
        "span",
        {},
        slice.name,
        slice.rank ? el("span", { class: "sr-only", text: `, priority ${slice.rank}` }) : null,
      ),
      slice.tierLabel ? el("small", { class: "tier", text: slice.tierLabel }) : null,
    );
    const row = el(
      "tr",
      {},
      el("th", { scope: "row" }, name),
      el("td", {
        class: "num",
        text: slice.spare
          ? formatMoney(slice.amount, budget.currency)
          : amountText(slice, budget.currency),
      }),
      el("td", { class: "num", text: `${slice.share}%` }),
    );
    row.dataset.id = slice.id;
    rows.append(row);
  }
}

/**
 * Draws the budget: an animated ring that morphs between states, and its data table. Hovering or
 * focusing either highlights the same category in both.
 * @param {object} budget The server's budget, or a preview of one.
 * @param {{preview?: boolean}} [options] A preview is labelled as not yet applied.
 */
export function renderBudget(budget, { preview = false } = {}) {
  const { slices, total } = slicesOf(budget);
  document.getElementById("budget-summary").textContent = summaryText(budget);
  const defaults = drawDonut(slices, total, budget, preview);
  drawRows(slices, budget, defaults);
}
