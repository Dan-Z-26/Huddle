import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { amountText, colorOf, slicesOf, summaryText } from "../../public/js/budget/budgetSlices.js";
import { countdown, formatMoney, formatSize, initials } from "../../public/js/shared/dom.js";

const LAKH = 100_000_00;
const category = (id, rank, committedMinor) => ({
  id,
  name: id,
  rank,
  committedMinor,
  lowMinor: committedMinor,
  highMinor: committedMinor,
});
const budget = (overrides = {}) => ({
  currency: "INR",
  guestCount: 200,
  totalMinor: 10 * LAKH,
  remainingMinor: 0,
  categories: [category("food", 2, 4 * LAKH), category("stage", 1, 6 * LAKH)],
  ...overrides,
});

describe("the chart's slices", () => {
  it("come in the manager's priority order, numbered, with shares of the whole", () => {
    const { total, slices } = slicesOf(budget());
    assert.equal(total, 10 * LAKH);
    assert.deepEqual(
      slices.map(({ id, number, share }) => [id, number, share]),
      [
        ["stage", 1, 60],
        ["food", 2, 40],
      ],
    );
  });

  it("show the buffer and what is uncommitted after the categories", () => {
    const contingency = { reservedMinor: LAKH, spentMinor: 0, availableMinor: LAKH };
    const { slices } = slicesOf(budget({ contingency, remainingMinor: LAKH }));
    assert.deepEqual(
      slices.map(({ id }) => id),
      ["stage", "food", "buffer", "spare"],
    );
  });

  it("leave out the few rupees that dividing per guest leaves over", () => {
    const { slices } = slicesOf(budget({ remainingMinor: 500 }));
    assert.equal(
      slices.some(({ id }) => id === "spare"),
      false,
    );
  });

  it("keep a category's colour when the figures change", () => {
    const before = slicesOf(budget()).slices.find(({ id }) => id === "food").color;
    const changed = [category("food", 5, LAKH), category("stage", 1, 9 * LAKH)];
    const after = slicesOf(budget({ categories: changed })).slices;
    assert.equal(after.find(({ id }) => id === "food").color, before);
    assert.equal(colorOf("food"), before);
  });

  it("have no share to work out when nothing is planned", () => {
    const empty = [category("food", 1, 0)];
    const { slices } = slicesOf(budget({ categories: empty, totalMinor: 0 }));
    assert.equal(slices[0].share, 0);
  });
});

describe("the line above the chart", () => {
  it("says what is over, allocated or still free", () => {
    assert.match(summaryText(budget({ remainingMinor: -LAKH })), /^₹1,00,000 over budget/);
    assert.match(summaryText(budget({ remainingMinor: 500 })), /^Fully allocated/);
    assert.match(summaryText(budget({ remainingMinor: LAKH })), /^₹1,00,000 not yet committed/);
  });

  it("mentions the buffer only when there is one", () => {
    const contingency = { reservedMinor: LAKH, availableMinor: LAKH / 2 };
    assert.match(summaryText(budget({ contingency })), /₹50,000 left in the buffer/);
    assert.doesNotMatch(summaryText(budget()), /buffer/);
  });

  it("never states a total to someone who may not see it", () => {
    const text = summaryText({ currency: "INR", guestCount: 200, categories: [] });
    assert.match(text, /^Your areas, for 200 guests/);
    assert.doesNotMatch(text, /₹/);
  });
});

describe("amounts on the page", () => {
  it("shows an estimate as a labelled range and a firm price as one figure", () => {
    assert.equal(amountText(category("a", 1, LAKH), "INR"), "₹1,00,000");
    const estimate = { committedMinor: LAKH, lowMinor: LAKH, highMinor: 2 * LAKH };
    assert.equal(amountText(estimate, "INR"), "₹1,00,000 to ₹2,00,000 (estimate)");
  });

  it("turns paise into rupees in the Indian grouping", () => {
    assert.equal(formatMoney(12_000_000), "₹1,20,000");
    assert.equal(formatMoney(5_000, "USD"), "$50");
  });

  it("shows sizes and initials people can read", () => {
    assert.equal(formatSize(10), "1 KB");
    assert.equal(formatSize(50 * 1024), "50 KB");
    assert.equal(formatSize(2 * 1048576), "2.0 MB");
    assert.equal(initials("asha menon rao"), "AM");
  });
});

describe("the countdown", () => {
  const onDay = (t, day) => t.mock.timers.enable({ apis: ["Date"], now: Date.parse(day) });

  it("counts whole days to the event, in words near the end", (t) => {
    onDay(t, "2026-11-01T18:30:00.000Z");
    assert.equal(countdown("2026-11-11"), "10 days to go");
    assert.equal(countdown("2026-11-02"), "Tomorrow");
    assert.equal(countdown("2026-11-01"), "Today");
    assert.equal(countdown("2026-10-31"), "Event date has passed");
    assert.equal(countdown(""), "");
  });
});
