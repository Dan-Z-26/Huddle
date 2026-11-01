/** The budget donut and its data table. */
import { $, clear, el, formatMoney } from "../shared/dom.js";
import { amountText, slicesOf, summaryText } from "./budgetSlices.js";

const SVG_NS = "http://www.w3.org/2000/svg";
const RADIUS = 80;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;
// A thin gap between slices, unless a slice is too small to spare it.
const SLICE_GAP = 1.5;
const MIN_LENGTH_FOR_GAP = 3;
const MIN_LABEL_SHARE = 4;

function svg(tag, attrs = {}) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  return node;
}

let parts = null;

function ensureDonut() {
  if (parts) return parts;
  const chart = $("budget-chart");
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

function centerLabel(budget, preview) {
  if (preview) return "If you apply this";
  return budget.totalMinor === undefined ? "Your areas" : "Total budget";
}

// Grows from nothing when new, and morphs from where it was otherwise.
function drawSlice(slice, { total, used, slices, budget, defaults }) {
  const { donut, circles, numbers } = parts;
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
  const gap = length > MIN_LENGTH_FOR_GAP ? SLICE_GAP : 0;
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
  return fraction;
}

// Numbers go in an upright overlay: the ring itself is rotated to start at twelve o'clock.
function drawNumbers() {
  const { chart, numbers } = parts;
  if (!parts.overlay) {
    parts.overlay = svg("svg", {
      viewBox: "0 0 200 200",
      class: "donut-labels",
      "aria-hidden": "true",
    });
    parts.overlay.style.position = "absolute";
    parts.overlay.style.inset = "0";
    parts.overlay.style.pointerEvents = "none";
    chart.append(parts.overlay);
  }
  parts.overlay.replaceChildren(...numbers.values());
}

function drawDonut(slices, total, budget, preview) {
  const { chart, donut, big, small, circles, numbers } = ensureDonut();
  const defaults = {
    big: formatMoney(budget.totalMinor ?? total, budget.currency),
    small: centerLabel(budget, preview),
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

  let used = 0;
  for (const slice of slices) used += drawSlice(slice, { total, used, slices, budget, defaults });
  const seen = new Set(slices.map(({ id }) => id));
  for (const [id, circle] of circles) {
    if (!seen.has(id)) {
      circle.style.strokeDasharray = `0 ${CIRCUMFERENCE}`;
      numbers.get(id).style.opacity = "0";
    }
  }
  drawNumbers();
  return defaults;
}

function drawRows(slices, budget, defaults) {
  const rows = $("budget-rows");
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
  $("budget-summary").textContent = summaryText(budget);
  const defaults = drawDonut(slices, total, budget, preview);
  drawRows(slices, budget, defaults);
}
