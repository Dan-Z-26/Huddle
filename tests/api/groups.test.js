import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import { describe, it } from "node:test";
import { DEMO_EVENT_ID as ID } from "../../server/store/seed.js";
import { assertError, startDemo } from "./helpers.js";

const MANAGER = `user-manager@${ID}`;
const DESIGNER = `user-creative-director@${ID}`;
const PR_HEAD = `user-pr-head@${ID}`;
const g = (slug) => `g-${ID}-${slug}`;
const make = (call, body, as = MANAGER) =>
  call(`/events/${ID}/groups`, { as, method: "POST", body });

describe("creating a group", () => {
  it("makes a room for the chosen roles, with the manager and AI members always in it", async (t) => {
    const { call, store } = await startDemo(t);
    const res = await make(call, { name: "Venue Team", memberRoleIds: ["pr-head"] });
    assert.equal(res.status, 201);
    const { group } = await res.json();
    assert.equal(group.name, "#venue-team");
    assert.equal(group.id, g("venue-team"));
    assert.ok(group.memberRoleIds.includes("manager"));
    assert.ok(group.memberRoleIds.includes("pr-head"));
    assert.ok(group.memberRoleIds.includes("agent-planner"));
    assert.ok(!group.memberRoleIds.includes("creative-director"));
    const mine = store.groupsForUser(store.users.get(PR_HEAD)).map(({ id }) => id);
    assert.ok(mine.includes(g("venue-team")));
    assert.ok(
      !store.groupsForUser(store.users.get(DESIGNER)).some(({ id }) => id === g("venue-team")),
    );
  });

  it("is for the manager, with a real name and known roles, and no duplicates", async (t) => {
    const { call } = await startDemo(t);
    await assertError(
      await make(call, { name: "Venue", memberRoleIds: [] }, DESIGNER),
      403,
      "FORBIDDEN",
    );
    await assertError(await make(call, { name: "!!", memberRoleIds: [] }), 400, "BAD_REQUEST");
    await assertError(await make(call, { name: "x", memberRoleIds: [] }), 400, "BAD_REQUEST");
    await assertError(
      await make(call, { name: "Venue", memberRoleIds: ["nobody"] }),
      400,
      "BAD_REQUEST",
    );
    assert.equal((await make(call, { name: "Venue", memberRoleIds: [] })).status, 201);
    await assertError(await make(call, { name: "venue", memberRoleIds: [] }), 400, "BAD_REQUEST");
  });

  it("stops at the group limit", async (t) => {
    const { call } = await startDemo(t);
    let last;
    for (let i = 0; i < 20; i++) last = await make(call, { name: `room ${i}`, memberRoleIds: [] });
    await assertError(last, 400, "BAD_REQUEST");
  });
});

describe("changing a group", () => {
  const patch = (call, slug, body, as = MANAGER) =>
    call(`/groups/${g(slug)}`, { as, method: "PATCH", body });

  it("renames it without changing its id, so notices still find it", async (t) => {
    const { call, store } = await startDemo(t);
    const { group } = await (await patch(call, "food-beverage", { name: "Catering" })).json();
    assert.equal(group.name, "#catering");
    assert.equal(group.id, g("food-beverage"));
    assert.equal(group.slug, "food-beverage");
    assert.equal(store.groups.get(g("food-beverage")).name, "#catering");
  });

  it("changes who is in it, and a removed role loses access at once", async (t) => {
    const { call } = await startDemo(t);
    assert.equal(
      (await call(`/groups/${g("stage-decor")}/messages`, { as: DESIGNER })).status,
      200,
    );
    await patch(call, "stage-decor", { memberRoleIds: ["production-lead"] });
    await assertError(
      await call(`/groups/${g("stage-decor")}/messages`, { as: DESIGNER }),
      403,
      "FORBIDDEN",
    );
    assert.equal((await call(`/groups/${g("stage-decor")}/messages`, { as: MANAGER })).status, 200);
  });

  it("keeps #announcements for everyone, and checks the manager and the event", async (t) => {
    const { call } = await startDemo(t);
    await assertError(
      await patch(call, "announcements", { memberRoleIds: [] }),
      400,
      "BAD_REQUEST",
    );
    assert.equal((await patch(call, "announcements", { name: "news" })).status, 200);
    await assertError(await patch(call, "pr-media", { name: "x2" }, DESIGNER), 403, "FORBIDDEN");
    await assertError(await patch(call, "pr-media", { budget: 1 }), 400, "BAD_REQUEST");
    await assertError(
      await patch(call, "pr-media", { memberRoleIds: ["nobody"] }),
      400,
      "BAD_REQUEST",
    );
    const { event } = await (
      await call("/events", { method: "POST", body: { eventType: "wedding" } })
    ).json();
    await assertError(
      await patch(call, "pr-media", { name: "mine" }, `user-manager@${event.id}`),
      404,
      "NOT_FOUND",
    );
  });
});

describe("removing a group", () => {
  const remove = (call, slug, as = MANAGER) => call(`/groups/${g(slug)}`, { as, method: "DELETE" });

  it("takes its messages, directives and files with it, and moves its tasks to #core-team", async (t) => {
    const { call, base, store, uploadsDir } = await startDemo(t);
    const form = new FormData();
    form.set("text", "Floor plan");
    form.append("files", new Blob([Buffer.from("%PDF-1.4\n")]), "plan.pdf");
    const res = await fetch(`${base}/api/groups/${g("music-av")}/messages`, {
      method: "POST",
      headers: { cookie: `huddle_user=${encodeURIComponent(MANAGER)}` },
      body: form,
    });
    const { message } = await res.json();
    await call(`/messages/${message.id}/directive`, { as: MANAGER, method: "POST", body: {} });
    const task = [...store.tasks.values()][0];
    task.ownerGroupId = g("music-av");
    assert.equal((await readdir(uploadsDir)).length, 1);

    assert.equal((await remove(call, "music-av")).status, 204);
    assert.equal(store.groups.has(g("music-av")), false);
    assert.ok([...store.messages.values()].every(({ groupId }) => groupId !== g("music-av")));
    assert.equal(store.directives.size, 0);
    assert.equal(store.files.size, 0);
    assert.deepEqual(await readdir(uploadsDir), []);
    assert.equal(store.tasks.get(task.id).ownerGroupId, g("core-team"));
    await assertError(
      await call(`/groups/${g("music-av")}/messages`, { as: MANAGER }),
      404,
      "NOT_FOUND",
    );
  });

  it("won't remove the groups the app depends on, and is for the manager", async (t) => {
    const { call } = await startDemo(t);
    await assertError(await remove(call, "announcements"), 400, "BAD_REQUEST");
    await assertError(await remove(call, "core-team"), 400, "BAD_REQUEST");
    await assertError(await remove(call, "pr-media", DESIGNER), 403, "FORBIDDEN");
    await assertError(await remove(call, "nope"), 404, "NOT_FOUND");
  });

  it("still sends a change notice for a removed category group, to #core-team", async (t) => {
    const { call, store } = await startDemo(t);
    await remove(call, "food-beverage");
    const { changeId } = await (
      await call(`/events/${ID}/changes`, {
        as: MANAGER,
        method: "POST",
        body: { text: "add 50 guests" },
      })
    ).json();
    await call(`/events/${ID}/changes/${changeId}/accept`, {
      as: MANAGER,
      method: "POST",
      body: {},
    });
    const notices = store
      .messagesForGroup(g("core-team"))
      .messages.filter(({ authorKind }) => authorKind === "system");
    assert.ok(notices.some(({ text }) => /Food & beverage/.test(text)));
  });
});
