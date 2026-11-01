import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  bookedTasks,
  managerChecklist,
  pipelineStage,
  quotesToReview,
  quoteWarnings,
  scoreReasons,
} from "../../server/core/hiring.js";

const quote = (status) => ({ status });
const context = {
  eventId: "e",
  categoryId: "pr",
  groupId: "g",
  eventDateIso: "2027-03-01T00:00:00.000Z",
  nowIso: "2027-02-20T09:00:00.000Z",
};

describe("pipelineStage", () => {
  it("follows what has actually happened", () => {
    assert.equal(pipelineStage({}), "needed");
    assert.equal(pipelineStage({ brief: { status: "pending" } }), "needed");
    const brief = { status: "approved" };
    assert.equal(pipelineStage({ brief }), "brief-approved");
    assert.equal(pipelineStage({ brief, quotes: [quote("extracted")] }), "brief-approved");
    assert.equal(pipelineStage({ brief, quotes: [quote("confirmed")] }), "quotes-received");
    assert.equal(
      pipelineStage({ brief, quotes: [quote("confirmed"), quote("confirmed")] }),
      "shortlisted",
    );
    const booked = { brief, quotes: [quote("accepted"), quote("confirmed")] };
    assert.equal(pipelineStage(booked), "booked");
    const contract = { id: "x-contract", status: "done" };
    assert.equal(pipelineStage({ ...booked, tasks: [contract] }), "confirmed");
    assert.equal(
      pipelineStage({ ...booked, tasks: [contract], deliverables: [{ done: true }] }),
      "delivered",
    );
    assert.equal(pipelineStage({ ...booked, deliverables: [{ done: false }] }), "booked");
  });
});

describe("managerChecklist", () => {
  it("ticks the first steps itself and leaves the rest to their tasks", () => {
    const steps = managerChecklist({
      brief: { status: "approved" },
      quotes: [quote("confirmed"), quote("confirmed")],
      tasks: [
        { id: "e-task-hire-pr-visit", status: "done" },
        { id: "e-task-hire-pr-contract", status: "todo" },
      ],
    });
    const done = Object.fromEntries(steps.map(({ key, done: isDone }) => [key, isDone]));
    assert.deepEqual(done, {
      brief: true,
      quotes: true,
      shortlist: true,
      visit: true,
      contract: false,
      deposit: false,
      headcount: false,
      arrival: false,
    });
    assert.equal(steps.find(({ key }) => key === "contract").taskId, "e-task-hire-pr-contract");
    assert.equal(steps.find(({ key }) => key === "deposit").taskId, null);
  });
});

describe("bookedTasks", () => {
  it("plans back from the event, never into the past", () => {
    const tasks = bookedTasks(context, "Northstar");
    assert.ok(
      tasks.every(({ source, title }) => source === "vendor" && title.includes("Northstar")),
    );
    const due = tasks.map(({ dueDate }) => dueDate.slice(0, 10));
    assert.equal(due[0], "2027-02-20", "a deadline already gone clamps to today");
    assert.equal(due.at(-1), "2027-02-27");
  });
});

describe("quoteWarnings", () => {
  const money = (minor) => `₹${minor / 100}`;
  const base = { guestCount: 200, totalMinor: 100, planMinor: 100, money };

  it("is quiet about a clean quote within plan", () => {
    assert.deepEqual(quoteWarnings({ taxStated: true }, base), []);
  });

  it("flags hidden costs, a minimum guest count and going over plan", () => {
    const found = quoteWarnings(
      { taxStated: false, minGuests: 300, perGuestMinor: 10000, exclusions: ["Crockery"] },
      { ...base, totalMinor: 150 },
    );
    assert.match(found[0], /Taxes aren't stated/);
    assert.match(found[1], /Minimum 300 guests.*₹10000/);
    assert.match(found[2], /Crockery/);
    assert.match(found[3], /over this category's plan/);
  });
});

describe("scoreReasons", () => {
  const context = { cheapestMinor: 5, mustHaveCount: 2 };

  it("says why, in words", () => {
    assert.deepEqual(scoreReasons({ totalMinor: 5, mustHaveFit: 100 }, context), [
      "Lowest total.",
      "Meets 100% of your must-haves.",
    ]);
    assert.deepEqual(scoreReasons({ totalMinor: 9, mustHaveFit: 50 }, context), [
      "Meets 50% of your must-haves.",
    ]);
  });

  it("claims nothing about must-haves when there are none", () => {
    const [reason] = scoreReasons(
      { totalMinor: 9, mustHaveFit: 100 },
      { ...context, mustHaveCount: 0 },
    );
    assert.match(reason, /no must-haves/);
  });

  it("doesn't call a total without tax simply the lowest", () => {
    const [reason] = scoreReasons(
      { totalMinor: 5, mustHaveFit: 100 },
      { ...context, taxStated: false },
    );
    assert.match(reason, /as stated, without tax/);
  });
});

describe("quotesToReview", () => {
  const quote = (categoryId, status) => ({ categoryId, status });

  it("counts confirmed quotes per category, and nothing that is still being checked", () => {
    assert.deepEqual(
      quotesToReview([
        quote("pr", "confirmed"),
        quote("pr", "confirmed"),
        quote("pr", "extracted"),
        quote("decor", "confirmed"),
      ]),
      [
        { categoryId: "pr", count: 2 },
        { categoryId: "decor", count: 1 },
      ],
    );
    assert.deepEqual(quotesToReview([]), []);
  });

  it("drops a category once one of its quotes is accepted", () => {
    assert.deepEqual(
      quotesToReview([quote("pr", "confirmed"), quote("pr", "accepted"), quote("av", "confirmed")]),
      [{ categoryId: "av", count: 1 }],
    );
  });
});
