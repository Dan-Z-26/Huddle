import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEMO_EVENT_ID as ID } from "../../server/store/seed.js";
import { assertError, startDemo } from "./helpers.js";

const MANAGER = `user-manager@${ID}`;
const DESIGNER = `user-creative-director@${ID}`;
const PR_HEAD = `user-pr-head@${ID}`;

async function propose(call, text, as = MANAGER) {
  return call(`/events/${ID}/changes`, { as, method: "POST", body: { text } });
}
const accept = (call, changeId, as = MANAGER) =>
  call(`/events/${ID}/changes/${changeId}/accept`, { as, method: "POST" });

describe("budget view", () => {
  it("gives the manager totals and every category", async (t) => {
    const { call } = await startDemo(t);
    const budget = await (await call(`/events/${ID}/budget`, { as: MANAGER })).json();
    assert.equal(budget.totalMinor, 160000000);
    assert.ok(budget.categories.length >= 6);
    assert.equal(budget.categories.find(({ id }) => id === "reveal").rank, 1);
  });

  it("gives a core member only their own categories and no totals", async (t) => {
    const { call } = await startDemo(t);
    const budget = await (await call(`/events/${ID}/budget`, { as: PR_HEAD })).json();
    assert.deepEqual(budget.categories.map(({ id }) => id).sort(), ["photo-video", "pr"]);
    for (const key of ["totalMinor", "committedMinor", "remainingMinor", "lowMinor", "highMinor"])
      assert.equal(key in budget, false, key);
  });

  it("is missing before intake is confirmed, and hidden from other events", async (t) => {
    const { call } = await startDemo(t);
    const created = await call("/events", { method: "POST", body: { eventType: "birthday" } });
    const { event } = await created.json();
    const as = `user-manager@${event.id}`;
    await assertError(await call(`/events/${event.id}/budget`, { as }), 404, "NOT_FOUND");
    await assertError(await call(`/events/${ID}/budget`, { as }), 404, "NOT_FOUND");
    await assertError(await call(`/events/${ID}/budget`), 401, "UNAUTHENTICATED");
  });
});

describe("changes", () => {
  it("shows consequences without changing anything until the manager accepts", async (t) => {
    const { call, store } = await startDemo(t);
    const body = await (await propose(call, "add 50 guests")).json();
    assert.ok(body.changeId);
    assert.match(body.consequenceText, /over budget|within budget/);
    assert.doesNotMatch(body.consequenceText, /recommend/i);
    assert.equal(store.budgets.get(ID).guestCount, 200);

    const res = await accept(call, body.changeId);
    assert.equal(res.status, 200);
    const accepted = await res.json();
    assert.equal(accepted.budget.guestCount, 250);
    assert.equal(store.events.get(ID).guests.confirmed, 250);
    assert.ok(accepted.noticesPosted > 0);
    await assertError(await accept(call, body.changeId), 404, "NOT_FOUND");
  });

  it("posts notices to affected groups, without amounts where a member doesn't own the category", async (t) => {
    const { call, store } = await startDemo(t);
    const { changeId } = await (await propose(call, "add 50 guests")).json();
    await accept(call, changeId);
    const notices = (slug) =>
      store
        .messagesForGroup(`g-${ID}-${slug}`)
        .messages.filter(({ authorKind }) => authorKind === "system");
    assert.match(notices("food-beverage")[0].text, /₹/);
    const core = notices("core-team")[0].text;
    assert.match(core, /Gifting cost has changed/);
    assert.doesNotMatch(core, /₹/);
  });

  it("asks instead of offering a change it can't read", async (t) => {
    const { call } = await startDemo(t);
    const body = await (await propose(call, "make it better")).json();
    assert.equal(body.changeId, null);
    assert.match(body.clarifyingQuestion, /add 50 guests/);
  });

  it("refuses a change made against an older budget", async (t) => {
    const { call, store } = await startDemo(t);
    const first = await (await propose(call, "add 50 guests")).json();
    const second = await (await propose(call, "add 10 guests")).json();
    await accept(call, first.changeId);
    await assertError(await accept(call, second.changeId), 404, "NOT_FOUND");
    assert.equal(store.budgets.get(ID).guestCount, 250);
  });

  it("is manager-only, and validates the text", async (t) => {
    const { call } = await startDemo(t);
    await assertError(await propose(call, "add 50 guests", DESIGNER), 403, "FORBIDDEN");
    const { changeId } = await (await propose(call, "add 50 guests")).json();
    await assertError(await accept(call, changeId, DESIGNER), 403, "FORBIDDEN");
    await assertError(await propose(call, "   "), 400, "BAD_REQUEST");
    await assertError(await propose(call, "x".repeat(1001)), 400, "BAD_REQUEST");
  });

  it("does not accept another event's change", async (t) => {
    const { call, store } = await startDemo(t);
    store.pendingChanges.set("c-other", { id: "c-other", eventId: "other", events: [] });
    await assertError(await accept(call, "c-other"), 404, "NOT_FOUND");
  });
});

describe("timeline", () => {
  it("lists tasks by date with their owner group, for everyone on the event", async (t) => {
    const { call } = await startDemo(t);
    const { tasks } = await (await call(`/events/${ID}/timeline`, { as: PR_HEAD })).json();
    assert.ok(tasks.length > 0);
    const dates = tasks.map(({ dueDate }) => dueDate);
    assert.deepEqual(dates, [...dates].sort());
    assert.ok(tasks.every(({ ownerGroupName }) => ownerGroupName?.startsWith("#")));
  });

  it("replans when the manager moves the date", async (t) => {
    const { call, store } = await startDemo(t);
    const path = `/events/${ID}/reschedule`;
    const before = (await (await call(`/events/${ID}/timeline`, { as: MANAGER })).json()).tasks;
    const res = await call(path, { as: MANAGER, method: "POST", body: { date: "20 June 2031" } });
    assert.equal(res.status, 200);
    const { tasks } = await res.json();
    assert.notEqual(tasks[0].dueDate, before[0].dueDate);
    assert.equal(store.events.get(ID).date, "2031-06-20T00:00:00.000Z");
  });

  it("refuses a bad date, and anyone but the manager", async (t) => {
    const { call } = await startDemo(t);
    const path = `/events/${ID}/reschedule`;
    for (const date of ["soon", "12 March", "1 January 2001"])
      await assertError(
        await call(path, { as: MANAGER, method: "POST", body: { date } }),
        400,
        "BAD_REQUEST",
      );
    await assertError(
      await call(path, { as: DESIGNER, method: "POST", body: { date: "20 June 2031" } }),
      403,
      "FORBIDDEN",
    );
  });

  it("lets people in the owner group tick a task, and no one else", async (t) => {
    const { call, store } = await startDemo(t);
    // Milestones belong to shared rooms, so give one to a room the PR head isn't in.
    const task = [...store.tasks.values()][0];
    task.ownerGroupId = `g-${ID}-food-beverage`;
    const path = `/tasks/${task.id}`;
    const body = { status: "done" };
    await assertError(await call(path, { as: PR_HEAD, method: "PATCH", body }), 403, "FORBIDDEN");
    const res = await call(path, { as: MANAGER, method: "PATCH", body });
    assert.equal(res.status, 200);
    assert.equal(store.tasks.get(task.id).status, "done");
    await assertError(
      await call("/tasks/nope", { as: MANAGER, method: "PATCH", body }),
      404,
      "NOT_FOUND",
    );
    await assertError(
      await call(path, { as: MANAGER, method: "PATCH", body: { status: "maybe" } }),
      400,
      "BAD_REQUEST",
    );
  });

  it("posts the digest in #announcements from the Timeline agent, for the manager only", async (t) => {
    const { call } = await startDemo(t);
    await assertError(
      await call(`/events/${ID}/digest`, { as: DESIGNER, method: "POST" }),
      403,
      "FORBIDDEN",
    );
    const { message } = await (
      await call(`/events/${ID}/digest`, { as: MANAGER, method: "POST" })
    ).json();
    assert.equal(message.groupId, `g-${ID}-announcements`);
    assert.equal(message.authorId, `agent-timeline@${ID}`);
  });
});
