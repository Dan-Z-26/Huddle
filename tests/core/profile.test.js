import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { computeBudget } from "../../server/core/budgetEngine.js";
import { buildBudgetState, emptyProfile, missingProfileFields } from "../../server/core/profile.js";

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
      { id: "small", label: "small", minMinor: 553 },
      { id: "big", label: "big", minMinor: 2215 },
    ]);
  });

  it("makes step shares relative to the step holding the confirmed count", () => {
    const [venue] = buildBudgetState(profile, template).categories;
    // 10% is set aside. Of the 9000 left, the top rank gets 160/520: 2769, so the hall's part is
    // 1938 at the 300 step.
    assert.deepEqual(venue.drivers[0].steps, [
      { upToGuests: 100, amountMinor: 969 },
      { upToGuests: 300, amountMinor: 1938 },
      { upToGuests: 500, amountMinor: 3876 },
    ]);
  });

  it("uses the last step when the count is above every step", () => {
    const guests = { confirmed: 900 };
    const [venue] = buildBudgetState({ ...profile, guests }, template).categories;
    assert.equal(venue.drivers[0].steps.at(-1).amountMinor, 1938);
  });

  it("sends the perGuest floor leftover to the first fixed driver", () => {
    const guests = { confirmed: 7 };
    const food = buildBudgetState({ ...profile, guests }, template).categories[1];
    // Allocation 2423: plate part 1938, so 276 per guest (1932), leaving 491 on setup.
    assert.equal(food.drivers[0].unitMinor, 276);
    assert.equal(food.drivers[1].unitMinor, 491);
  });

  it("leaves the leftover in remaining when a category has no fixed driver", () => {
    const guests = { confirmed: 7 };
    const state = buildBudgetState({ ...profile, guests }, template);
    const gifts = computeBudget(state).categories[2];
    // Allocation 2077 / 7 guests is 296 each, 2072 in all.
    assert.equal(gifts.committedMinor, 2072);
    assert.ok(computeBudget(state).remainingMinor > 0);
  });

  it("prices perUnit drivers from their share", () => {
    const crew = buildBudgetState(profile, template).categories[3];
    assert.equal(crew.drivers[0].unitMinor, 577);
    assert.equal(crew.drivers[0].units, 3);
  });

  it("gives unranked categories a smaller share, and funds everything with no ranking at all", () => {
    const budget = computeBudget(buildBudgetState({ ...profile, priorities: ["food"] }, template));
    const [venue, food] = budget.categories;
    assert.ok(venue.committedMinor > 0);
    assert.ok(food.committedMinor > venue.committedMinor);
    const none = computeBudget(buildBudgetState({ ...profile, priorities: [] }, template));
    assert.ok(none.categories.every(({ committedMinor }) => committedMinor > 0));
  });

  it("sets the buffer aside before planning", () => {
    const budget = computeBudget(buildBudgetState(profile, template));
    assert.equal(budget.contingency.reservedMinor, 1000);
    assert.ok(budget.committedMinor <= 9000);
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

  it("gives unknown or repeated ranks no share, so all but the buffer is still allocated", () => {
    const committed = (priorities) =>
      build(priorities).categories.map(({ committedMinor }) => committedMinor);
    assert.deepEqual(committed(["a", "b"]), [498, 312]);
    assert.deepEqual(committed(["ghost", "a", "a", "b"]), [498, 312]);
  });

  it("refuses a fractional or text guest count", () => {
    assert.throws(() => build(["a"], 10.5), /confirmed guest count/);
    assert.throws(() => build(["a"], "10"), /confirmed guest count/);
  });
});

describe("emptyProfile", () => {
  it("starts with every field unanswered, in question order", () => {
    assert.deepEqual(missingProfileFields(emptyProfile("wedding", "e1")), ORDER);
  });

  it("carries the event type and id, and does not share nested objects between profiles", () => {
    const first = emptyProfile("wedding", "e1");
    const second = emptyProfile("birthday", "e2");
    first.constraints.dietary.push("veg");
    first.priorities.push("venue");
    assert.deepEqual([first.eventType, first.id], ["wedding", "e1"]);
    assert.deepEqual(second.constraints.dietary, []);
    assert.deepEqual(second.priorities, []);
    assert.equal(second.budget.currency, "INR");
  });
});
