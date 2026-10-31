import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolutionEvents } from "../../server/core/consequences.js";
import { optionCost, planOf } from "../../public/js/gapPlan.js";

// The browser previews the chosen cuts and the server applies them. Both must agree to the paisa,
// or the chart would show one figure and applying would give another.
const option = (categoryId, costMinor, gap) => ({
  categoryId,
  atHigh: {
    cutMinor: Math.min(costMinor, gap),
    newTotalMinor: costMinor - Math.min(costMinor, gap),
  },
  atLow: null,
});

describe("gapPlan agrees with resolutionEvents", () => {
  const cases = [
    { gap: 100, costs: { a: 60, b: 500 }, cuts: ["a", "b"] },
    { gap: 100, costs: { a: 60, b: 500 }, cuts: ["b", "a"] },
    { gap: 100, costs: { a: 60, b: 20 }, cuts: ["a", "b"] },
    { gap: 7, costs: { a: 3, b: 3, c: 9 }, cuts: ["a", "b", "c"] },
  ];

  for (const { gap, costs, cuts } of cases) {
    it(`gap ${gap}, cuts ${cuts.join(",")}`, () => {
      const options = Object.entries(costs).map(([id, cost]) => option(id, cost, gap));
      const preview = planOf(options, gap, cuts);
      const server = resolutionEvents(
        { shortfall: { highMinor: gap }, options, after: { totalMinor: 1000 } },
        { cuts },
      );
      for (const { category, amountMinor } of server.events) {
        const option = options.find(({ categoryId }) => categoryId === category);
        assert.equal(optionCost(option) - amountMinor, preview.taken.get(category), category);
      }
      assert.equal(server.remainingMinor, preview.left);
    });
  }
});
