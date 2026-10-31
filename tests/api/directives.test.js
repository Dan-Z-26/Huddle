import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runReminders } from "../../server/reminders.js";
import { DEMO_EVENT_ID as ID } from "../../server/store/seed.js";
import { assertError, startDemo } from "./helpers.js";

const MANAGER = `user-manager@${ID}`;
const DESIGNER = `user-creative-director@${ID}`;
const LEAD = `user-production-lead@${ID}`;
const PR_HEAD = `user-pr-head@${ID}`;
const group = (slug) => `g-${ID}-${slug}`;

async function posted(call, slug, text, as = MANAGER) {
  const res = await call(`/groups/${group(slug)}/messages`, { as, method: "POST", body: { text } });
  return (await res.json()).message;
}
const pin = (call, id, body, as = MANAGER) =>
  call(`/messages/${id}/directive`, { as, method: "POST", body });
const ack = (call, id, as) => call(`/directives/${id}/ack`, { as, method: "POST" });

describe("pinning a directive", () => {
  it("addresses the group's people, and makes a timeline task from it", async (t) => {
    const { call, store } = await startDemo(t);
    const message = await posted(call, "stage-decor", "Send the final stage specs by Friday");
    const res = await pin(call, message.id, {});
    assert.equal(res.status, 201);
    const { directive, task } = await res.json();
    assert.deepEqual(directive.addressedUserIds.sort(), [DESIGNER, LEAD].sort());
    assert.equal(directive.status.label, "0 of 2 acknowledged");
    assert.equal(directive.taskId, task.id);
    assert.equal(task.source, "directive");
    assert.match(task.title, /final stage specs/i);
    assert.equal(store.tasks.get(task.id).eventId, ID);
    assert.ok(task.dueDate > "2026-10-31");
  });

  it("can address only some people", async (t) => {
    const { call } = await startDemo(t);
    const message = await posted(call, "stage-decor", "Check the rig");
    const { directive, task } = await (
      await pin(call, message.id, { addressedUserIds: [LEAD] })
    ).json();
    assert.deepEqual(directive.addressedUserIds, [LEAD]);
    assert.equal(task.ownerUserId, LEAD, "one addressee owns the task");
  });

  it("keeps an amount out of the timeline, which everyone can see", async (t) => {
    const { call } = await startDemo(t);
    const message = await posted(call, "core-team", "Cap the catering at ₹8 lakh by Monday");
    const { task } = await (await pin(call, message.id, {})).json();
    assert.doesNotMatch(task.title, /lakh|₹/);
  });

  it("is for the manager, on a person's message, once, in their own event", async (t) => {
    const { call } = await startDemo(t);
    const message = await posted(call, "core-team", "Hello team");
    await assertError(await pin(call, message.id, {}, DESIGNER), 403, "FORBIDDEN");
    assert.equal((await pin(call, message.id, {})).status, 201);
    await assertError(await pin(call, message.id, {}), 400, "BAD_REQUEST");
    await assertError(await pin(call, "nope", {}), 404, "NOT_FOUND");
    const welcome = (
      await (await call(`/groups/${group("announcements")}/messages`, { as: MANAGER })).json()
    ).messages[0];
    await assertError(await pin(call, welcome.id, {}), 400, "BAD_REQUEST");
    const { event } = await (
      await call("/events", { method: "POST", body: { eventType: "wedding" } })
    ).json();
    await assertError(
      await pin(call, message.id, {}, `user-manager@${event.id}`),
      404,
      "NOT_FOUND",
    );
  });

  it("needs someone to address, and only people in the group", async (t) => {
    const { call } = await startDemo(t);
    const message = await posted(call, "food-beverage", "Menu by Thursday");
    await assertError(
      await pin(call, message.id, { addressedUserIds: [PR_HEAD] }),
      400,
      "BAD_REQUEST",
    );
    await assertError(await pin(call, message.id, { addressedUserIds: [] }), 400, "BAD_REQUEST");
  });
});

describe("acknowledging", () => {
  async function pinned(t) {
    const ctx = await startDemo(t);
    const message = await posted(ctx.call, "stage-decor", "Send specs by Friday");
    const { directive } = await (await pin(ctx.call, message.id, {})).json();
    return { ...ctx, directive };
  }

  it("counts each person's Got it once, and shows who is pending", async (t) => {
    const { call, directive } = await pinned(t);
    const first = await (await ack(call, directive.id, DESIGNER)).json();
    assert.equal(first.status.label, "1 of 2 acknowledged");
    assert.deepEqual(first.status.pending, [LEAD]);
    const again = await (await ack(call, directive.id, DESIGNER)).json();
    assert.equal(again.directive.acks.length, 1, "a second tap changes nothing");
    const done = await (await ack(call, directive.id, LEAD)).json();
    assert.equal(done.status.label, "2 of 2 acknowledged");
  });

  it("is for the people it names only", async (t) => {
    const { call, directive } = await pinned(t);
    await assertError(await ack(call, directive.id, MANAGER), 403, "FORBIDDEN");
    await assertError(await ack(call, directive.id, PR_HEAD), 403, "FORBIDDEN");
    await assertError(await ack(call, "nope", DESIGNER), 404, "NOT_FOUND");
    await assertError(
      await call(`/directives/${directive.id}/ack`, { method: "POST" }),
      401,
      "UNAUTHENTICATED",
    );
  });

  it("appears pinned in the group, and in Needs my attention until acknowledged", async (t) => {
    const { call, directive } = await pinned(t);
    const history = await (
      await call(`/groups/${group("stage-decor")}/messages`, { as: DESIGNER })
    ).json();
    assert.equal(history.pinned[0].id, directive.id);
    assert.match(history.pinned[0].text, /Send specs/);
    const me = await (await call("/me", { as: DESIGNER })).json();
    assert.equal(me.attention.directives[0].id, directive.id);
    assert.match(me.attention.directives[0].groupName, /stage-decor/);
    await ack(call, directive.id, DESIGNER);
    const after = await (await call("/me", { as: DESIGNER })).json();
    assert.deepEqual(after.attention.directives, []);
    await assertError(
      await call(`/groups/${group("stage-decor")}/messages`, { as: PR_HEAD }),
      403,
      "FORBIDDEN",
    );
  });
});

describe("reminders", () => {
  const model = (text) => async () => ({
    data: { reminderText: text, rationale: "ok" },
    toolCalls: [],
  });

  async function overdue(t) {
    const ctx = await startDemo(t);
    const message = await posted(ctx.call, "stage-decor", "Send specs by Friday");
    const { directive } = await (await pin(ctx.call, message.id, {})).json();
    await ack(ctx.call, directive.id, DESIGNER);
    return { ...ctx, directive };
  }
  const later = (minutes) => new Date(Date.now() + minutes * 60000).toISOString();

  it("mentions only the people who haven't acknowledged, once", async (t) => {
    const { store, directive } = await overdue(t);
    assert.equal(await runReminders(store, later(10), { slaMinutes: 120 }), 0, "not yet due");
    assert.equal(
      await runReminders(store, later(130), { slaMinutes: 120, generate: model("Quick nudge") }),
      1,
    );
    const { messages } = store.messagesForGroup(group("stage-decor"));
    const nudge = messages.at(-1);
    assert.equal(nudge.authorId, `agent-timeline@${ID}`);
    assert.match(nudge.text, /@Meera Iyer/);
    assert.doesNotMatch(nudge.text, /@Rohan Kapoor/);
    assert.ok(store.directives.get(directive.id).remindedAt);
    assert.equal(await runReminders(store, later(300), { slaMinutes: 120 }), 0, "only once");
  });

  it("does not remind when everyone has acknowledged", async (t) => {
    const { call, store, directive } = await overdue(t);
    await ack(call, directive.id, LEAD);
    assert.equal(await runReminders(store, later(500), { slaMinutes: 120 }), 0);
  });

  it("keeps a reminder from repeating when the wording fails", async (t) => {
    const { store, directive } = await overdue(t);
    t.mock.method(console, "error", () => {});
    const boom = async () => {
      throw new TypeError("secret detail");
    };
    assert.equal(await runReminders(store, later(130), { slaMinutes: 120, generate: boom }), 0);
    assert.ok(store.directives.get(directive.id).remindedAt);
  });
});
