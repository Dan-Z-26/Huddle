import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEMO_EVENT_ID as ID } from "../../server/store/seed.js";
import { assertError, snapshot, startDemo } from "./helpers.js";

const MANAGER = `user-manager@${ID}`;
const DESIGNER = `user-creative-director@${ID}`;
const PR_HEAD = `user-pr-head@${ID}`;
const TOTAL_NOW = "160000000";
const TOTAL_NEW = "180000000";

const propose = async (call, text) =>
  (await call(`/events/${ID}/changes`, { as: MANAGER, method: "POST", body: { text } })).json();
const accept = (call, changeId) =>
  call(`/events/${ID}/changes/${changeId}/accept`, { as: MANAGER, method: "POST" });

describe("budget scoping", () => {
  it("returns the owner's category figures and nothing about other categories", async (t) => {
    const { call, store } = await startDemo(t);
    const { categories } = await (await call(`/events/${ID}/budget`, { as: DESIGNER })).json();
    assert.deepEqual(
      categories.map(({ id }) => id).sort(),
      store.users.get(DESIGNER).categoryIds.slice().sort(),
    );
    const seenByManager = await (await call(`/events/${ID}/budget`, { as: MANAGER })).json();
    const foodFigure = String(
      seenByManager.categories.find(({ id }) => id === "food-beverage").committedMinor,
    );
    assert.equal(JSON.stringify(categories).includes(foodFigure), false);
  });

  it("never puts the total in anything a core member can read, even after it changes", async (t) => {
    const { call } = await startDemo(t);
    const { changeId } = await propose(call, "raise the budget to 18 lakh");
    assert.equal((await accept(call, changeId)).status, 200);
    await call(`/events/${ID}/digest`, { as: MANAGER, method: "POST" });
    const { groups } = await (await call(`/events/${ID}`, { as: PR_HEAD })).json();
    const paths = [
      `/events/${ID}`,
      `/events/${ID}/budget`,
      `/events/${ID}/timeline`,
      "/me",
      "/people",
      ...groups.map(({ id }) => `/groups/${id}/messages`),
    ];
    for (const path of paths) {
      const res = await call(path, { as: PR_HEAD });
      assert.equal(res.status, 200, path);
      const text = await res.text();
      for (const figure of [TOTAL_NOW, TOTAL_NEW, "18,00,000", "16,00,000"])
        assert.equal(text.includes(figure), false, `${figure} in ${path}`);
    }
  });

  it("omits the tier name for a category with nothing allocated", async (t) => {
    const { call, store } = await startDemo(t);
    const state = store.budgets.get(ID);
    const emptied = state.categories.map((category) =>
      category.id === "pr" ? { ...category, drivers: [] } : category,
    );
    store.budgets.set(ID, { ...state, categories: emptied });
    const { categories } = await (await call(`/events/${ID}/budget`, { as: MANAGER })).json();
    const pr = categories.find(({ id }) => id === "pr");
    assert.equal(pr.committedMinor, 0);
    assert.equal(pr.tierLabel, null);
  });
});

describe("proposing a change", () => {
  it("stores nothing and offers no id when the change can't apply", async (t) => {
    const { call, store } = await startDemo(t);
    const before = snapshot(store);
    for (const text of ["remove 200 guests", "add 999999 guests"]) {
      const body = await propose(call, text);
      assert.equal(body.changeId, null, text);
      assert.ok(body.consequences.rejected.length > 0, text);
      assert.ok(body.clarifyingQuestion, text);
    }
    assert.equal(snapshot(store), before);
  });

  it("keeps internal state out of the response", async (t) => {
    const { call } = await startDemo(t);
    const body = await propose(call, "add 50 guests");
    assert.deepEqual(Object.keys(body).sort(), [
      "answer",
      "changeId",
      "clarifyingQuestion",
      "consequenceText",
      "consequences",
      "estimates",
      "explanation",
      "insight",
      "offline",
      "rationale",
    ]);
  });

  it("drops the oldest pending change once 100 are waiting", async (t) => {
    const { call, store } = await startDemo(t);
    for (let i = 0; i < 100; i++)
      store.pendingChanges.set(`c-${i}`, { id: `c-${i}`, eventId: ID, events: [] });
    const { changeId } = await propose(call, "add 50 guests");
    assert.equal(store.pendingChanges.size, 100);
    assert.equal(store.pendingChanges.has("c-0"), false);
    assert.ok(store.pendingChanges.has(changeId));
    await assertError(await accept(call, "c-0"), 404, "NOT_FOUND");
  });

  it("needs a finished workspace, for proposing and accepting alike", async (t) => {
    const { call } = await startDemo(t);
    const created = await call("/events", { method: "POST", body: { eventType: "birthday" } });
    const { event } = await created.json();
    const as = `user-manager@${event.id}`;
    const body = { text: "add 5 guests" };
    await assertError(
      await call(`/events/${event.id}/changes`, { as, method: "POST", body }),
      404,
      "NOT_FOUND",
    );
    await assertError(
      await call(`/events/${event.id}/changes/c-1/accept`, { as, method: "POST" }),
      404,
      "NOT_FOUND",
    );
  });

  it("is rate limited after 30 calls, without blocking routes that use no model", async (t) => {
    const { call } = await startDemo(t);
    const attempt = () =>
      call(`/events/${ID}/changes`, { as: MANAGER, method: "POST", body: { text: " " } });
    for (let i = 0; i < 30; i++) assert.equal((await attempt()).status, 400);
    await assertError(await attempt(), 429, "RATE_LIMITED");
    assert.equal((await call(`/events/${ID}/budget`, { as: MANAGER })).status, 200);
  });
});

describe("accepting a change", () => {
  it("applies a new total, and keeps the profile and budget in step", async (t) => {
    const { call, store } = await startDemo(t);
    const { changeId } = await propose(call, "raise the budget to 18 lakh");
    const res = await accept(call, changeId);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.budget.totalMinor, 180000000);
    assert.equal(store.budgets.get(ID).totalMinor, 180000000);
    assert.equal(store.events.get(ID).budget.totalMinor, 180000000);
    assert.equal(store.events.get(ID).budget.currency, "INR");
    assert.equal(body.noticesPosted, 0);
  });

  it("does not disturb the guest range when only the budget changed", async (t) => {
    const { call, store } = await startDemo(t);
    const { changeId } = await propose(call, "raise the budget to 18 lakh");
    await accept(call, changeId);
    assert.equal(store.events.get(ID).guests.suggested, 210);
  });

  it("re-checks in code, and refuses a stored change that no longer applies", async (t) => {
    const { call, store } = await startDemo(t);
    store.pendingChanges.set("c-bad", {
      id: "c-bad",
      eventId: ID,
      events: [{ type: "guest_count", delta: -500, confidence: 1 }],
      baseState: store.budgets.get(ID),
    });
    const before = snapshot(store);
    await assertError(await accept(call, "c-bad"), 400, "BAD_REQUEST");
    assert.equal(snapshot(store), before);
  });

  it("notifies exactly the groups mapped to the changed categories, as system messages", async (t) => {
    const { call, store } = await startDemo(t);
    const { changeId } = await propose(call, "add 50 guests");
    const { noticesPosted } = await (await accept(call, changeId)).json();
    const notices = [...store.messages.values()].filter(
      ({ authorKind }) => authorKind === "system",
    );
    assert.equal(notices.length, noticesPosted);
    assert.deepEqual(notices.map(({ groupId }) => groupId).sort(), [
      `g-${ID}-core-team`,
      `g-${ID}-food-beverage`,
    ]);
    for (const notice of notices) {
      assert.equal(notice.authorId, `agent-budget@${ID}`);
      assert.match(notice.text, /Guest count is now 250 \(it was 200\)/);
      assert.ok(notice.rationale);
    }
  });

  it("keeps a notice inside its group", async (t) => {
    const { call } = await startDemo(t);
    const { changeId } = await propose(call, "add 50 guests");
    await accept(call, changeId);
    await assertError(
      await call(`/groups/g-${ID}-food-beverage/messages`, { as: PR_HEAD }),
      403,
      "FORBIDDEN",
    );
  });

  it("shows owners the new figure, still without totals", async (t) => {
    const { call } = await startDemo(t);
    const view = async () => (await call(`/events/${ID}/budget`, { as: DESIGNER })).json();
    const gifting = ({ categories }) => categories.find(({ id }) => id === "gifting");
    const before = await view();
    const { changeId } = await propose(call, "add 50 guests");
    await accept(call, changeId);
    const after = await view();
    assert.ok(gifting(after).committedMinor > gifting(before).committedMinor);
    assert.equal(after.guestCount, 250);
    assert.equal("totalMinor" in after, false);
  });

  it("refreshes risk flags and returns the timeline", async (t) => {
    const { call, store } = await startDemo(t);
    const task = [...store.tasks.values()][0];
    store.tasks.set(task.id, { ...task, dueDate: "2020-01-01T00:00:00.000Z", atRisk: false });
    const { changeId } = await propose(call, "add 50 guests");
    const { tasks } = await (await accept(call, changeId)).json();
    assert.equal(tasks.find(({ id }) => id === task.id).atRisk, true);
    assert.equal(store.tasks.get(task.id).atRisk, true);
  });

  it("logs no details when a notice fails", async (t) => {
    const { call, store } = await startDemo(t);
    const { changeId } = await propose(call, "add 50 guests");
    const logged = t.mock.method(console, "error", () => {});
    t.mock.method(store.messages, "set", () => {
      throw new Error("secret detail");
    });
    assert.equal((await accept(call, changeId)).status, 200);
    assert.doesNotMatch(String(logged.mock.calls[0].arguments), /secret/);
  });
});
