import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { computeBudget } from "../../server/core/budgetEngine.js";
import { applyChangeEvents } from "../../server/core/changeEvents.js";
import { normaliseQuote } from "../../server/core/quoteScoring.js";
import { category, estimated, fixed, perGuest } from "./fixtures.js";

const quote = (id, status, extra = {}) => ({
  id,
  categoryId: "food",
  vendorName: id,
  status,
  perGuestMinor: 1000,
  fixedMinor: 5000,
  taxBps: 0,
  ...extra,
});

const makeState = () => ({
  guestCount: 100,
  totalMinor: 1000000,
  currency: "INR",
  categories: [
    category("food", [perGuest("plate", 1000), fixed("setup", 5000)], { name: "Food" }),
    category("music", [fixed("dj", 20000, { label: "DJ" })], { name: "Music", locked: true }),
  ],
  quotes: [
    quote("q-confirmed", "confirmed", { taxBps: 1800, perGuestMinor: 333, fixedMinor: 777 }),
    quote("q-accepted", "accepted"),
    quote("q-extracted", "extracted"),
    quote("q-float", "confirmed", { perGuestMinor: 10.5 }),
    quote("q-negative", "confirmed", { fixedMinor: -100 }),
    quote("q-lost", "confirmed", { categoryId: "gone" }),
    quote("q-other", "accepted", { categoryId: "music" }),
  ],
});

const apply = (...events) => applyChangeEvents(makeState(), events);
const applyOne = (event) => apply(event).state;
const food = (state) => state.categories[0];
const music = (state) => state.categories[1];

function assertRejected(event, reasonPattern) {
  const original = makeState();
  const { state, rejected } = applyChangeEvents(original, [event]);
  assert.equal(rejected.length, 1);
  assert.deepEqual(rejected[0].event, event);
  assert.match(rejected[0].reason, reasonPattern);
  assert.deepEqual(state, original);
}

describe("guest_count", () => {
  it("applies a delta and an absolute value", () => {
    assert.equal(applyOne({ type: "guest_count", delta: 50 }).guestCount, 150);
    assert.equal(applyOne({ type: "guest_count", delta: -99 }).guestCount, 1);
    assert.equal(applyOne({ type: "guest_count", to: 250 }).guestCount, 250);
  });

  for (const event of [
    { delta: -100 },
    { delta: -500 },
    { to: 0 },
    { to: -5 },
    { to: 10.5 },
    { delta: 0.5 },
    { to: "250" },
    {},
  ]) {
    it(`rejects ${JSON.stringify(event)}`, () => {
      assertRejected({ type: "guest_count", ...event }, /guest count/);
    });
  }
});

describe("line_item_add", () => {
  const item = { label: "Live Band", kind: "fixed", unitMinor: 500, source: "user" };

  it("adds a driver with a derived id", () => {
    const added = music(applyOne({ type: "line_item_add", category: "music", item })).drivers[1];
    assert.deepEqual(added, {
      id: "live-band-1",
      label: "Live Band",
      kind: "fixed",
      unitMinor: 500,
      units: 0,
      steps: [],
      source: "user",
      estimate: null,
      unpriced: false,
    });
  });

  it("keeps a free id, and derives one when it is taken", () => {
    const event = { type: "line_item_add", category: "food" };
    const free = applyOne({ ...event, item: { ...item, id: "band" } });
    assert.equal(food(free).drivers[2].id, "band");
    const taken = applyOne({ ...event, item: { ...item, id: "plate" } });
    assert.equal(food(taken).drivers[2].id, "live-band-1");
  });

  it("counts past ids already used", () => {
    const event = { type: "line_item_add", category: "food", item };
    const { state } = apply(event, event);
    assert.deepEqual(
      food(state).drivers.map(({ id }) => id),
      ["plate", "setup", "live-band-1", "live-band-2"],
    );
  });

  it("falls back to a generic slug", () => {
    const event = { type: "line_item_add", category: "food", item: { ...item, label: "ढोल" } };
    assert.equal(food(applyOne(event)).drivers[2].id, "item-1");
  });

  it("accepts an estimate, which stays out of committed", () => {
    const estimate = { lowMinor: 100, highMinor: 200 };
    const event = {
      type: "line_item_add",
      category: "food",
      item: {
        label: "Ice",
        kind: "perUnit",
        units: 3,
        source: "estimate",
        estimate,
        unitMinor: 1.5,
      },
    };
    const state = applyOne(event);
    assert.equal(food(state).drivers[2].unitMinor, 0);
    const before = computeBudget(makeState());
    const after = computeBudget(state);
    assert.equal(after.committedMinor, before.committedMinor);
    assert.equal(after.highMinor, before.highMinor + 600);
  });

  it("accepts stepped pricing", () => {
    const steps = [
      { upToGuests: 50, amountMinor: 100 },
      { upToGuests: 150, amountMinor: 200 },
    ];
    const event = {
      type: "line_item_add",
      category: "food",
      item: { label: "Hall", kind: "stepped", steps, source: "quote" },
    };
    assert.deepEqual(food(applyOne(event)).drivers[2].steps, steps);
  });

  const invalidItems = [
    [{ ...item, label: " " }, /label/],
    [{ ...item, kind: "magic" }, /kind/],
    [{ ...item, source: "guess" }, /source/],
    [{ ...item, unitMinor: 10.5 }, /unitMinor/],
    [{ ...item, unitMinor: -1 }, /unitMinor/],
    [{ ...item, kind: "perUnit", units: -2 }, /units/],
    [{ ...item, source: "estimate" }, /estimate/],
    [{ ...item, source: "estimate", estimate: { lowMinor: 9, highMinor: 1 } }, /estimate/],
    [{ ...item, kind: "stepped", steps: [] }, /steps/],
    [
      {
        ...item,
        kind: "stepped",
        steps: [
          { upToGuests: 200, amountMinor: 1 },
          { upToGuests: 100, amountMinor: 2 },
        ],
      },
      /steps/,
    ],
    [{ ...item, kind: "stepped", steps: [{ upToGuests: 100, amountMinor: 1.5 }] }, /steps/],
  ];
  for (const [invalid, pattern] of invalidItems) {
    it(`rejects ${JSON.stringify(invalid)}`, () => {
      assertRejected({ type: "line_item_add", category: "food", item: invalid }, pattern);
    });
  }

  it("rejects an unknown category and a missing item", () => {
    assertRejected({ type: "line_item_add", category: "nope", item }, /unknown category/);
    assertRejected({ type: "line_item_add", category: "food" }, /label/);
  });
});

describe("line_item_remove", () => {
  it("removes by id", () => {
    const state = applyOne({ type: "line_item_remove", category: "food", itemId: "setup" });
    assert.deepEqual(
      food(state).drivers.map(({ id }) => id),
      ["plate"],
    );
  });

  it("rejects an unknown category or driver", () => {
    assertRejected({ type: "line_item_remove", category: "nope", itemId: "x" }, /category/);
    assertRejected({ type: "line_item_remove", category: "food", itemId: "x" }, /driver/);
    assertRejected({ type: "line_item_remove", category: "food" }, /driver/);
  });
});

describe("line_item_swap", () => {
  const swap = { type: "line_item_swap", category: "music", remove: "dj", add: "Live band" };

  it("matches the removed driver by case-insensitive label or id", () => {
    assert.equal(music(applyOne(swap)).drivers[0].label, "Live band");
    assert.equal(music(applyOne({ ...swap, remove: "DJ" })).drivers[0].label, "Live band");
  });

  it("makes an unpriced fixed estimate of 0-0 without a price", () => {
    assert.deepEqual(music(applyOne(swap)).drivers, [
      {
        id: "live-band-1",
        label: "Live band",
        kind: "fixed",
        unitMinor: 0,
        units: 0,
        steps: [],
        source: "estimate",
        estimate: { lowMinor: 0, highMinor: 0 },
        unpriced: true,
      },
    ]);
  });

  it("uses a price when given", () => {
    const price = { kind: "perUnit", unitMinor: 700, units: 3, source: "quote" };
    const [driver] = music(applyOne({ ...swap, price })).drivers;
    assert.equal(driver.kind, "perUnit");
    assert.equal(driver.unitMinor, 700);
    assert.equal(driver.units, 3);
    assert.equal(driver.source, "quote");
    assert.equal(driver.unpriced, false);
  });

  it("applies to locked categories too", () => {
    assert.ok(music(applyOne(swap)).locked);
    assert.equal(music(applyOne(swap)).drivers.length, 1);
  });

  it("rejects each kind of bad swap", () => {
    assertRejected({ ...swap, category: "nope" }, /category/);
    assertRejected({ ...swap, remove: "Violin" }, /driver/);
    assertRejected({ ...swap, add: "" }, /label/);
    assertRejected(
      { ...swap, price: { kind: "fixed", unitMinor: 1.5, source: "user" } },
      /unitMinor/,
    );
  });
});

describe("category_amount", () => {
  it("replaces all drivers with one fixed user driver", () => {
    const state = applyOne({ type: "category_amount", category: "food", amountMinor: 90000 });
    assert.deepEqual(food(state).drivers, [
      {
        id: "food-amount",
        label: "Food amount",
        kind: "fixed",
        unitMinor: 90000,
        units: 0,
        steps: [],
        source: "user",
        estimate: null,
        unpriced: false,
      },
    ]);
  });

  it("allows zero and replaces an estimate", () => {
    const state = applyOne({ type: "category_amount", category: "food", amountMinor: 0 });
    assert.equal(computeBudget(state).categories[0].committedMinor, 0);
  });

  for (const amountMinor of [-1, 10.5, "100", undefined]) {
    it(`rejects amountMinor ${amountMinor}`, () => {
      assertRejected({ type: "category_amount", category: "food", amountMinor }, /amountMinor/);
    });
  }

  it("rejects an unknown category", () => {
    assertRejected({ type: "category_amount", category: "nope", amountMinor: 1 }, /category/);
  });
});

describe("quote_accepted", () => {
  const accept = (quoteId) => ({ type: "quote_accepted", quoteId });
  const statusOf = (state, id) => state.quotes.find((candidate) => candidate.id === id).status;
  const foodCost = (state) => computeBudget(state).categories[0].committedMinor;
  const taxed = makeState().quotes[0];

  it("replaces drivers with tax-inclusive perGuest and fixed quote drivers", () => {
    const { drivers } = food(applyOne(accept("q-confirmed")));
    assert.deepEqual(
      drivers.map(({ kind, unitMinor, source }) => ({ kind, unitMinor, source })),
      [
        { kind: "perGuest", unitMinor: 393, source: "quote" },
        { kind: "fixed", unitMinor: 917, source: "quote" },
      ],
    );
  });

  it("marks the quote accepted and returns the rival in its category to confirmed", () => {
    const state = applyOne(accept("q-confirmed"));
    assert.equal(statusOf(state, "q-confirmed"), "accepted");
    assert.equal(statusOf(state, "q-accepted"), "confirmed");
    assert.equal(statusOf(state, "q-other"), "accepted");
    assert.equal(statusOf(state, "q-extracted"), "extracted");
  });

  it("can accept an already accepted quote", () => {
    assert.equal(statusOf(applyOne(accept("q-accepted")), "q-accepted"), "accepted");
  });

  it("totals exactly what normaliseQuote says, including tax", () => {
    assert.equal(foodCost(applyOne(accept("q-confirmed"))), normaliseQuote(taxed, 100).totalMinor);
  });

  it("still agrees with normaliseQuote after a later guest change", () => {
    const { state } = apply(accept("q-confirmed"), { type: "guest_count", to: 257 });
    assert.equal(foodCost(state), normaliseQuote(taxed, 257).totalMinor);
  });

  it("agrees across awkward prices, tax rates and counts", () => {
    for (const taxBps of [0, 1, 500, 1800, 2800]) {
      for (const perGuestMinor of [0, 1, 333, 99999]) {
        for (const guestCount of [1, 7, 250]) {
          const awkward = quote("q", "confirmed", { taxBps, perGuestMinor, fixedMinor: 12345 });
          const start = { ...makeState(), quotes: [awkward], guestCount };
          const { state } = applyChangeEvents(start, [accept("q")]);
          assert.equal(foodCost(state), normaliseQuote(awkward, guestCount).totalMinor);
        }
      }
    }
  });

  it("rejects unknown, unconfirmed, orphaned and malformed quotes", () => {
    assertRejected(accept("nope"), /unknown quote/);
    assertRejected(accept("q-extracted"), /confirmed/);
    assertRejected(accept("q-lost"), /unknown category/);
    assertRejected(accept("q-float"), /integers/);
    assertRejected(accept("q-negative"), /integers/);
  });

  it("rejects cleanly when the state has no quotes", () => {
    const state = { ...makeState(), quotes: undefined };
    const { rejected } = applyChangeEvents(state, [accept("q")]);
    assert.match(rejected[0].reason, /unknown quote/);
  });
});

describe("budget_total", () => {
  it("sets the total, allowing zero", () => {
    assert.equal(applyOne({ type: "budget_total", toMinor: 5 }).totalMinor, 5);
    assert.equal(applyOne({ type: "budget_total", toMinor: 0 }).totalMinor, 0);
  });

  for (const toMinor of [-1, 1.5, "5", null]) {
    it(`rejects toMinor ${toMinor}`, () => {
      assertRejected({ type: "budget_total", toMinor }, /toMinor/);
    });
  }
});

describe("applyChangeEvents", () => {
  it("rejects unknown and malformed events", () => {
    assertRejected({ type: "teleport" }, /unknown event type/);
    assertRejected({ type: "constructor" }, /unknown event type/);
    assertRejected({}, /unknown event type/);
    const { rejected } = apply(null);
    assert.match(rejected[0].reason, /unknown event type/);
  });

  it("does nothing for no events", () => {
    assert.deepEqual(applyChangeEvents(makeState(), []), { state: makeState(), rejected: [] });
  });

  it("applies valid events around a rejected one, each seeing the last", () => {
    const { state, rejected } = apply(
      { type: "guest_count", delta: 50 },
      { type: "guest_count", delta: -1000 },
      { type: "guest_count", delta: 50 },
    );
    assert.equal(state.guestCount, 200);
    assert.equal(rejected.length, 1);
  });

  it("recomputes stepped and estimate drivers with the guest count", () => {
    const stepped = {
      id: "hall",
      label: "Hall",
      kind: "stepped",
      source: "user",
      steps: [
        { upToGuests: 100, amountMinor: 1000 },
        { upToGuests: 300, amountMinor: 2000 },
      ],
    };
    const start = {
      ...makeState(),
      categories: [category("c", [stepped, estimated("e", "perGuest", 1, 2)])],
    };
    const { state } = applyChangeEvents(start, [{ type: "guest_count", to: 101 }]);
    const budget = computeBudget(state);
    assert.equal(budget.committedMinor, 2000);
    assert.equal(budget.lowMinor, 2101);
    assert.equal(budget.highMinor, 2202);
  });

  it("ignores confidence", () => {
    assert.equal(applyOne({ type: "guest_count", to: 5, confidence: 0 }).guestCount, 5);
  });

  it("never mutates the input, and the result shares nothing with it", () => {
    const original = makeState();
    const events = [
      { type: "guest_count", delta: 10 },
      { type: "line_item_remove", category: "food", itemId: "plate" },
      { type: "line_item_swap", category: "music", remove: "dj", add: "Band" },
      { type: "category_amount", category: "food", amountMinor: 1 },
      { type: "quote_accepted", quoteId: "q-confirmed" },
      { type: "budget_total", toMinor: 1 },
    ];
    const eventsCopy = structuredClone(events);
    const { state } = applyChangeEvents(original, events);
    assert.deepEqual(original, makeState());
    assert.deepEqual(events, eventsCopy);
    state.categories[1].tiers.push("x");
    state.quotes[1].vendorName = "changed";
    assert.deepEqual(original, makeState());
  });
});

describe("money paths a single-driver fixture hides", () => {
  it("swaps one driver in place and leaves the others priced", () => {
    const event = { type: "line_item_swap", category: "food", remove: "plate", add: "Buffet" };
    const price = { kind: "fixed", unitMinor: 700, source: "quote" };
    const state = applyOne({ ...event, price });
    assert.deepEqual(
      food(state).drivers.map(({ id, unitMinor }) => [id, unitMinor]),
      [
        ["buffet-1", 700],
        ["setup", 5000],
      ],
    );
    assert.equal(computeBudget(state).categories[0].committedMinor, 5700);
  });

  it("commits an accepted quote in place of an estimate, closing the range", () => {
    const start = makeState();
    start.categories[0].drivers = [estimated("guess", "perGuest", 1, 99999)];
    const { state } = applyChangeEvents(start, [{ type: "quote_accepted", quoteId: "q-accepted" }]);
    const [row] = computeBudget(state).categories;
    assert.deepEqual(row, {
      id: "food",
      name: "Food",
      committedMinor: 105000,
      lowMinor: 105000,
      highMinor: 105000,
    });
  });

  it("lets a locked category take amount and quote changes", () => {
    const events = [
      [{ type: "category_amount", category: "music", amountMinor: 1 }, 1],
      [{ type: "quote_accepted", quoteId: "q-other" }, 105000],
    ];
    for (const [event, expected] of events) {
      const state = applyOne(event);
      assert.equal(music(state).locked, true);
      assert.equal(computeBudget(state).categories[1].committedMinor, expected);
    }
  });

  it("does not let a later edit to the event change the stored driver", () => {
    const steps = [{ upToGuests: 500, amountMinor: 100 }];
    const estimate = { lowMinor: 1, highMinor: 2 };
    const stepped = { label: "Hall", kind: "stepped", steps, source: "user" };
    const guessed = { label: "Ice", kind: "fixed", source: "estimate", estimate };
    const { state } = apply(
      { type: "line_item_add", category: "food", item: stepped },
      { type: "line_item_add", category: "food", item: guessed },
    );
    steps[0].amountMinor = 999;
    estimate.highMinor = 999;
    assert.equal(food(state).drivers[2].steps[0].amountMinor, 100);
    assert.equal(food(state).drivers[3].estimate.highMinor, 2);
  });
});

describe("hostile input", () => {
  const state = {
    guestCount: 100,
    totalMinor: 1000000,
    currency: "INR",
    quotes: [],
    categories: [{ id: "fnb", name: "F&B", locked: false, tiers: [], drivers: [] }],
  };
  const reasonFor = (event) => applyChangeEvents(state, [event]).rejected[0]?.reason;

  it("rejects guest counts and amounts too large to add up safely", () => {
    assert.ok(reasonFor({ type: "guest_count", to: 100001 }));
    assert.ok(reasonFor({ type: "guest_count", delta: Number.MAX_SAFE_INTEGER }));
    assert.ok(reasonFor({ type: "budget_total", toMinor: 1e12 }));
    assert.ok(reasonFor({ type: "category_amount", category: "fnb", amountMinor: 1e12 }));
  });

  it("keeps the biggest allowed per-guest price and guest count within safe integers", () => {
    const item = { kind: "perGuest", label: "Plates", unitMinor: 5e10, source: "user" };
    const added = applyChangeEvents(state, [
      { type: "line_item_add", category: "fnb", item },
      { type: "guest_count", to: 100000 },
    ]);
    assert.deepEqual(added.rejected, []);
    assert.ok(Number.isSafeInteger(computeBudget(added.state).committedMinor));
  });

  it("rejects a non-string item id instead of throwing", () => {
    assert.ok(reasonFor({ type: "line_item_remove", category: "fnb", itemId: { toString: 1 } }));
    assert.ok(reasonFor({ type: "line_item_swap", category: "fnb", remove: 7, add: "x" }));
  });
});
