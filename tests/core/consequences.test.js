import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { computeConsequences } from "../../server/core/consequences.js";
import { category, estimated, fixed, minorValues, perGuest, workedExample } from "./fixtures.js";

const to250 = [{ type: "guest_count", to: 250 }];

describe("computeConsequences: the plan's worked example", () => {
  const { state, profile } = workedExample();
  const result = computeConsequences(state, to250, profile);
  const option = (id) => result.options.find(({ categoryId }) => categoryId === id).atHigh;

  it("is Rs 1,25,000 over budget, with no surplus", () => {
    assert.deepEqual(result.shortfall, { lowMinor: 12500000, highMinor: 12500000 });
    assert.equal(result.surplusMinor, 0);
    assert.deepEqual(result.rejected, []);
  });

  it("lists only the per-guest categories as changed", () => {
    assert.deepEqual(result.deltas, [
      { categoryId: "fnb", beforeMinor: 40000000, afterMinor: 50000000 },
      { categoryId: "gifting", beforeMinor: 10000000, afterMinor: 12500000 },
    ]);
  });

  it("orders options by the user's ranking", () => {
    assert.deepEqual(
      result.options.map(({ categoryId, rank }) => [categoryId, rank]),
      [
        ["reveal", 1],
        ["fnb", 2],
        ["decor", 3],
        ["gifting", 4],
      ],
    );
  });

  it("states the Product reveal cut", () => {
    assert.deepEqual(option("reveal"), {
      cutMinor: 12500000,
      newTotalMinor: 47500000,
      pctDrop: 21,
      tierBefore: null,
      tierAfter: null,
      removedEntirely: false,
      coversShortfall: true,
      mustHaveConflicts: [],
    });
  });

  it("states the Food & beverage cut", () => {
    assert.equal(option("fnb").newTotalMinor, 37500000);
    assert.equal(option("fnb").pctDrop, 25);
    assert.deepEqual(option("fnb").mustHaveConflicts, []);
  });

  it("states that Décor falls from full stage wrap to backdrop only, hitting the must-have", () => {
    const decor = option("decor");
    assert.equal(decor.cutMinor, 12500000);
    assert.equal(decor.newTotalMinor, 37500000);
    assert.equal(decor.pctDrop, 25);
    assert.equal(decor.tierBefore.label, "full stage wrap");
    assert.equal(decor.tierAfter.label, "backdrop only");
    assert.equal(decor.removedEntirely, false);
    assert.deepEqual(decor.mustHaveConflicts, ["branded-stage"]);
  });

  it("states that Gifting is removed entirely", () => {
    const gifting = option("gifting");
    assert.equal(gifting.cutMinor, 12500000);
    assert.equal(gifting.newTotalMinor, 0);
    assert.equal(gifting.pctDrop, 100);
    assert.equal(gifting.removedEntirely, true);
    assert.equal(gifting.coversShortfall, true);
  });

  it("offers the budget increase", () => {
    assert.deepEqual(result.increaseBudget, { lowMinor: 12500000, highMinor: 12500000 });
  });

  it("gives identical low and high options when there are no estimates", () => {
    for (const { atLow, atHigh } of result.options) assert.deepEqual(atLow, atHigh);
  });

  it("returns the changed state and keeps the input as it was", () => {
    assert.equal(result.after.guestCount, 250);
    assert.deepEqual(state, workedExample().state);
  });

  it("never recommends", () => {
    const text = JSON.stringify(result).toLowerCase();
    assert.ok(!text.includes("recommend"));
    assert.ok(!Object.hasOwn(result, "recommended"));
  });

  it("only ever produces integer money, even with a 21% rounded drop", () => {
    assert.ok(minorValues(result).every(Number.isSafeInteger));
    assert.ok(result.options.every(({ atHigh }) => Number.isInteger(atHigh.pctDrop)));
  });
});

describe("computeConsequences: estimates", () => {
  const makeState = (estimate) => ({
    guestCount: 100,
    totalMinor: 100000,
    quotes: [],
    categories: [category("a", [fixed("a1", 90000)]), category("b", [estimate])],
  });
  const profile = { priorities: ["a", "b"], mustHaves: [] };

  it("keeps estimates out of committed deltas", () => {
    const state = makeState(fixed("placeholder", 0));
    const event = {
      type: "line_item_swap",
      category: "b",
      remove: "placeholder",
      add: "Band",
      price: { kind: "fixed", source: "estimate", estimate: { lowMinor: 5000, highMinor: 8000 } },
    };
    const result = computeConsequences(state, [event], profile);
    assert.deepEqual(result.deltas, []);
    assert.deepEqual(result.shortfall, { lowMinor: 0, highMinor: 0 });
    assert.equal(result.surplusMinor, 2000);
  });

  it("differs between ends, with amounts at both", () => {
    const result = computeConsequences(
      makeState(estimated("e", "fixed", 20000, 40000)),
      [],
      profile,
    );
    assert.deepEqual(result.shortfall, { lowMinor: 10000, highMinor: 30000 });
    assert.deepEqual(result.increaseBudget, { lowMinor: 10000, highMinor: 30000 });
    const [a, b] = result.options;
    assert.equal(a.atLow.cutMinor, 10000);
    assert.equal(a.atHigh.cutMinor, 30000);
    assert.equal(b.atLow.newTotalMinor, 10000);
    assert.equal(b.atHigh.newTotalMinor, 10000);
  });

  it("can be over at the high end only, so atLow is null", () => {
    const result = computeConsequences(
      makeState(estimated("e", "fixed", 5000, 20000)),
      [],
      profile,
    );
    assert.deepEqual(result.shortfall, { lowMinor: 0, highMinor: 10000 });
    assert.equal(result.surplusMinor, 0);
    assert.deepEqual(result.increaseBudget, { lowMinor: 0, highMinor: 10000 });
    assert.ok(result.options.every(({ atLow, atHigh }) => atLow === null && atHigh !== null));
  });

  it("omits a category whose cost at an end with shortfall is zero", () => {
    const result = computeConsequences(
      makeState(estimated("e", "fixed", 0, 0)),
      [{ type: "budget_total", toMinor: 80000 }],
      profile,
    );
    assert.deepEqual(
      result.options.map(({ categoryId }) => categoryId),
      ["a"],
    );
  });

  it("gives a null end when the category costs nothing only at that end", () => {
    const state = makeState(estimated("e", "fixed", 0, 5000));
    const events = [{ type: "budget_total", toMinor: 80000 }];
    const b = computeConsequences(state, events, profile).options[1];
    assert.equal(b.atLow, null);
    assert.equal(b.atHigh.newTotalMinor, 0);
    assert.equal(b.atHigh.removedEntirely, true);
    assert.equal(b.atHigh.coversShortfall, false);
  });
});

describe("computeConsequences: edge cases", () => {
  it("leaves only the budget increase when every category is locked", () => {
    const { state, profile } = workedExample();
    state.categories.forEach((item) => (item.locked = true));
    const result = computeConsequences(state, to250, profile);
    assert.deepEqual(result.options, []);
    assert.deepEqual(result.increaseBudget, { lowMinor: 12500000, highMinor: 12500000 });
  });

  it("skips one locked category, whose costs still follow the guests", () => {
    const { state, profile } = workedExample();
    state.categories[1].locked = true;
    const result = computeConsequences(state, to250, profile);
    assert.ok(!result.options.some(({ categoryId }) => categoryId === "fnb"));
    assert.ok(result.deltas.some(({ categoryId }) => categoryId === "fnb"));
  });

  it("gives a surplus and no options when there is no shortfall", () => {
    const { state, profile } = workedExample();
    const result = computeConsequences(state, [{ type: "guest_count", to: 100 }], profile);
    assert.deepEqual(result.shortfall, { lowMinor: 0, highMinor: 0 });
    assert.equal(result.surplusMinor, 25000000);
    assert.deepEqual(result.options, []);
    assert.equal(result.increaseBudget, null);
  });

  it("is neither short nor in surplus exactly on budget", () => {
    const { state, profile } = workedExample();
    const result = computeConsequences(state, [], profile);
    assert.deepEqual(result.shortfall, { lowMinor: 0, highMinor: 0 });
    assert.equal(result.surplusMinor, 0);
    assert.deepEqual(result.deltas, []);
    assert.equal(result.increaseBudget, null);
  });

  it("flags when a category alone cannot cover the shortfall", () => {
    const { state, profile } = workedExample();
    const result = computeConsequences(
      state,
      [{ type: "budget_total", toMinor: 100000000 }],
      profile,
    );
    const gifting = result.options.find(({ categoryId }) => categoryId === "gifting").atHigh;
    assert.equal(gifting.cutMinor, 10000000);
    assert.equal(gifting.removedEntirely, true);
    assert.equal(gifting.coversShortfall, false);
    assert.equal(gifting.pctDrop, 100);
  });

  it("puts unranked categories last with a null rank, keeping category order", () => {
    const { state } = workedExample();
    const profile = { priorities: ["gifting", "ghost", "decor"], mustHaves: [] };
    const result = computeConsequences(state, to250, profile);
    assert.deepEqual(
      result.options.map(({ categoryId, rank }) => [categoryId, rank]),
      [
        ["gifting", 1],
        ["decor", 2],
        ["reveal", null],
        ["fnb", null],
      ],
    );
  });

  it("works with empty priorities or no profile", () => {
    const { state } = workedExample();
    for (const profile of [{ priorities: [] }, undefined]) {
      const result = computeConsequences(state, to250, profile);
      assert.ok(result.options.every(({ rank }) => rank === null));
      assert.equal(result.options.length, 4);
    }
  });

  it("passes rejected events through and still reports", () => {
    const { state, profile } = workedExample();
    const event = { type: "guest_count", to: -1 };
    const result = computeConsequences(state, [event], profile);
    assert.equal(result.rejected.length, 1);
    assert.equal(result.after.guestCount, 200);
  });
});

describe("computeConsequences: must-have conflicts", () => {
  const tiers = [
    { id: "low", label: "low", minMinor: 1000 },
    { id: "high", label: "high", minMinor: 5000 },
  ];
  const state = {
    guestCount: 10,
    totalMinor: 5000,
    quotes: [],
    categories: [category("c", [fixed("f", 6000)], { tiers }), category("d", [perGuest("p", 1)])],
  };
  const conflicts = (totalMinor, mustHaves) =>
    computeConsequences({ ...state, totalMinor }, [], { priorities: ["c"], mustHaves }).options[0]
      .atHigh.mustHaveConflicts;

  it("ignores a must-have when the new tier still reaches it", () => {
    const mustHaves = [{ id: "m", categoryId: "c", minTierId: "low" }];
    assert.deepEqual(conflicts(4000, mustHaves), []);
  });

  it("flags a must-have whose minimum tier is above the new tier", () => {
    const mustHaves = [{ id: "m", categoryId: "c", minTierId: "high" }];
    assert.deepEqual(conflicts(4000, mustHaves), ["m"]);
  });

  it("flags when no tier qualifies at all", () => {
    const mustHaves = [{ id: "m", categoryId: "c", minTierId: "low" }];
    assert.deepEqual(conflicts(1500 - 800, mustHaves), ["m"]);
  });

  it("does not flag must-haves with no tier or in another category", () => {
    const mustHaves = [
      { id: "free", categoryId: "c", minTierId: null },
      { id: "other", categoryId: "d", minTierId: "high" },
      { id: "ghost", categoryId: "c", minTierId: "not-a-tier" },
    ];
    assert.deepEqual(conflicts(4000, mustHaves), []);
  });

  it("flags every must-have in the category when it is removed entirely", () => {
    const mustHaves = [
      { id: "free", categoryId: "c", minTierId: null },
      { id: "m", categoryId: "c", minTierId: "low" },
      { id: "other", categoryId: "d", minTierId: null },
    ];
    assert.deepEqual(conflicts(0, mustHaves), ["free", "m"]);
  });
});

describe("computeConsequences: each end stands alone", () => {
  it("can conflict with a must-have at the high end only", () => {
    const tiers = [
      { id: "low", label: "low", minMinor: 1000 },
      { id: "high", label: "high", minMinor: 5000 },
    ];
    const state = {
      guestCount: 10,
      totalMinor: 6500,
      quotes: [],
      categories: [
        category("c", [fixed("f", 6000)], { tiers }),
        category("d", [estimated("e", "fixed", 1000, 4000)]),
      ],
    };
    const mustHaves = [{ id: "m", categoryId: "c", minTierId: "high" }];
    const [option] = computeConsequences(state, [], { priorities: ["c"], mustHaves }).options;
    assert.equal(option.atLow.tierAfter.id, "high");
    assert.deepEqual(option.atLow.mustHaveConflicts, []);
    assert.equal(option.atHigh.tierAfter.id, "low");
    assert.deepEqual(option.atHigh.mustHaveConflicts, ["m"]);
  });
});

describe("computeConsequences: inputs that could skew the numbers", () => {
  it("rounds pctDrop half up", () => {
    const state = {
      guestCount: 1,
      totalMinor: 7,
      quotes: [],
      categories: [category("c", [fixed("f", 8)])],
    };
    assert.equal(computeConsequences(state, [], {}).options[0].atHigh.pctDrop, 13);
  });

  it("ranks by the cleaned ranking, so duplicates do not shift ranks or repeat options", () => {
    const { state } = workedExample();
    const profile = { priorities: ["decor", "decor", "fnb"], mustHaves: [] };
    const options = computeConsequences(state, to250, profile).options;
    assert.deepEqual(
      options.map(({ categoryId, rank }) => [categoryId, rank]),
      [
        ["decor", 1],
        ["fnb", 2],
        ["reveal", null],
        ["gifting", null],
      ],
    );
  });

  it("counts only the valid events when one in a batch is rejected", () => {
    const { state, profile } = workedExample();
    const events = [
      { type: "guest_count", to: 250 },
      { type: "budget_total", toMinor: -1 },
    ];
    const result = computeConsequences(state, events, profile);
    assert.equal(result.rejected.length, 1);
    assert.equal(result.after.totalMinor, state.totalMinor);
    assert.deepEqual(result.shortfall, { lowMinor: 12500000, highMinor: 12500000 });
  });
});
