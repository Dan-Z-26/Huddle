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

const same = (minor) => ({ committedMinor: minor, lowMinor: minor, highMinor: minor });

describe("allocate", () => {
  const cats = (...pairs) => pairs.map(([id, typicalBps]) => ({ id, typicalBps }));
  const even = cats(["a", 2500], ["b", 2500], ["c", 2500], ["d", 2500]);

  it("gives more to what is ranked higher, from the same starting share", () => {
    const split = allocate(1000000, even, ["c", "a", "d", "b"]);
    assert.ok(split.c > split.a && split.a > split.d && split.d > split.b);
  });

  it("starts from the event type's usual shares, not an even split", () => {
    const split = allocate(1000000, cats(["food", 4000], ["cake", 1000]), ["cake", "food"]);
    // Cake is ranked first, but food usually costs far more.
    assert.ok(split.food > split.cake);
    assert.ok(split.cake > 1000000 * 0.2, "ranking first still lifts it above its usual 20%");
  });

  it("never leaves an unranked category at zero", () => {
    const split = allocate(1000000, even, ["a"]);
    assert.ok(split.b > 0 && split.c > 0 && split.d > 0);
    assert.ok(split.a > split.b);
  });

  it("works with nothing ranked, on usual shares alone", () => {
    assert.deepEqual(allocate(1000, cats(["a", 3000], ["b", 1000]), []), { a: 750, b: 250 });
  });

  it("sums exactly, even at the largest budget", () => {
    for (const total of [0, 1, 7, 999, 1000001, 5e10]) {
      const split = allocate(total, even, ["a", "b", "c", "d"]);
      assert.equal(
        Object.values(split).reduce((sum, minor) => sum + minor, 0),
        total,
      );
    }
  });

  it("ignores repeated and unknown ranks", () => {
    assert.deepEqual(
      allocate(1000, even, ["a", "ghost", "a", "b"]),
      allocate(1000, even, ["a", "b"]),
    );
  });

  it("has no share to give when there are no categories", () => {
    assert.deepEqual(allocate(1000, [], ["a"]), {});
  });

  it("rejects a negative or fractional total", () => {
    assert.throws(() => allocate(-1, even, []), RangeError);
    assert.throws(() => allocate(10.5, even, []), RangeError);
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
      contingency: { reservedMinor: 0, spentMinor: 0, availableMinor: 0 },
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
