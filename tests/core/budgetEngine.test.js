import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  allocate,
  categoryCost,
  computeBudget,
  driverCost,
  stepFor,
  tierForCost,
} from "../../server/core/budgetEngine.js";
import { category, estimated, fixed, minorValues, perGuest } from "./fixtures.js";

const sumOf = (allocation) => Object.values(allocation).reduce((sum, minor) => sum + minor, 0);
const same = (minor) => ({ committedMinor: minor, lowMinor: minor, highMinor: minor });

describe("allocate", () => {
  it("weights by rank using the plan's 4/3/2/1 shares", () => {
    assert.deepEqual(allocate(1000, ["a", "b", "c", "d"]), { a: 400, b: 300, c: 200, d: 100 });
  });

  it("sums exactly with 1000 paise over 3 categories", () => {
    assert.deepEqual(allocate(1000, ["a", "b", "c"]), { a: 500, b: 333, c: 167 });
  });

  it("sums exactly with 1000 paise over 7 categories", () => {
    assert.deepEqual(allocate(1000, ["a", "b", "c", "d", "e", "f", "g"]), {
      a: 250,
      b: 214,
      c: 179,
      d: 143,
      e: 107,
      f: 71,
      g: 36,
    });
  });

  it("always sums exactly and gives only integers", () => {
    const ids = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k"];
    for (let count = 1; count <= ids.length; count += 1) {
      for (const total of [0, 1, 7, 99, 1000, 160000000, 333333333, 100000000001]) {
        const allocation = allocate(total, ids.slice(0, count));
        assert.equal(sumOf(allocation), total);
        assert.ok(Object.values(allocation).every(Number.isSafeInteger));
      }
    }
  });

  it("gives ties in the remainder to the higher rank", () => {
    assert.deepEqual(allocate(1, ["a", "b"]), { a: 1, b: 0 });
  });

  it("returns nothing for empty priorities", () => {
    assert.deepEqual(allocate(1000, []), {});
  });

  it("gives a single category the whole total", () => {
    assert.deepEqual(allocate(1000, ["a"]), { a: 1000 });
  });

  it("handles a zero total and ignores duplicates", () => {
    assert.deepEqual(allocate(0, ["a", "b"]), { a: 0, b: 0 });
    assert.deepEqual(allocate(300, ["a", "b", "a"]), { a: 200, b: 100 });
  });

  it("rejects negative and fractional totals", () => {
    assert.throws(() => allocate(-1, ["a"]), RangeError);
    assert.throws(() => allocate(10.5, ["a"]), RangeError);
  });
});

describe("driverCost", () => {
  it("prices each kind", () => {
    assert.deepEqual(driverCost(fixed("f", 500), 200), same(500));
    assert.deepEqual(driverCost(perGuest("p", 500), 200), same(100000));
    assert.deepEqual(driverCost({ kind: "perUnit", unitMinor: 500, units: 3 }, 200), same(1500));
  });

  it("is zero for zero guests and treats negative guests as zero", () => {
    assert.deepEqual(driverCost(perGuest("p", 500), 0), same(0));
    assert.deepEqual(driverCost(perGuest("p", 500), -10), same(0));
  });

  const stepped = {
    kind: "stepped",
    source: "user",
    steps: [
      { upToGuests: 100, amountMinor: 1000 },
      { upToGuests: 300, amountMinor: 2000 },
    ],
  };

  const steppedCases = [
    [1, 1000, "below the first boundary"],
    [100, 1000, "at the first boundary"],
    [101, 2000, "just above the first boundary"],
    [300, 2000, "at the last boundary"],
    [301, 2000, "above the last step, which keeps the last amount"],
  ];
  for (const [guests, expected, name] of steppedCases) {
    it(`prices a stepped driver ${name}`, () => {
      assert.deepEqual(driverCost(stepped, guests), same(expected));
    });
  }

  it("prices a stepped driver with no steps at zero", () => {
    assert.deepEqual(driverCost({ ...stepped, steps: [] }, 50), same(0));
  });

  it("keeps estimates out of committed, scaling by kind", () => {
    assert.deepEqual(driverCost(estimated("e", "fixed", 100, 300), 10), {
      committedMinor: 0,
      lowMinor: 100,
      highMinor: 300,
    });
    assert.deepEqual(driverCost(estimated("e", "perGuest", 100, 300), 10), {
      committedMinor: 0,
      lowMinor: 1000,
      highMinor: 3000,
    });
    assert.deepEqual(driverCost(estimated("e", "perUnit", 100, 300, { units: 4 }), 10), {
      committedMinor: 0,
      lowMinor: 400,
      highMinor: 1200,
    });
    assert.deepEqual(driverCost(estimated("e", "stepped", 100, 300), 10), {
      committedMinor: 0,
      lowMinor: 100,
      highMinor: 300,
    });
  });

  it("rejects an unknown kind", () => {
    assert.throws(() => driverCost({ kind: "magic", source: "user" }, 1), RangeError);
  });
});

describe("stepFor", () => {
  it("returns undefined with no steps", () => assert.equal(stepFor([], 5), undefined));
});

describe("categoryCost", () => {
  it("sums drivers, and an empty category costs nothing", () => {
    const mixed = category("c", [
      fixed("f", 100),
      perGuest("p", 10),
      estimated("e", "fixed", 5, 9),
    ]);
    assert.deepEqual(categoryCost(mixed, 10), {
      committedMinor: 200,
      lowMinor: 205,
      highMinor: 209,
    });
    assert.deepEqual(categoryCost(category("empty", []), 10), same(0));
  });
});

describe("computeBudget", () => {
  const state = {
    guestCount: 10,
    totalMinor: 1000,
    currency: "INR",
    quotes: [],
    categories: [
      category("a", [fixed("f", 300)], { name: "A" }),
      category("b", [estimated("e", "perGuest", 10, 20)], { name: "B" }),
    ],
  };

  it("keeps estimates out of committed and adds them at each end", () => {
    assert.deepEqual(computeBudget(state), {
      categories: [
        { id: "a", name: "A", committedMinor: 300, lowMinor: 300, highMinor: 300 },
        { id: "b", name: "B", committedMinor: 0, lowMinor: 100, highMinor: 200 },
      ],
      committedMinor: 300,
      lowMinor: 400,
      highMinor: 500,
      totalMinor: 1000,
      remainingMinor: 700,
    });
  });

  it("gives negative remaining when over budget", () => {
    assert.equal(computeBudget({ ...state, totalMinor: 100 }).remainingMinor, -200);
  });

  it("only ever produces integers", () => {
    assert.ok(minorValues(computeBudget(state)).every(Number.isSafeInteger));
  });
});

describe("tierForCost", () => {
  const tiers = [
    { id: "top", minMinor: 400 },
    { id: "low", minMinor: 100 },
  ];

  it("picks the highest qualifying tier, in any order", () => {
    assert.equal(tierForCost(tiers, 500).id, "top");
    assert.equal(tierForCost(tiers, 400).id, "top");
    assert.equal(tierForCost(tiers, 399).id, "low");
    assert.equal(tierForCost(tiers, 100).id, "low");
  });

  it("is null when none qualifies or there are no tiers", () => {
    assert.equal(tierForCost(tiers, 99), null);
    assert.equal(tierForCost([], 500), null);
  });
});
