import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import { describe, it } from "node:test";
import { DEMO_EVENT_ID as ID } from "../../server/store/seed.js";
import { assertError, startDemo, cookieAt } from "./helpers.js";

const MANAGER = `user-manager@${ID}`;
const DESIGNER = `user-creative-director@${ID}`;
const LEAD = `user-production-lead@${ID}`;
const PR_HEAD = `user-pr-head@${ID}`;
const PDF = Buffer.from("%PDF-1.4\n1 0 obj\n<<>>\nendobj\n");
const g = (slug) => `/groups/g-${ID}-${slug}/messages`;
const post = (call, slug, text, as = MANAGER) =>
  call(g(slug), { as, method: "POST", body: { text } });
const settle = (store) => Promise.all([...store.background]);

async function withFiles(base, slug, as, files, text = "") {
  const form = new FormData();
  if (text) form.set("text", text);
  for (const [name, buffer] of files) form.append("files", new Blob([buffer]), name);
  return fetch(`${base}/api${g(slug)}`, {
    method: "POST",
    headers: { cookie: cookieAt(base, as) },
    body: form,
  });
}

describe("posting", () => {
  it("posts to the group, and only that group", async (t) => {
    const { call, store } = await startDemo(t);
    const res = await post(call, "core-team", "  Venue walkthrough on Friday  ", DESIGNER);
    assert.equal(res.status, 201);
    const { message } = await res.json();
    assert.equal(message.text, "Venue walkthrough on Friday");
    assert.equal(message.authorKind, "human");
    assert.equal(message.authorId, DESIGNER);
    const elsewhere = [...store.messages.values()].filter(({ text }) => text === message.text);
    assert.deepEqual(
      elsewhere.map(({ groupId }) => groupId),
      [`g-${ID}-core-team`],
    );
    const { messages } = await (await call(g("core-team"), { as: LEAD })).json();
    assert.equal(messages.at(-1).id, message.id);
  });

  it("follows who may post where", async (t) => {
    const { call } = await startDemo(t);
    await assertError(await post(call, "announcements", "hi", DESIGNER), 403, "FORBIDDEN");
    assert.equal((await post(call, "announcements", "Welcome all", MANAGER)).status, 201);
    await assertError(await post(call, "food-beverage", "hi", DESIGNER), 403, "FORBIDDEN");
    assert.equal((await post(call, "stage-decor", "Stage check", LEAD)).status, 201);
    assert.equal(
      (await post(call, "food-beverage", "Menu tasting", `user-fb-lead@${ID}`)).status,
      201,
    );
    await assertError(await post(call, "core-team", "hi", null), 401, "UNAUTHENTICATED");
  });

  it("validates the text, and hides other events' groups", async (t) => {
    const { call } = await startDemo(t);
    await assertError(await post(call, "core-team", "   "), 400, "BAD_REQUEST");
    await assertError(await post(call, "core-team", "x".repeat(4001)), 400, "BAD_REQUEST");
    const { event } = await (
      await call("/events", { method: "POST", body: { eventType: "wedding" } })
    ).json();
    await assertError(
      await post(call, "core-team", "hi", `user-manager@${event.id}`),
      404,
      "NOT_FOUND",
    );
  });

  it("keeps only the latest messages in a busy group", async (t) => {
    const { call, store } = await startDemo(t);
    for (let i = 0; i < 305; i++)
      store.messages.set(`bulk${i}`, {
        id: `bulk${i}`,
        groupId: `g-${ID}-music-av`,
        text: "x",
        fileIds: [],
      });
    await post(call, "music-av", "one more");
    const inGroup = [...store.messages.values()].filter(
      ({ groupId }) => groupId === `g-${ID}-music-av`,
    );
    assert.ok(inGroup.length <= 300);
  });
});

describe("attachments", () => {
  it("attaches up to three files, stored against the group, visible to its members only", async (t) => {
    const { base, call, store, uploadsDir } = await startDemo(t);
    const res = await withFiles(
      base,
      "stage-decor",
      MANAGER,
      [
        ["plan.pdf", PDF],
        ["b.pdf", PDF],
      ],
      "Floor plan",
    );
    assert.equal(res.status, 201);
    const { message } = await res.json();
    assert.equal(message.files.length, 2);
    assert.equal(message.files[0].name, "plan.pdf");
    assert.equal((await readdir(uploadsDir)).length, 2);
    const [file] = message.files;
    assert.equal((await call(`/files/${file.id}`, { as: DESIGNER })).status, 200);
    await assertError(await call(`/files/${file.id}`, { as: PR_HEAD }), 403, "FORBIDDEN");
    assert.equal(store.files.get(file.id).groupId, `g-${ID}-stage-decor`);
  });

  it("refuses a bad file, a fourth file, and saves nothing when one is bad", async (t) => {
    const { base, uploadsDir } = await startDemo(t);
    const html = Buffer.from("<script>alert(1)</script>");
    await assertError(
      await withFiles(base, "core-team", MANAGER, [
        ["ok.pdf", PDF],
        ["x.pdf", html],
      ]),
      400,
      "UNSUPPORTED_FILE",
    );
    assert.deepEqual(await readdir(uploadsDir), []);
    const four = ["a", "b", "c", "d"].map((n) => [`${n}.pdf`, PDF]);
    await assertError(await withFiles(base, "core-team", MANAGER, four), 400, "BAD_REQUEST");
    assert.deepEqual(await readdir(uploadsDir), []);
  });

  it("accepts a file with no text", async (t) => {
    const { base } = await startDemo(t);
    assert.equal((await withFiles(base, "core-team", MANAGER, [["menu.pdf", PDF]])).status, 201);
  });
});

describe("@huddle", () => {
  it("brings in the Planner, who replies in the same group", async (t) => {
    const { call, store } = await startDemo(t);
    await post(call, "core-team", "@huddle what is on the timeline this week?", DESIGNER);
    await settle(store);
    const { messages } = store.messagesForGroup(`g-${ID}-core-team`);
    const reply = messages.at(-1);
    assert.equal(reply.authorId, `agent-planner@${ID}`);
    assert.equal(reply.authorKind, "agent");
    assert.equal(reply.groupId, `g-${ID}-core-team`);
  });

  it("does not call the Planner, or reroute anything, for an ordinary message", async (t) => {
    const { call, store } = await startDemo(t);
    const before = store.messages.size;
    await post(call, "core-team", "Lunch at one?", DESIGNER);
    await settle(store);
    assert.equal(store.messages.size, before + 1);
  });

  it("gives a core member no budget figures, however the question is put", async (t) => {
    const { call, store } = await startDemo(t);
    await post(call, "core-team", "@huddle what is the total budget and add 50 guests", PR_HEAD);
    await settle(store);
    const text = store
      .messagesForGroup(`g-${ID}-core-team`)
      .messages.filter(({ authorId }) => authorId.startsWith("agent-planner"))
      .map(({ text }) => text)
      .join("\n");
    assert.doesNotMatch(text, /₹16|1600000|16,00,000/);
    assert.equal(store.budgets.get(ID).guestCount, 200, "nothing was applied");
  });

  it("shares the AI limit only for messages that mention it", async (t) => {
    const { call } = await startDemo(t);
    let last;
    for (let i = 0; i < 31; i++) last = await post(call, "core-team", `@huddle hello ${i}`);
    assert.equal(last.status, 429);
    assert.equal((await post(call, "core-team", "just chatting")).status, 201);
  });
});
