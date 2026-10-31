import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  flagAtRisk,
  planTimeline,
  replanTimeline,
  taskFromDirective,
} from "../../server/core/timelinePlanner.js";

const milestones = [
  { id: "brief", title: "Brief", daysBefore: 90, ownerGroupSlug: "core-team" },
  { id: "contracts", title: "Contracts", daysBefore: 30, ownerGroupSlug: "core-team" },
  { id: "event", title: "Event day", daysBefore: 0, ownerGroupSlug: "announcements" },
];
const groups = { "core-team": "g1", announcements: "g2" };
const NOW = "2027-01-01T15:30:00.000Z";
const day = (date) => `${date}T00:00:00.000Z`;

describe("planTimeline", () => {
  it("plans backward from the event date", () => {
    const tasks = planTimeline("2027-06-01", milestones, NOW, groups);
    assert.deepEqual(tasks[0], {
      id: "task-brief",
      title: "Brief",
      ownerGroupId: "g1",
      ownerUserId: null,
      dueDate: day("2027-03-03"),
      atRisk: false,
      status: "todo",
      source: "milestone",
      daysBefore: 90,
    });
    assert.equal(tasks[2].dueDate, day("2027-06-01"));
    assert.equal(tasks[2].ownerGroupId, "g2");
  });

  it("clamps past milestones to today and flags them", () => {
    const [brief, contracts, event] = planTimeline("2027-02-10", milestones, NOW, groups);
    assert.equal(brief.dueDate, day("2027-01-01"));
    assert.equal(brief.atRisk, true);
    assert.equal(contracts.dueDate, day("2027-01-11"));
    assert.equal(contracts.atRisk, false);
    assert.equal(event.atRisk, false);
  });

  it("does not flag a milestone due exactly today, whatever the time of day", () => {
    const [, contracts] = planTimeline("2027-01-31T23:00:00.000Z", milestones, NOW, groups);
    assert.equal(contracts.dueDate, day("2027-01-01"));
    assert.equal(contracts.atRisk, false);
  });

  it("clamps everything for an event in the past", () => {
    const tasks = planTimeline("2026-01-01", milestones, NOW, groups);
    assert.ok(tasks.every(({ atRisk, dueDate }) => atRisk && dueDate === day("2027-01-01")));
  });

  it("handles leap years and year ends in UTC", () => {
    const [contracts] = planTimeline("2028-03-01", [milestones[1]], "2027-01-01", groups);
    assert.equal(contracts.dueDate, day("2028-01-31"));
  });

  it("gives a null owner for an unknown slug and nothing for no milestones", () => {
    assert.equal(planTimeline("2027-06-01", milestones, NOW, {})[0].ownerGroupId, null);
    assert.deepEqual(planTimeline("2027-06-01", [], NOW, groups), []);
  });

  it("rejects invalid dates", () => {
    assert.throws(() => planTimeline("soon", milestones, NOW, groups), RangeError);
    assert.throws(() => planTimeline("2027-06-01", milestones, "now", groups), RangeError);
  });
});

describe("flagAtRisk", () => {
  const task = (extra) => ({ id: "t", status: "todo", atRisk: false, ...extra });

  it("flags a task due before today but not one due today", () => {
    const [late, today, later] = flagAtRisk(
      [
        task({ dueDate: day("2026-12-31") }),
        task({ dueDate: day("2027-01-01") }),
        task({ dueDate: day("2027-01-02") }),
      ],
      NOW,
    );
    assert.equal(late.atRisk, true);
    assert.equal(today.atRisk, false);
    assert.equal(later.atRisk, false);
  });

  it("never flags a done task and clears its flag", () => {
    const [done] = flagAtRisk(
      [task({ dueDate: day("2020-01-01"), status: "done", atRisk: true })],
      NOW,
    );
    assert.equal(done.atRisk, false);
  });

  it("keeps a clamped task flagged even though it is due today", () => {
    const tasks = planTimeline("2027-02-10", milestones, NOW, groups);
    assert.equal(flagAtRisk(tasks, NOW)[0].atRisk, true);
  });

  it("does not mutate its input", () => {
    const tasks = [task({ dueDate: day("2020-01-01") })];
    const result = flagAtRisk(tasks, NOW);
    assert.equal(tasks[0].atRisk, false);
    assert.notEqual(result[0], tasks[0]);
  });
});

describe("replanTimeline", () => {
  const planned = planTimeline("2027-06-01", milestones, NOW, groups);
  const directiveTask = {
    id: "task-d1",
    title: "Send specs",
    ownerGroupId: "g1",
    ownerUserId: "u1",
    dueDate: day("2027-02-01"),
    status: "todo",
    atRisk: false,
    source: "directive",
    daysBefore: null,
  };

  it("moves milestones using daysBefore", () => {
    const [brief] = replanTimeline(planned, "2027-07-01", NOW);
    assert.equal(brief.dueDate, day("2027-04-02"));
  });

  it("keeps status, and keeps non-milestone tasks where they are", () => {
    const tasks = [{ ...planned[0], status: "done" }, directiveTask];
    const [brief, directive] = replanTimeline(tasks, "2027-07-01", NOW);
    assert.equal(brief.status, "done");
    assert.deepEqual(directive, directiveTask);
  });

  it("clamps and flags when the event moves sooner", () => {
    const [brief, contracts] = replanTimeline(planned, "2027-02-10", NOW);
    assert.equal(brief.dueDate, day("2027-01-01"));
    assert.equal(brief.atRisk, true);
    assert.equal(contracts.atRisk, false);
  });

  it("clears a clamp flag when the event moves later", () => {
    const clamped = planTimeline("2027-02-10", milestones, NOW, groups);
    const [brief] = replanTimeline(clamped, "2027-07-01", NOW);
    assert.equal(brief.atRisk, false);
  });

  it("does not flag or clamp done milestones", () => {
    const [brief] = replanTimeline([{ ...planned[0], status: "done" }], "2027-02-10", NOW);
    assert.equal(brief.atRisk, false);
    assert.equal(brief.dueDate, day("2026-11-12"));
  });

  it("flags a late non-milestone task", () => {
    const late = { ...directiveTask, dueDate: day("2026-12-01") };
    assert.equal(replanTimeline([late], "2027-07-01", NOW)[0].atRisk, true);
  });

  it("does not mutate its input", () => {
    const copy = structuredClone(planned);
    replanTimeline(planned, "2027-02-10", NOW);
    assert.deepEqual(planned, copy);
  });
});

describe("taskFromDirective", () => {
  const details = { title: "Send specs", ownerGroupId: "g1", dueDate: day("2027-02-01") };

  it("derives the id and owns the task when one person is addressed", () => {
    const task = taskFromDirective({ id: "d1", addressedUserIds: ["u1"] }, details);
    assert.deepEqual(task, {
      id: "task-d1",
      title: "Send specs",
      ownerGroupId: "g1",
      ownerUserId: "u1",
      dueDate: day("2027-02-01"),
      status: "todo",
      atRisk: false,
      source: "directive",
      daysBefore: null,
    });
  });

  it("leaves the owner to the group with several or no addressees", () => {
    const several = { id: "d1", addressedUserIds: ["u1", "u2"] };
    assert.equal(taskFromDirective(several, details).ownerUserId, null);
    const none = { id: "d1", addressedUserIds: [] };
    assert.equal(taskFromDirective(none, details).ownerUserId, null);
  });
});
