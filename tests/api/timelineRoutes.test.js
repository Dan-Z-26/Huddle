import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEMO_EVENT_ID as ID } from "../../server/store/seed.js";
import { addEvent, assertError, snapshot, startDemo } from "./helpers.js";

const MANAGER = `user-manager@${ID}`;
const DESIGNER = `user-creative-director@${ID}`;
const PR_HEAD = `user-pr-head@${ID}`;
const DAY_MS = 86400000;
const isoDay = (offset = 0) => new Date(Date.now() + offset * DAY_MS).toISOString().slice(0, 10);

const reschedule = (call, date) =>
  call(`/events/${ID}/reschedule`, { as: MANAGER, method: "POST", body: { date } });
const setStatus = (call, id, status, as = MANAGER) =>
  call(`/tasks/${id}`, { as, method: "PATCH", body: { status } });

describe("rescheduling", () => {
  it("changes nothing when the date is impossible, past or unreadable", async (t) => {
    const { call, store } = await startDemo(t);
    const before = snapshot(store);
    for (const date of ["30 February 2099", "2099-13-01", isoDay(-1)])
      await assertError(await reschedule(call, date), 400, "BAD_REQUEST");
    assert.equal(snapshot(store), before);
  });

  it("validates the body", async (t) => {
    const { call } = await startDemo(t);
    for (const body of [{}, { date: "   " }, { date: "x".repeat(201) }, { date: 20310620 }])
      await assertError(
        await call(`/events/${ID}/reschedule`, { as: MANAGER, method: "POST", body }),
        400,
        "BAD_REQUEST",
      );
  });

  it("allows today, flagging what no longer fits, and clears flags when moved out", async (t) => {
    const { call } = await startDemo(t);
    const today = await (await reschedule(call, isoDay())).json();
    assert.ok(today.tasks.some(({ atRisk }) => atRisk));
    assert.ok(today.tasks.every(({ dueDate }) => dueDate.slice(0, 10) === isoDay()));
    const later = await (await reschedule(call, "20 June 2099")).json();
    assert.ok(later.tasks.every(({ atRisk }) => !atRisk));
  });

  it("keeps finished tasks finished", async (t) => {
    const { call, store } = await startDemo(t);
    const [task] = store.tasks.values();
    await setStatus(call, task.id, "done");
    const { tasks } = await (await reschedule(call, isoDay())).json();
    const moved = tasks.find(({ id }) => id === task.id);
    assert.equal(moved.status, "done");
    assert.equal(moved.atRisk, false);
  });

  it("does not invalidate a pending budget change", async (t) => {
    const { call } = await startDemo(t);
    const { changeId } = await (
      await call(`/events/${ID}/changes`, {
        as: MANAGER,
        method: "POST",
        body: { text: "add 50 guests" },
      })
    ).json();
    await reschedule(call, "20 June 2099");
    const res = await call(`/events/${ID}/changes/${changeId}/accept`, {
      as: MANAGER,
      method: "POST",
    });
    assert.equal(res.status, 200);
  });

  it("needs a finished workspace, while the timeline is just empty", async (t) => {
    const { call } = await startDemo(t);
    const created = await call("/events", { method: "POST", body: { eventType: "wedding" } });
    const { event } = await created.json();
    const as = `user-manager@${event.id}`;
    await assertError(
      await call(`/events/${event.id}/reschedule`, {
        as,
        method: "POST",
        body: { date: "20 June 2099" },
      }),
      404,
      "NOT_FOUND",
    );
    await assertError(
      await call(`/events/${event.id}/digest`, { as, method: "POST" }),
      404,
      "NOT_FOUND",
    );
    const { tasks } = await (await call(`/events/${event.id}/timeline`, { as })).json();
    assert.deepEqual(tasks, []);
  });
});

describe("task status", () => {
  const ownedBy = (store, slug) => {
    const [task] = store.tasks.values();
    task.ownerGroupId = `g-${ID}-${slug}`;
    return task;
  };

  it("lets a core member tick a task in their own group", async (t) => {
    const { call, store } = await startDemo(t);
    const task = ownedBy(store, "pr-media");
    const res = await setStatus(call, task.id, "done", PR_HEAD);
    assert.equal(res.status, 200);
    const { tasks } = await res.json();
    assert.equal(tasks.find(({ id }) => id === task.id).ownerGroupName, "PR & media");
    assert.equal(store.tasks.get(task.id).status, "done");
  });

  it("clears the risk flag when done, and raises it again when a late task reopens", async (t) => {
    const { call, store } = await startDemo(t);
    const [{ id }] = store.tasks.values();
    store.tasks.get(id).dueDate = "2020-01-01T00:00:00.000Z";
    await setStatus(call, id, "done");
    assert.equal(store.tasks.get(id).atRisk, false);
    await setStatus(call, id, "todo");
    assert.equal(store.tasks.get(id).status, "todo");
    assert.equal(store.tasks.get(id).atRisk, true);
  });

  it("fails closed when the owner group is gone", async (t) => {
    const { call, store } = await startDemo(t);
    const task = ownedBy(store, "does-not-exist");
    await assertError(await setStatus(call, task.id, "done"), 403, "FORBIDDEN");
    const { tasks } = await (await call(`/events/${ID}/timeline`, { as: MANAGER })).json();
    assert.equal(tasks.find(({ id }) => id === task.id).ownerGroupName, null);
  });

  it("accepts only the two statuses the UI offers", async (t) => {
    const { call, store } = await startDemo(t);
    const [{ id }] = store.tasks.values();
    for (const status of ["at_risk", "", null, undefined])
      await assertError(await setStatus(call, id, status), 400, "BAD_REQUEST");
    assert.equal(store.tasks.get(id).status, "todo");
  });
});

describe("digest", () => {
  it("reports due tasks and pending acks from this event only, with no money", async (t) => {
    const { call, store } = await startDemo(t);
    addEvent(store);
    const now = new Date().toISOString();
    const [own] = store.tasks.values();
    store.tasks.set(own.id, { ...own, title: "Own task", dueDate: now });
    const foreign = [...store.tasks.values()].find(({ eventId }) => eventId === "other");
    store.tasks.set(foreign.id, { ...foreign, title: "Foreign task", dueDate: now });
    const base = { acks: [], createdAt: now };
    store.directives.set("d-1", {
      ...base,
      id: "d-1",
      groupId: `g-${ID}-core-team`,
      addressedUserIds: [DESIGNER],
    });
    store.directives.set("d-2", {
      ...base,
      id: "d-2",
      groupId: "g-other-core-team",
      addressedUserIds: [PR_HEAD],
    });

    const res = await call(`/events/${ID}/digest`, { as: MANAGER, method: "POST" });
    const { text } = (await res.json()).message;
    assert.match(text, /Own task/);
    assert.doesNotMatch(text, /Foreign task/);
    assert.ok(text.includes(`${store.users.get(DESIGNER).name} (1)`));
    assert.equal(text.includes(store.users.get(PR_HEAD).name), false);
    assert.doesNotMatch(text, /₹/);
  });

  it("is stored in Announcements, where core members can read it", async (t) => {
    const { call } = await startDemo(t);
    const { message } = await (
      await call(`/events/${ID}/digest`, { as: MANAGER, method: "POST" })
    ).json();
    const { messages } = await (
      await call(`/groups/g-${ID}-announcements/messages`, { as: PR_HEAD })
    ).json();
    assert.ok(messages.some(({ id }) => id === message.id));
  });
});
