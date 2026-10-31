import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEMO_EVENT_ID } from "../../server/store/seed.js";
import { assertError, startDemo } from "./helpers.js";

const MANAGER = `user-manager@${DEMO_EVENT_ID}`;
const DESIGNER = `user-creative-director@${DEMO_EVENT_ID}`;
const PR_HEAD = `user-pr-head@${DEMO_EVENT_ID}`;
const start = startDemo;

describe("session", () => {
  it("lists the demo people without AI members", async (t) => {
    const { call } = await start(t);
    const { users } = await (await call("/users")).json();
    assert.equal(users.length, 4);
    assert.ok(users.every(({ kind }) => kind !== "agent"));
    assert.ok(users.every((user) => !("categoryIds" in user)));
  });

  it("sets a cookie for a human and refuses AI members and unknown ids", async (t) => {
    const { call } = await start(t);
    const ok = await call("/view-as", { method: "POST", body: { userId: DESIGNER } });
    assert.equal(ok.status, 200);
    assert.match(ok.headers.get("set-cookie"), /huddle_user=.*HttpOnly.*SameSite=Lax/i);
    const agent = await call("/view-as", {
      method: "POST",
      body: { userId: `agent-planner@${DEMO_EVENT_ID}` },
    });
    await assertError(agent, 404, "NOT_FOUND");
    await assertError(
      await call("/view-as", { method: "POST", body: { userId: "nobody" } }),
      404,
      "NOT_FOUND",
    );
    await assertError(await call("/view-as", { method: "POST", body: {} }), 400, "BAD_REQUEST");
  });

  it("needs a user for /me and reports permissions from the server", async (t) => {
    const { call } = await start(t);
    await assertError(await call("/me"), 401, "UNAUTHENTICATED");
    const manager = await (await call("/me", { as: MANAGER })).json();
    assert.equal(manager.permissions.seeTotalBudget, true);
    const designer = await (await call("/me", { as: DESIGNER })).json();
    assert.equal(designer.permissions.seeTotalBudget, false);
    assert.equal(designer.permissions.manageGroups, false);
  });
});

describe("event", () => {
  it("shows the total budget to the manager only", async (t) => {
    const { call } = await start(t);
    const manager = await (await call(`/events/${DEMO_EVENT_ID}`, { as: MANAGER })).json();
    assert.equal(manager.event.budget.totalMinor, 160000000);
    const designer = await (await call(`/events/${DEMO_EVENT_ID}`, { as: DESIGNER })).json();
    assert.equal("budget" in designer.event, false);
  });

  it("lists only the groups a core member belongs to", async (t) => {
    const { call } = await start(t);
    const { groups } = await (await call(`/events/${DEMO_EVENT_ID}`, { as: PR_HEAD })).json();
    const slugs = groups.map(({ slug }) => slug).sort();
    assert.deepEqual(slugs, ["announcements", "core-team", "photo-video", "pr-media"]);
  });

  it("keeps events apart", async (t) => {
    const { call } = await start(t);
    const created = await call("/events", { method: "POST", body: { eventType: "wedding" } });
    assert.equal(created.status, 201);
    const cookie = created.headers.get("set-cookie").split(";")[0];
    const { event } = await created.json();
    const base = created.url.replace(/\/api\/events$/, "");
    const peek = await fetch(`${base}/api/events/${DEMO_EVENT_ID}`, { headers: { cookie } });
    await assertError(peek, 404, "NOT_FOUND");
    const own = await fetch(`${base}/api/events/${event.id}`, { headers: { cookie } });
    assert.equal(own.status, 200);
  });

  it("rejects an unknown event type", async (t) => {
    const { call } = await start(t);
    await assertError(
      await call("/events", { method: "POST", body: { eventType: "gala" } }),
      400,
      "BAD_REQUEST",
    );
  });

  it("lets only the manager edit the profile, and only plain text fields", async (t) => {
    const { call } = await start(t);
    const path = `/events/${DEMO_EVENT_ID}/profile`;
    await assertError(
      await call(path, { as: DESIGNER, method: "PATCH", body: { city: "Delhi" } }),
      403,
      "FORBIDDEN",
    );
    const ok = await call(path, { as: MANAGER, method: "PATCH", body: { city: "Mumbai" } });
    assert.equal((await ok.json()).event.city, "Mumbai");
    await assertError(
      await call(path, { as: MANAGER, method: "PATCH", body: { budget: { totalMinor: 1 } } }),
      400,
      "BAD_REQUEST",
    );
  });
});

describe("intake", () => {
  const ANSWERS = [
    "Nova Launch",
    "Unveil the Nova X1 to partners and press",
    "12 March 2031",
    "Pune",
    "A hotel ballroom",
    "around 200",
    "yes",
    "16 lakh",
    "reveal, food, decor, gifting",
    "Inspired and proud to be part of it",
    "branded reveal stage, live demo",
    "branded reveal stage",
    "vegetarian menu, wheelchair access, final specs by 1 Feb",
    "skip",
  ];

  async function newManager(t) {
    const { call, store } = await start(t);
    const created = await call("/events", {
      method: "POST",
      body: { eventType: "corporate_launch" },
    });
    const { event } = await created.json();
    const as = `user-manager@${event.id}`;
    return { call, store, as, id: event.id };
  }

  it("runs a full conversation, then builds the workspace on confirm", async (t) => {
    const { call, as, id, store } = await newManager(t);
    const first = await (
      await call(`/events/${id}/intake`, { as, method: "POST", body: {} })
    ).json();
    assert.equal(first.field, "name");
    let step = first;
    for (const answer of ANSWERS) {
      const res = await call(`/events/${id}/intake`, { as, method: "POST", body: { answer } });
      assert.equal(res.status, 200);
      step = await res.json();
    }
    assert.equal(step.complete, true);
    assert.equal(step.profile.guests.confirmed, 210);

    const confirm = await call(`/events/${id}/intake/confirm`, { as, method: "POST" });
    assert.equal(confirm.status, 200);
    const { groups, event } = await confirm.json();
    assert.equal(event.intakeStatus, "confirmed");
    assert.ok(groups.length >= 4);
    assert.ok(store.budgets.has(id));
    assert.ok([...store.tasks.values()].some((task) => task.eventId === id));
    await assertError(
      await call(`/events/${id}/intake`, { as, method: "POST", body: { answer: "more" } }),
      400,
      "BAD_REQUEST",
    );

    const ideas = await call(`/events/${id}/ideas`, { as, method: "POST" });
    assert.equal(ideas.status, 200);
    assert.ok((await ideas.json()).ideas.length > 0);
  });

  it("refuses to confirm early, and ideas before the workspace exists", async (t) => {
    const { call, as, id } = await newManager(t);
    await assertError(
      await call(`/events/${id}/intake/confirm`, { as, method: "POST" }),
      400,
      "BAD_REQUEST",
    );
    await assertError(
      await call(`/events/${id}/ideas`, { as, method: "POST" }),
      400,
      "BAD_REQUEST",
    );
  });

  it("is manager-only and validates the answer", async (t) => {
    const { call } = await start(t);
    await assertError(
      await call(`/events/${DEMO_EVENT_ID}/intake`, { as: DESIGNER, method: "POST", body: {} }),
      403,
      "FORBIDDEN",
    );
    const { call: call2, as, id } = await newManager(t);
    await assertError(
      await call2(`/events/${id}/intake`, {
        as,
        method: "POST",
        body: { answer: "x".repeat(2001) },
      }),
      400,
      "BAD_REQUEST",
    );
  });
});

describe("group messages", () => {
  const groupId = (slug) => `g-${DEMO_EVENT_ID}-${slug}`;

  it("lets a member read their group", async (t) => {
    const { call } = await start(t);
    const res = await call(`/groups/${groupId("announcements")}/messages`, { as: DESIGNER });
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.match(body.messages[0].text, /Welcome/);
  });

  it("refuses a group the user is not in, and hides other events' groups", async (t) => {
    const { call } = await start(t);
    await assertError(
      await call(`/groups/${groupId("food-beverage")}/messages`, { as: DESIGNER }),
      403,
      "FORBIDDEN",
    );
    await assertError(await call(`/groups/nope/messages`, { as: DESIGNER }), 404, "NOT_FOUND");
    await assertError(
      await call(`/groups/${groupId("core-team")}/messages?limit=0`, { as: DESIGNER }),
      400,
      "BAD_REQUEST",
    );
    await assertError(
      await call(`/groups/${groupId("core-team")}/messages`),
      401,
      "UNAUTHENTICATED",
    );
  });
});
