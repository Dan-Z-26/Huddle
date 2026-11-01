import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { optionCost, planOf, previewOf } from "../../public/js/budget/gapPlan.js";
import { resolutionEvents } from "../../server/core/consequences.js";

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

describe("previewOf", () => {
  const after = {
    totalMinor: 1000,
    categories: [
      { id: "food", committedMinor: 600, lowMinor: 600, highMinor: 600 },
      { id: "stage", committedMinor: 400, lowMinor: 300, highMinor: 500 },
    ],
    contingency: { reservedMinor: 100, availableMinor: 100 },
  };
  const current = {
    currency: "INR",
    categories: [
      { id: "food", rank: 2, tierLabel: "Sit-down" },
      { id: "stage", rank: 1, tierLabel: "Full wrap" },
    ],
  };
  const preview = (plan, raise = false) =>
    previewOf({ consequences: { budgetAfter: after } }, current, plan, raise);

  it("takes each cut from its own category and forgets a tier that no longer holds", () => {
    const { categories, committedMinor } = preview({ taken: new Map([["stage", 150]]), left: 0 });
    const [food, stage] = categories;
    assert.deepEqual(
      [stage.committedMinor, stage.lowMinor, stage.highMinor, stage.tierLabel],
      [250, 150, 350, null],
    );
    assert.equal(food.tierLabel, "Sit-down");
    assert.equal(committedMinor, 850);
  });

  it("adds what is left to the total only when the budget is raised", () => {
    const plan = { taken: new Map(), left: 200 };
    assert.equal(preview(plan).totalMinor, 1000);
    assert.equal(preview(plan, true).totalMinor, 1200);
  });

  it("draws on the buffer, which frees that money for the plan", () => {
    const { contingency, remainingMinor } = preview({ taken: new Map(), left: 0, drawn: 60 });
    assert.deepEqual([contingency.reservedMinor, contingency.availableMinor], [40, 40]);
    assert.equal(remainingMinor, 1000 - 40 - 1000);
  });
});
