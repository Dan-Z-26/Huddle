import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { computeBudget } from "../../server/core/budgetEngine.js";
import { buildBudgetState, missingProfileFields } from "../../server/core/profile.js";

const ORDER = [
  "name",
  "purpose",
  "date",
  "city",
  "venueType",
  "guests",
  "budget",
  "priorities",
  "attendeeExperience",
  "mustHaves",
  "absoluteMustHave",
  "constraints",
  "vendorNeeds",
];

const complete = {
  name: "Launch",
  purpose: "Reveal the product",
  date: "2027-03-12",
  city: "Pune",
  venueType: "Hotel",
  guests: { min: 200, max: 250, suggested: 263, confirmed: 250 },
  budget: { totalMinor: 160000000, currency: "INR" },
  priorities: ["a"],
  attendeeExperience: "Excited",
  mustHaves: [{ id: "m1", text: "stage" }],
  absoluteMustHaveId: "m1",
  constraints: { deadlines: [], dietary: ["vegan"], accessibility: [], brand: [], venue: [] },
  vendorNeeds: { a: "Lots" },
  skippedFields: [],
};

describe("missingProfileFields", () => {
  it("lists everything in question order for an empty profile", () => {
    assert.deepEqual(missingProfileFields({}), ORDER);
  });

  it("is empty for a complete profile", () => {
    assert.deepEqual(missingProfileFields(complete), []);
  });

  it("treats an unconfirmed guest count as missing even when a range exists", () => {
    const guests = { min: 200, max: 250, suggested: 263, confirmed: null };
    assert.deepEqual(missingProfileFields({ ...complete, guests }), ["guests"]);
  });

  it("counts blank text and a zero budget as unanswered", () => {
    const profile = { ...complete, city: "   ", budget: { totalMinor: 0, currency: "INR" } };
    assert.deepEqual(missingProfileFields(profile), ["city", "budget"]);
  });

  it("counts empty constraints as unanswered", () => {
    const constraints = { deadlines: [], dietary: [], accessibility: [], brand: [], venue: [] };
    assert.deepEqual(missingProfileFields({ ...complete, constraints }), ["constraints"]);
  });

  it("honours skipped only where 'none' is a valid answer", () => {
    const profile = {
      skippedFields: [
        "mustHaves",
        "absoluteMustHave",
        "constraints",
        "vendorNeeds",
        "guests",
        "name",
      ],
    };
    const missing = missingProfileFields(profile);
    assert.ok(missing.includes("guests"));
    assert.ok(missing.includes("name"));
    for (const field of ["mustHaves", "absoluteMustHave", "constraints", "vendorNeeds"]) {
      assert.ok(!missing.includes(field), field);
    }
  });
});

describe("buildBudgetState", () => {
  const template = {
    categories: [
      {
        id: "venue",
        name: "Venue",
        tiers: [
          { id: "small", label: "small", minBps: 2000 },
          { id: "big", label: "big", minBps: 8000 },
        ],
        drivers: [
          {
            id: "hall",
            label: "Hall",
            kind: "stepped",
            shareBps: 7000,
            steps: [
              { upToGuests: 100, shareBps: 5000 },
              { upToGuests: 300, shareBps: 10000 },
              { upToGuests: 500, shareBps: 20000 },
            ],
          },
          { id: "staff", label: "Staff", kind: "fixed", shareBps: 3000 },
        ],
      },
      {
        id: "food",
        name: "Food",
        tiers: [],
        drivers: [
          { id: "plate", label: "Plate", kind: "perGuest", shareBps: 8000 },
          { id: "setup", label: "Setup", kind: "fixed", shareBps: 2000 },
        ],
      },
      {
        id: "gifts",
        name: "Gifts",
        tiers: [],
        drivers: [{ id: "gift", label: "Gift", kind: "perGuest", shareBps: 10000 }],
      },
      {
        id: "crew",
        name: "Crew",
        tiers: [],
        drivers: [{ id: "hours", label: "Hours", kind: "perUnit", shareBps: 10000, units: 3 }],
      },
    ],
  };
  const profile = {
    guests: { confirmed: 200 },
    budget: { totalMinor: 10000, currency: "USD" },
    priorities: ["venue", "food", "gifts", "crew"],
  };

  it("throws without a confirmed guest count", () => {
    const unconfirmed = { ...profile, guests: { confirmed: null } };
    assert.throws(() => buildBudgetState(unconfirmed, template), /confirmed guest count/);
    assert.throws(() => buildBudgetState({ ...profile, guests: { confirmed: 0 } }, template));
  });

  it("carries the totals and currency, with source user and no quotes", () => {
    const state = buildBudgetState(profile, template);
    assert.equal(state.guestCount, 200);
    assert.equal(state.totalMinor, 10000);
    assert.equal(state.currency, "USD");
    assert.deepEqual(state.quotes, []);
    const drivers = state.categories.flatMap((category) => category.drivers);
    assert.ok(drivers.every((driver) => driver.source === "user"));
  });

  it("defaults the currency to INR", () => {
    const budget = { totalMinor: 10000 };
    assert.equal(buildBudgetState({ ...profile, budget }, template).currency, "INR");
  });

  it("resolves tier shares against the category allocation", () => {
    const [venue] = buildBudgetState(profile, template).categories;
    assert.deepEqual(venue.tiers, [
      { id: "small", label: "small", minMinor: 800 },
      { id: "big", label: "big", minMinor: 3200 },
    ]);
  });

  it("makes step shares relative to the step holding the confirmed count", () => {
    const [venue] = buildBudgetState(profile, template).categories;
    // Venue allocation is 4000, so the hall's part is 2800 at the 300 step.
    assert.deepEqual(venue.drivers[0].steps, [
      { upToGuests: 100, amountMinor: 1400 },
      { upToGuests: 300, amountMinor: 2800 },
      { upToGuests: 500, amountMinor: 5600 },
    ]);
  });

  it("uses the last step when the count is above every step", () => {
    const guests = { confirmed: 900 };
    const [venue] = buildBudgetState({ ...profile, guests }, template).categories;
    assert.equal(venue.drivers[0].steps.at(-1).amountMinor, 2800);
  });

  it("sends the perGuest floor leftover to the first fixed driver", () => {
    const guests = { confirmed: 7 };
    const food = buildBudgetState({ ...profile, guests }, template).categories[1];
    // Allocation 3000: plate part 2400, so 342 per guest (2394), leaving 606 on setup.
    assert.equal(food.drivers[0].unitMinor, 342);
    assert.equal(food.drivers[1].unitMinor, 606);
  });

  it("leaves the leftover in remaining when a category has no fixed driver", () => {
    const guests = { confirmed: 7 };
    const state = buildBudgetState({ ...profile, guests }, template);
    const gifts = computeBudget(state).categories[2];
    // Allocation 2000 / 7 guests is 285 each, 1995 in all.
    assert.equal(gifts.committedMinor, 1995);
    assert.ok(computeBudget(state).remainingMinor > 0);
  });

  it("prices perUnit drivers from their share", () => {
    const crew = buildBudgetState(profile, template).categories[3];
    assert.equal(crew.drivers[0].unitMinor, 333);
    assert.equal(crew.drivers[0].units, 3);
  });

  it("gives unranked categories nothing, and empty priorities spend nothing", () => {
    const state = buildBudgetState({ ...profile, priorities: ["food"] }, template);
    const budget = computeBudget(state);
    assert.equal(budget.categories[0].committedMinor, 0);
    assert.equal(budget.categories[1].committedMinor, 10000);
    const none = computeBudget(buildBudgetState({ ...profile, priorities: [] }, template));
    assert.equal(none.committedMinor, 0);
    assert.equal(none.remainingMinor, 10000);
  });

  it("does not mutate its inputs", () => {
    const profileCopy = structuredClone(profile);
    const templateCopy = structuredClone(template);
    buildBudgetState(profile, template);
    assert.deepEqual(profile, profileCopy);
    assert.deepEqual(template, templateCopy);
  });
});

describe("buildBudgetState: rankings and counts that could lose money", () => {
  const template = {
    categories: ["a", "b"].map((id) => ({
      id,
      name: id,
      tiers: [],
      drivers: [{ id: `${id}-f`, label: "F", kind: "fixed", shareBps: 10000 }],
    })),
  };
  const build = (priorities, confirmed = 10) =>
    computeBudget(
      buildBudgetState(
        { guests: { confirmed }, budget: { totalMinor: 900 }, priorities },
        template,
      ),
    );

  it("gives unknown or repeated ranks no share, so the total is still fully allocated", () => {
    const committed = (priorities) =>
      build(priorities).categories.map(({ committedMinor }) => committedMinor);
    assert.deepEqual(committed(["a", "b"]), [600, 300]);
    assert.deepEqual(committed(["ghost", "a", "a", "b"]), [600, 300]);
  });

  it("refuses a fractional or text guest count", () => {
    assert.throws(() => build(["a"], 10.5), /confirmed guest count/);
    assert.throws(() => build(["a"], "10"), /confirmed guest count/);
  });
});
