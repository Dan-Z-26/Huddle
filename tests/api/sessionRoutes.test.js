import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEMO_EVENT_ID as ID } from "../../server/store/seed.js";
import { addEvent, assertError, snapshot, startDemo } from "./helpers.js";

const MANAGER = `user-manager@${ID}`;
const DESIGNER = `user-creative-director@${ID}`;
const PR_HEAD = `user-pr-head@${ID}`;

describe("the view-as list", () => {
  const ids = async (call, as) =>
    (await (await call("/users", { as })).json()).users.map(({ id }) => id);

  it("follows the caller's event, and falls back to the demo for a stale cookie", async (t) => {
    const { call, store } = await startDemo(t);
    addEvent(store);
    assert.ok((await ids(call, "user-manager@other")).every((id) => id.endsWith("@other")));
    assert.ok((await ids(call, "nobody")).every((id) => id.endsWith(`@${ID}`)));
    assert.ok((await ids(call)).every((id) => id.endsWith(`@${ID}`)));
  });

  it("names each role", async (t) => {
    const { call } = await startDemo(t);
    const { users } = await (await call("/users")).json();
    assert.ok(users.every(({ roleName }) => typeof roleName === "string" && roleName));
  });
});

describe("/me", () => {
  it("reports the user's event and no internal fields", async (t) => {
    const { call } = await startDemo(t);
    const { user, permissions } = await (await call("/me", { as: MANAGER })).json();
    assert.equal(user.eventId, ID);
    assert.equal("categoryIds" in user, false);
    assert.deepEqual(permissions, {
      seeTotalBudget: true,
      manageGroups: true,
      markDirective: true,
    });
  });

  it("lists only unacknowledged directives and open tasks of this user and event", async (t) => {
    const { call, store } = await startDemo(t);
    addEvent(store);
    const directive = (id, groupId, acks = []) => ({
      id,
      groupId,
      addressedUserIds: [DESIGNER],
      acks,
    });
    const core = `g-${ID}-core-team`;
    store.directives.set("open", directive("open", core));
    store.directives.set("acked", directive("acked", core, [{ userId: DESIGNER }]));
    store.directives.set("foreign", directive("foreign", "g-other-core-team"));
    store.directives.set("orphan", directive("orphan", "g-gone"));
    const [a, b, c] = store.tasks.values();
    a.ownerUserId = DESIGNER;
    b.ownerUserId = DESIGNER;
    b.status = "done";
    c.ownerUserId = PR_HEAD;
    const foreign = [...store.tasks.values()].find(({ eventId }) => eventId === "other");
    foreign.ownerUserId = DESIGNER;

    const { attention } = await (await call("/me", { as: DESIGNER })).json();
    assert.deepEqual(
      attention.directives.map(({ id }) => id),
      ["open"],
    );
    assert.deepEqual(
      attention.tasks.map(({ id }) => id),
      [a.id],
    );
  });
});

describe("creating an event", () => {
  it("makes the caller its manager and creates no groups yet", async (t) => {
    const { call } = await startDemo(t);
    const created = await call("/events", { method: "POST", body: { eventType: "community" } });
    assert.equal(created.status, 201);
    assert.match(created.headers.get("set-cookie"), /HttpOnly/i);
    const { event } = await created.json();
    assert.equal(event.intakeStatus, "in_progress");
    assert.ok("budget" in event);
    const as = `user-manager@${event.id}`;
    const body = await (await call(`/events/${event.id}`, { as })).json();
    assert.deepEqual(body.groups, []);
  });

  it("keeps the budget from core members while intake is running", async (t) => {
    const { call } = await startDemo(t);
    const { event } = await (
      await call("/events", { method: "POST", body: { eventType: "corporate_launch" } })
    ).json();
    const as = `user-creative-director@${event.id}`;
    const body = await (await call(`/events/${event.id}`, { as })).json();
    assert.equal("budget" in body.event, false);
  });
});

describe("profile edits", () => {
  const patch = (call, body) =>
    call(`/events/${ID}/profile`, { as: MANAGER, method: "PATCH", body });

  it("refuses every field outside the allowed text fields", async (t) => {
    const { call, store } = await startDemo(t);
    const before = snapshot(store);
    for (const body of [
      { id: "stolen" },
      { eventType: "birthday" },
      { intakeStatus: "in_progress" },
      { date: "2099-01-01" },
      { guests: { confirmed: 1 } },
      { priorities: [] },
      { mustHaves: [] },
      JSON.parse('{"__proto__": {"polluted": true}}'),
    ])
      await assertError(await patch(call, body), 400, "BAD_REQUEST");
    assert.equal(snapshot(store), before);
    assert.equal({}.polluted, undefined);
    assert.equal(store.events.get(ID).polluted, undefined);
  });

  it("trims text, and refuses blank or oversized values", async (t) => {
    const { call, store } = await startDemo(t);
    await patch(call, { city: "  Mumbai  " });
    assert.equal(store.events.get(ID).city, "Mumbai");
    for (const body of [{ city: "   " }, { city: "x".repeat(81) }, { name: 5 }])
      await assertError(await patch(call, body), 400, "BAD_REQUEST");
  });

  it("shows core members the edit, without the budget", async (t) => {
    const { call } = await startDemo(t);
    await patch(call, { name: "Renamed" });
    const { event } = await (await call(`/events/${ID}`, { as: PR_HEAD })).json();
    assert.equal(event.name, "Renamed");
    assert.equal("budget" in event, false);
  });
});

describe("intake", () => {
  async function newEvent(call, eventType = "corporate_launch") {
    const { event } = await (await call("/events", { method: "POST", body: { eventType } })).json();
    const as = `user-manager@${event.id}`;
    const answer = (body) => call(`/events/${event.id}/intake`, { as, method: "POST", body });
    return { id: event.id, as, answer };
  }

  it("asks the first question with no body at all", async (t) => {
    const { call } = await startDemo(t);
    const { answer } = await newEvent(call);
    const step = await (await answer()).json();
    assert.equal(step.field, "name");
    assert.equal(step.complete, false);
  });

  it("explains an unusable answer and stays on the same question", async (t) => {
    const { call } = await startDemo(t);
    const { answer } = await newEvent(call);
    await answer({ answer: "Nova Launch" });
    await answer({ answer: "Unveil the product" });
    const step = await (await answer({ answer: "12 March" })).json();
    assert.equal(step.field, "date");
    assert.match(step.feedback, /year/);
    assert.ok(!step.profile.date);
  });

  it("refuses a second confirm, and the demo's confirm", async (t) => {
    const { call, store } = await startDemo(t);
    const before = snapshot(store);
    await assertError(
      await call(`/events/${ID}/intake/confirm`, { as: MANAGER, method: "POST" }),
      400,
      "BAD_REQUEST",
    );
    assert.equal(snapshot(store), before);
  });

  it("refuses a wrongly typed answer", async (t) => {
    const { call } = await startDemo(t);
    const { answer } = await newEvent(call);
    await assertError(await answer({ answer: 5 }), 400, "BAD_REQUEST");
  });
});

describe("group history", () => {
  const url = (slug, query = "") => `/groups/g-${ID}-${slug}/messages${query}`;

  it("pages backwards without gaps or repeats", async (t) => {
    const { call, store } = await startDemo(t);
    for (let i = 0; i < 5; i++)
      store.messages.set(`m${i}`, { id: `m${i}`, groupId: `g-${ID}-core-team`, text: `${i}` });
    const seen = [];
    let before = "";
    do {
      const query = `?limit=2${before && `&before=${before}`}`;
      const page = await (await call(url("core-team", query), { as: DESIGNER })).json();
      seen.unshift(...page.messages.map(({ id }) => id));
      before = page.nextBefore;
    } while (before);
    assert.equal(seen.length, new Set(seen).size);
    assert.deepEqual(seen.slice(-5), ["m0", "m1", "m2", "m3", "m4"]);
  });

  it("gives an empty page for a cursor from another group", async (t) => {
    const { call, store } = await startDemo(t);
    const elsewhere = store.messagesForGroup(`g-${ID}-food-beverage`).messages[0].id;
    const page = await (
      await call(url("core-team", `?before=${elsewhere}`), { as: DESIGNER })
    ).json();
    assert.deepEqual(page, { messages: [], nextBefore: null });
  });

  it("rejects bad paging values", async (t) => {
    const { call } = await startDemo(t);
    for (const query of ["?limit=101", "?limit=1.5", "?limit=abc", "?before=a&before=b"])
      await assertError(await call(url("core-team", query), { as: DESIGNER }), 400, "BAD_REQUEST");
  });

  it("lets the manager read a category group no core member is in", async (t) => {
    const { call } = await startDemo(t);
    assert.equal((await call(url("food-beverage"), { as: MANAGER })).status, 200);
  });
});
