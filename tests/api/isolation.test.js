import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEMO_EVENT_ID as ID } from "../../server/store/seed.js";
import { addEvent, assertError, snapshot, startDemo } from "./helpers.js";

const MANAGER = `user-manager@${ID}`;
const DESIGNER = `user-creative-director@${ID}`;

const readRoutes = (id) => [
  ["GET", `/events/${id}`],
  ["GET", `/events/${id}/budget`],
  ["GET", `/events/${id}/timeline`],
];
const managerRoutes = (id) => [
  ["PATCH", `/events/${id}/profile`, { city: "Delhi" }],
  ["POST", `/events/${id}/intake`, { answer: "x" }],
  ["POST", `/events/${id}/intake/confirm`],
  ["POST", `/events/${id}/ideas`],
  ["POST", `/events/${id}/changes`, { text: "add 50 guests" }],
  ["POST", `/events/${id}/changes/c-any/accept`],
  ["POST", `/events/${id}/reschedule`, { date: "20 June 2099" }],
  ["POST", `/events/${id}/digest`],
];
const send = (call, as, [method, path, body]) => call(path, { as, method, body });

describe("every event route", () => {
  it("needs a human user: no cookie, an unknown id and an AI member all get 401", async (t) => {
    const { call, store } = await startDemo(t);
    const before = snapshot(store);
    const task = [...store.tasks.keys()][0];
    const routes = [
      ...readRoutes(ID),
      ...managerRoutes(ID),
      ["PATCH", `/tasks/${task}`, { status: "done" }],
      ["GET", `/groups/g-${ID}-announcements/messages`],
      ["GET", "/me"],
    ];
    for (const as of [undefined, "nobody", `agent-planner@${ID}`, `agent-budget@${ID}`])
      for (const route of routes)
        await assertError(await send(call, as, route), 401, "UNAUTHENTICATED");
    assert.equal(snapshot(store), before);
  });

  it("looks missing to another event's manager and core members, and changes nothing", async (t) => {
    const { call, store } = await startDemo(t);
    addEvent(store);
    const before = snapshot(store);
    for (const as of ["user-manager@other", "user-creative-director@other"])
      for (const route of [...readRoutes(ID), ...managerRoutes(ID)])
        await assertError(await send(call, as, route), 404, "NOT_FOUND");
    assert.equal(snapshot(store), before);
  });

  it("refuses core members on manager routes, and changes nothing", async (t) => {
    const { call, store } = await startDemo(t);
    const before = snapshot(store);
    for (const route of managerRoutes(ID))
      await assertError(await send(call, DESIGNER, route), 403, "FORBIDDEN");
    assert.equal(snapshot(store), before);
  });

  it("rejects ids over the length limit", async (t) => {
    const { call } = await startDemo(t);
    const long = "x".repeat(81);
    for (const route of readRoutes(long))
      await assertError(await send(call, MANAGER, route), 400, "BAD_REQUEST");
    await assertError(
      await call(`/events/${ID}/changes/${long}/accept`, { as: MANAGER, method: "POST" }),
      400,
      "BAD_REQUEST",
    );
  });
});

describe("resources of another event", () => {
  it("hides its group messages from this event's manager", async (t) => {
    const { call, store } = await startDemo(t);
    addEvent(store);
    await assertError(
      await call(`/groups/g-other-announcements/messages`, { as: MANAGER }),
      404,
      "NOT_FOUND",
    );
    const own = await call(`/groups/g-other-announcements/messages`, { as: "user-manager@other" });
    assert.equal(own.status, 200);
  });

  it("hides its tasks from every update", async (t) => {
    const { call, store } = await startDemo(t);
    addEvent(store);
    const task = [...store.tasks.values()].find(({ eventId }) => eventId === "other");
    await assertError(
      await call(`/tasks/${task.id}`, { as: MANAGER, method: "PATCH", body: { status: "done" } }),
      404,
      "NOT_FOUND",
    );
    assert.equal(store.tasks.get(task.id).status, "todo");
  });

  it("keeps each timeline and budget to its own event", async (t) => {
    const { call, store } = await startDemo(t);
    addEvent(store, { budget: { totalMinor: 90000000, currency: "INR" } });
    const { tasks } = await (await call(`/events/${ID}/timeline`, { as: MANAGER })).json();
    assert.ok(tasks.length > 0);
    assert.ok(tasks.every(({ eventId }) => eventId === ID));
    const mine = await (await call(`/events/${ID}/budget`, { as: MANAGER })).json();
    const theirs = await (await call("/events/other/budget", { as: "user-manager@other" })).json();
    assert.equal(mine.totalMinor, 160000000);
    assert.equal(theirs.totalMinor, 90000000);
  });

  it("does not let a manager accept another event's real change by either path", async (t) => {
    const { call, store } = await startDemo(t);
    addEvent(store);
    const proposed = await call("/events/other/changes", {
      as: "user-manager@other",
      method: "POST",
      body: { text: "add 50 guests" },
    });
    const { changeId } = await proposed.json();
    assert.ok(changeId);
    for (const event of [ID, "other"])
      await assertError(
        await call(`/events/${event}/changes/${changeId}/accept`, { as: MANAGER, method: "POST" }),
        404,
        "NOT_FOUND",
      );
    assert.equal(store.budgets.get("other").guestCount, 200);
    assert.ok(store.pendingChanges.has(changeId));
    const res = await call(`/events/other/changes/${changeId}/accept`, {
      as: "user-manager@other",
      method: "POST",
    });
    assert.equal(res.status, 200);
    assert.equal(store.budgets.get(ID).guestCount, 200);
  });

  it("leaves another event's groups without notices when a change is accepted", async (t) => {
    const { call, store } = await startDemo(t);
    addEvent(store);
    const { changeId } = await (
      await call(`/events/${ID}/changes`, {
        as: MANAGER,
        method: "POST",
        body: { text: "add 50 guests" },
      })
    ).json();
    await call(`/events/${ID}/changes/${changeId}/accept`, { as: MANAGER, method: "POST" });
    const system = [...store.messages.values()].filter(({ authorKind }) => authorKind === "system");
    assert.ok(system.length > 0);
    assert.ok(system.every(({ groupId }) => groupId.startsWith(`g-${ID}-`)));
  });
});
