import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ackStatus, attentionFor, overdue } from "../../server/core/directives.js";

const members = ["u1", "u2", "u3", "u4"].map((id) => ({ id, name: id }));
const CREATED = "2027-01-01T10:00:00.000Z";
const directive = (extra = {}) => ({
  id: "d1",
  addressedUserIds: ["u1", "u2", "u3", "u4"],
  acks: [],
  createdAt: CREATED,
  remindedAt: null,
  ...extra,
});
const acks = (...ids) => ids.map((userId) => ({ userId, at: CREATED }));

describe("ackStatus", () => {
  it("reports 3 of 4 with who is pending", () => {
    const status = ackStatus(directive({ acks: acks("u1", "u2", "u4") }), members);
    assert.deepEqual(status, {
      acked: ["u1", "u2", "u4"],
      pending: ["u3"],
      label: "3 of 4 acknowledged",
    });
  });

  it("handles a directive with no addressed members", () => {
    assert.deepEqual(ackStatus(directive({ addressedUserIds: [] }), members), {
      acked: [],
      pending: [],
      label: "0 of 0 acknowledged",
    });
  });

  it("handles no group members", () => {
    assert.equal(ackStatus(directive(), []).label, "0 of 0 acknowledged");
  });

  it("handles full acks", () => {
    const status = ackStatus(directive({ acks: acks("u1", "u2", "u3", "u4") }), members);
    assert.deepEqual(status.pending, []);
    assert.equal(status.label, "4 of 4 acknowledged");
  });

  it("only counts addressed users who are still members", () => {
    const status = ackStatus(
      directive({ addressedUserIds: ["u1", "gone"], acks: acks("gone", "u4") }),
      members,
    );
    assert.deepEqual(status, { acked: [], pending: ["u1"], label: "0 of 1 acknowledged" });
  });
});

describe("overdue", () => {
  const SLA = 60;

  it("is not overdue a moment before the SLA", () => {
    const result = overdue(directive(), "2027-01-01T10:59:59.999Z", SLA);
    assert.equal(result.isOverdue, false);
    assert.equal(result.shouldRemind, false);
  });

  it("is overdue at exactly the SLA", () => {
    const result = overdue(directive(), "2027-01-01T11:00:00.000Z", SLA);
    assert.equal(result.isOverdue, true);
    assert.equal(result.shouldRemind, true);
    assert.deepEqual(result.pendingUserIds, ["u1", "u2", "u3", "u4"]);
  });

  it("does not remind a second time", () => {
    const reminded = directive({ remindedAt: "2027-01-01T11:00:00.000Z" });
    const result = overdue(reminded, "2027-01-02T11:00:00.000Z", SLA);
    assert.equal(result.isOverdue, true);
    assert.equal(result.shouldRemind, false);
  });

  it("is never overdue once everyone has acknowledged", () => {
    const done = directive({ acks: acks("u1", "u2", "u3", "u4") });
    assert.deepEqual(overdue(done, "2030-01-01T00:00:00.000Z", SLA), {
      isOverdue: false,
      pendingUserIds: [],
      shouldRemind: false,
    });
  });

  it("is never overdue with no addressed members", () => {
    const result = overdue(directive({ addressedUserIds: [] }), "2030-01-01T00:00:00.000Z", SLA);
    assert.equal(result.isOverdue, false);
    assert.equal(result.shouldRemind, false);
  });

  it("treats a zero SLA as immediately overdue", () => {
    assert.equal(overdue(directive(), CREATED, 0).isOverdue, true);
  });
});

describe("attentionFor", () => {
  const todo = { id: "t1", ownerUserId: "u1", status: "todo" };
  const done = { id: "t2", ownerUserId: "u1", status: "done" };
  const other = { id: "t3", ownerUserId: "u2", status: "todo" };

  it("returns unacknowledged directives and the user's todo tasks", () => {
    const pending = directive({ id: "pending" });
    const acked = directive({ id: "acked", acks: acks("u1") });
    const elsewhere = directive({ id: "elsewhere", addressedUserIds: ["u2"] });
    assert.deepEqual(attentionFor("u1", [pending, acked, elsewhere], [todo, done, other]), {
      directives: [pending],
      tasks: [todo],
    });
  });

  it("is empty when there is nothing", () => {
    assert.deepEqual(attentionFor("u1", [], []), { directives: [], tasks: [] });
  });
});

describe("directives: partial and malformed acknowledgement state", () => {
  const PAST_SLA = "2027-01-01T11:00:00.000Z";

  it("reminds only the people still pending", () => {
    const result = overdue(directive({ acks: acks("u1", "u3") }), PAST_SLA, 60);
    assert.deepEqual(result, {
      isOverdue: true,
      pendingUserIds: ["u2", "u4"],
      shouldRemind: true,
    });
  });

  it("counts a person addressed or acknowledging twice once", () => {
    const doubled = directive({ addressedUserIds: ["u1", "u1", "u2"], acks: acks("u1", "u1") });
    assert.deepEqual(ackStatus(doubled, members), {
      acked: ["u1"],
      pending: ["u2"],
      label: "1 of 2 acknowledged",
    });
    assert.deepEqual(overdue(doubled, PAST_SLA, 60).pendingUserIds, ["u2"]);
  });

  it("treats absent acks as nobody, and absent addressees as nobody pending", () => {
    assert.deepEqual(
      overdue(directive({ acks: undefined }), PAST_SLA, 60).pendingUserIds.length,
      4,
    );
    const noAddressees = directive({ addressedUserIds: undefined });
    assert.equal(overdue(noAddressees, PAST_SLA, 60).isOverdue, false);
    assert.deepEqual(attentionFor("u1", [noAddressees], []).directives, []);
  });
});
