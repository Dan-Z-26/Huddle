import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEMO_EVENT_ID as ID } from "../../server/store/seed.js";
import { runReminders } from "../../server/reminders.js";
import { settle, startDemo } from "./helpers.js";

const MANAGER = `user-manager@${ID}`;
const DESIGNER = `user-creative-director@${ID}`;
const GROUP = `g-${ID}-core-team`;
const post = (call, text, as) =>
  call(`/groups/${GROUP}/messages`, { as, method: "POST", body: { text } });
const agentTexts = (store) =>
  store
    .messagesForGroup(GROUP)
    .messages.filter(({ authorId }) => authorId.startsWith("agent-planner"))
    .map(({ text }) => text);

describe("@huddle reply paths", () => {
  it("posts a safe apology, with no error detail, when the Planner fails", async (t) => {
    const { call, store } = await startDemo(t);
    t.mock.method(console, "error", () => {});
    store.tasksForEvent = () => {
      throw new Error("secret-internal-detail");
    };
    const res = await post(call, "@huddle what is due?", DESIGNER);
    assert.equal(res.status, 201);
    await settle(store);
    const texts = agentTexts(store);
    assert.match(texts.at(-1), /^Sorry, I couldn't work on that/);
    assert.doesNotMatch(texts.join(), /secret-internal-detail/);
  });

  it("posts no budget figures in a group, even when the manager asked for them", async (t) => {
    const { call, store } = await startDemo(t);
    await post(call, "@huddle what if we add 50 guests?", MANAGER);
    await settle(store);
    assert.match(agentTexts(store).at(-1), /Ask Huddle in the sidebar/);
    await post(call, "@huddle give me ideas", MANAGER);
    await settle(store);
    assert.match(agentTexts(store).at(-1), /Ask Huddle in the sidebar/);
  });
});

describe("reminders", () => {
  it("skips a directive whose message is gone, and marks it so it can't block others", async (t) => {
    const { call, store } = await startDemo(t);
    const res = await post(call, "Send specs by Friday", MANAGER);
    const { message } = await res.json();
    const pinned = await call(`/messages/${message.id}/directive`, {
      as: MANAGER,
      method: "POST",
      body: {},
    });
    const { directive } = await pinned.json();
    store.messages.delete(message.id);
    const generate = async () => ({ data: { reminderText: "x", rationale: "y" } });
    const n = await runReminders(store, "2027-01-01T00:00:00.000Z", { generate });
    assert.equal(n, 0);
    assert.ok(store.directives.get(directive.id).remindedAt);
  });
});
