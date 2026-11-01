import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { flowOf, groupByMonth } from "../../public/js/timeline/timelineView.js";

const task = (id, dueDate, extra = {}) => ({
  id,
  title: id,
  dueDate,
  status: "todo",
  atRisk: false,
  source: "milestone",
  ...extra,
});

describe("flowOf", () => {
  it("names the next open task and counts what is done and at risk", () => {
    const flow = flowOf([
      task("brief", "2026-11-01T00:00:00.000Z", { status: "done" }),
      task("venue", "2026-11-05T00:00:00.000Z", { atRisk: true }),
      task("day", "2027-01-15T00:00:00.000Z"),
    ]);
    assert.equal(flow.next.id, "venue");
    assert.equal(flow.progress, "1 of 3 done, 1 at risk");
  });

  it("puts only milestones on the rail, so directive tasks can't crowd it", () => {
    const flow = flowOf([
      task("directive", "2026-11-01T00:00:00.000Z", { source: "directive" }),
      task("venue", "2026-11-05T00:00:00.000Z"),
    ]);
    assert.deepEqual(
      flow.steps.map(({ id }) => id),
      ["venue"],
    );
    assert.equal(flow.next.id, "directive");
    assert.equal(flow.nextStepId, "venue");
  });

  it("has no next task once everything is done", () => {
    const flow = flowOf([task("a", "2026-11-01T00:00:00.000Z", { status: "done" })]);
    assert.equal(flow.next, null);
    assert.equal(flow.nextStepId, null);
    assert.equal(flow.progress, "1 of 1 done");
  });
});

describe("groupByMonth", () => {
  it("keeps date order and starts a new group each month, across a year end", () => {
    const groups = groupByMonth([
      task("a", "2026-12-01T00:00:00.000Z"),
      task("b", "2026-12-31T00:00:00.000Z"),
      task("c", "2027-01-01T00:00:00.000Z"),
    ]);
    assert.deepEqual(
      groups.map(({ label, tasks }) => [label, tasks.map(({ id }) => id)]),
      [
        ["December 2026", ["a", "b"]],
        ["January 2027", ["c"]],
      ],
    );
  });

  it("returns nothing for no tasks", () => {
    assert.deepEqual(groupByMonth([]), []);
  });
});
