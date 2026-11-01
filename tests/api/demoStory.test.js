import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { freshenOpeningLines, seedHistory } from "../../server/demo/history.js";
import { installStory } from "../../server/demo/story.js";
import { runDailyDigests } from "../../server/reminders.js";
import { createStore } from "../../server/store/index.js";
import { DEMO_EVENT_ID as ID, seedDemo } from "../../server/store/seed.js";
import { addMessage, createEvent } from "../../server/store/workspace.js";
import { addEvent, serve, sessionCookie, settle } from "./helpers.js";

const NOW = new Date().toISOString();
const PAST = new Date(Date.now() - 2 * 86400000).toISOString();
const MANAGER = `user-manager@${ID}`;

function demoStore() {
  const store = createStore();
  store.publish = () => {};
  store.discardFiles = () => {};
  seedDemo(store, PAST);
  seedHistory(store, NOW);
  return store;
}
const inRoom = (store, slug) => store.messagesForGroup(`g-${ID}-${slug}`, { limit: 100 }).messages;
const texts = (store, slug) => inRoom(store, slug).map(({ text }) => text);

describe("the demo's past", () => {
  it("shows people talking, oldest first, before anyone signs in", () => {
    const store = demoStore();
    const core = inRoom(store, "core-team").filter(({ authorKind }) => authorKind === "human");
    assert.ok(core.length >= 4);
    const times = inRoom(store, "core-team").map(({ createdAt }) => createdAt);
    assert.deepEqual(times, times.toSorted());
  });

  it("leaves a directive part acknowledged, and only one past task open", () => {
    const store = demoStore();
    const [directive] = store.directivesForEvent(ID);
    assert.equal(directive.addressedUserIds.length, 4);
    assert.equal(directive.acks.length, 2);
    const late = store
      .tasksForEvent(ID)
      .filter(({ dueDate, status }) => dueDate < NOW && status !== "done");
    assert.ok(late.length <= 1);
  });

  it("stays out of the digest's way: one per day, however often it is asked", async () => {
    const store = demoStore();
    assert.equal(await runDailyDigests(store, NOW), 1);
    assert.equal(await runDailyDigests(store, NOW), 0);
    await store.digests.get(`${ID}:${NOW.slice(0, 10)}`);
    const digests = inRoom(store, "announcements").filter(({ authorId }) =>
      authorId.startsWith("agent-timeline"),
    );
    assert.equal(digests.length, 1);
  });

  it("gives a digest to an event only once its workspace exists", async () => {
    const store = demoStore();
    createEvent(store, { eventType: "wedding", id: "new" });
    assert.equal(await runDailyDigests(store, NOW), 1);
    assert.ok(!store.digests.has(`new:${NOW.slice(0, 10)}`));
  });
});

describe("the demo's opening lines", () => {
  const rewriting = async ({ messages }) => {
    const given = messages[0].content.split("<<<UNTRUSTED lines>>>\n")[1];
    const lines = given.split("\n<<<END")[0].split("\n");
    return { data: { lines: lines.map(() => "Written for this event.") }, toolCalls: [] };
  };

  it("are rewritten, but a real Planner reply is left exactly as it was", async () => {
    const store = demoStore();
    const reply = addMessage(store, {
      id: "m-real",
      groupId: `g-${ID}-core-team`,
      authorId: `agent-planner@${ID}`,
      authorKind: "agent",
      text: "A real answer. ".repeat(40),
      fileIds: [],
      createdAt: NOW,
      rationale: null,
    });
    const original = reply.text;
    await freshenOpeningLines(store, { generate: rewriting });
    assert.equal(store.messages.get("m-real").text, original);
    assert.ok(texts(store, "core-team").includes("Written for this event."));
  });

  it("don't fail when the model can't answer, whatever replies have been posted", async () => {
    const store = demoStore();
    addMessage(store, {
      id: "m-long",
      groupId: `g-${ID}-core-team`,
      authorId: `agent-planner@${ID}`,
      authorKind: "agent",
      text: "x".repeat(900),
      fileIds: [],
      createdAt: NOW,
      rationale: null,
    });
    const down = async () => {
      throw Object.assign(new Error("down"), { name: "LlmError" });
    };
    await freshenOpeningLines(store, { generate: down });
  });
});

describe("the demo story", () => {
  it("plays through real code, and runs only once", async () => {
    const store = demoStore();
    const story = installStory(store, { speed: 0 });
    await Promise.all([story.start(), story.start()]);
    await settle(store);

    assert.match(texts(store, "music-av").join("\n"), /Logged "[^"]+" under/);
    const budget = inRoom(store, "music-av").filter(
      ({ authorId, text }) => authorId === `agent-budget@${ID}` && /over its plan/.test(text),
    );
    assert.equal(budget.length, 1);
    assert.doesNotMatch(budget[0].text, /₹|lakh|\d/);
    assert.equal(store.expenses.size, 5);
    assert.match(texts(store, "music-av").join("\n"), /Seen\. I'll ask the vendor/);

    assert.ok(inRoom(store, "food-beverage").at(-1).authorKind === "agent");
    assert.equal(store.briefs.get(`b-${ID}-pr`).status, "pending");
    assert.match(texts(store, "core-team").join("\n"), /brief for approval/);

    const [directive] = store.directivesForEvent(ID);
    assert.equal(directive.acks.length, 3);
    assert.ok(directive.remindedAt);
    assert.ok(inRoom(store, "announcements").some(({ text }) => /Meera/.test(text)));
  });

  it("keeps the scripted amount out of the room, and an approved brief approved", async () => {
    const store = demoStore();
    store.briefs.set(`b-${ID}-pr`, {
      id: `b-${ID}-pr`,
      eventId: ID,
      categoryId: "pr",
      status: "approved",
      answers: {},
      text: "A brief.",
      deliverables: [],
      note: null,
    });
    const story = installStory(store, { speed: 0 });
    await story.start();
    await settle(store);
    assert.doesNotMatch(texts(store, "music-av").join("\n"), /lakh|₹/);
    assert.equal(store.expenses.size, 5);
  });

  it("has nobody speak in a room they aren't in", async () => {
    const store = demoStore();
    const story = installStory(store, { speed: 0 });
    const room = store.groups.get(`g-${ID}-music-av`);
    room.memberRoleIds = room.memberRoleIds.filter((id) => id !== "production-lead");
    const spoken = () =>
      inRoom(store, "music-av").filter(({ authorId }) => authorId === `user-production-lead@${ID}`)
        .length;
    const before = spoken();
    await story.start();
    await settle(store);
    assert.equal(spoken(), before);
  });

  it("carries on when a viewer has removed a room", async () => {
    const store = demoStore();
    const story = installStory(store, { speed: 0 });
    store.groups.delete(`g-${ID}-pr-media`);
    await story.start();
    await settle(store);
    assert.equal(store.directivesForEvent(ID)[0].acks.length, 3);
  });
});

describe("teammates answering a viewer", () => {
  const started = async (t) => {
    const store = demoStore();
    installStory(store, { speed: 0 });
    const base = await serve(t, { store });
    const call = (path, { as = MANAGER, method = "GET", body } = {}) =>
      fetch(`${base}/api${path}`, {
        method,
        headers: { cookie: sessionCookie(store, as), "content-type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
      });
    return { store, call, base };
  };

  it("acknowledges a new directive, leaving one person pending", async (t) => {
    const { store, call } = await started(t);
    const posted = await call(`/groups/g-${ID}-core-team/messages`, {
      method: "POST",
      body: { text: "Please share your risk list by Monday." },
    });
    const { message } = await posted.json();
    const pinned = await call(`/messages/${message.id}/directive`, { method: "POST", body: {} });
    assert.equal(pinned.status, 201);
    await settle(store);
    const directive = store
      .directivesForEvent(ID)
      .find(({ messageId }) => messageId === message.id);
    assert.equal(directive.acks.length, directive.addressedUserIds.length - 1);
  });

  it("answers when named in the room, not otherwise, and never as the speaker", async (t) => {
    const { store, call } = await started(t);
    const say = (text, as) =>
      call(`/groups/g-${ID}-core-team/messages`, { as, method: "POST", body: { text } });
    await say("Meera, can you check the ceiling height?");
    await settle(store);
    assert.equal(inRoom(store, "core-team").at(-1).text, "On it, Asha.");
    assert.equal(inRoom(store, "core-team").at(-1).authorId, `user-production-lead@${ID}`);
    const count = inRoom(store, "core-team").length;
    await say("Thanks everyone.");
    await say("Meera here, checking it.", `user-production-lead@${ID}`);
    await settle(store);
    assert.equal(inRoom(store, "core-team").length, count + 2);
  });

  it("leaves the viewer's own events alone", async (t) => {
    const { store } = await started(t);
    const event = addEvent(store);
    const before = store.messages.size;
    store.reactInDemo("message", {
      event,
      group: store.groups.get(`g-${ID}-core-team`),
      user: store.users.get(MANAGER),
      text: "Meera?",
    });
    assert.equal(store.startDemoStory(event.id), undefined);
    await settle(store);
    assert.equal(store.messages.size, before);
  });

  it("starts the story at the first sign-in", async (t) => {
    const { store, base } = await started(t);
    let started2 = 0;
    store.startDemoStory = () => (started2 += 1);
    await fetch(`${base}/api/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId: MANAGER }),
    });
    assert.equal(started2, 1);
  });
});

describe("the activity feed", () => {
  it("shows the latest from the rooms this person is in, and refuses vendors", async (t) => {
    const store = demoStore();
    const base = await serve(t, { store });
    const read = (as) =>
      fetch(`${base}/api/events/${ID}/activity`, { headers: { cookie: sessionCookie(store, as) } });
    const all = (await (await read(MANAGER)).json()).messages;
    assert.equal(all.length, 12);
    const food = (await (await read(`user-fb-lead@${ID}`)).json()).messages;
    assert.ok(!food.some(({ groupId }) => groupId === `g-${ID}-stage-decor`));
    assert.ok(all.some(({ groupId }) => groupId === `g-${ID}-stage-decor`));
    store.users.set("v", { id: "v", eventId: ID, kind: "vendor", roleId: "v", categoryIds: [] });
    assert.equal((await read("v")).status, 403);
  });
});
