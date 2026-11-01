import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { demoBudget as budgetDemo } from "../../server/agents/budgetDemo.js";
import { hideAmounts, mentionsMoney } from "../../server/core/amount.js";
import { getTemplate } from "../../server/core/templates.js";
import { runReminders } from "../../server/reminders.js";
import { createHub } from "../../server/sse.js";
import { saveUpload } from "../../server/store/files.js";
import { createStore } from "../../server/store/index.js";
import { DEMO_EVENT_ID as ID } from "../../server/store/seed.js";
import { createEvent, deleteEvent } from "../../server/store/workspace.js";
import { addEvent, assertError, sessionCookie, settle, startDemo } from "./helpers.js";

const MANAGER = `user-manager@${ID}`;
const DESIGNER = `user-creative-director@${ID}`;
const CORE_TEAM = `g-${ID}-core-team`;
const PDF = Buffer.from("%PDF-1.4 a tiny file");
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

const post = (call, path, as, body) => call(path, { as, method: "POST", body });
const say = (call, groupId, as, text) => post(call, `/groups/${groupId}/messages`, as, { text });
const textsIn = (store, groupId) =>
  store.messagesForGroup(groupId).messages.map(({ text }) => text);

async function book(call, store, categoryId) {
  const fields = { vendorName: "Booked Co", categoryId, fixedText: "₹50,000", taxPercent: 0 };
  const { quote } = await (await post(call, `/events/${ID}/quotes`, MANAGER, fields)).json();
  const { changeId } = await (await post(call, `/quotes/${quote.id}/accept`, MANAGER)).json();
  await post(call, `/events/${ID}/changes/${changeId}/accept`, MANAGER, { raise: true });
  await settle(store);
  const vendor = store.users.get(`vendor-${quote.id}@${ID}`);
  const room = [...store.groups.values()].find(
    ({ eventId, memberRoleIds }) => eventId === ID && memberRoleIds.includes(vendor.roleId),
  );
  return { vendor, room };
}

describe("hostile text can't stall the server", () => {
  const template = getTemplate("corporate_launch");
  const pad = " ".repeat(120);

  it("reads a budget request padded with spaces at once, and still understands it", () => {
    const started = performance.now();
    budgetDemo({ text: `move a${pad}from${pad}x`, template });
    assert.ok(performance.now() - started < 100);
    const { proposals } = budgetDemo({
      text: "move   ₹50,000   from   gifting   to   food",
      template,
    });
    assert.equal(proposals[0].type, "category_shift");
  });

  it("checks long runs of digits and commas for money quickly", () => {
    const started = performance.now();
    for (let i = 0; i < 20; i += 1) mentionsMoney("1,".repeat(4000));
    assert.ok(performance.now() - started < 500);
  });
});

describe("amounts in shared text", () => {
  for (const text of [
    "Rs850 per plate",
    "INR850 for the lot",
    "950 per cover",
    "750 a seat",
    "5 lks all in",
    "5 लाख",
    "2 करोड़",
    "५०० रुपये",
    "The other vendor quoted 900 each",
    "they charged 700 for it",
    "75 apiece",
  ])
    it(`spots "${text}"`, () => assert.equal(mentionsMoney(text), true));

  for (const text of [
    "200 guests",
    "by 1 Feb 2027",
    "3 rooms",
    "rsvp by Friday",
    "Get the quote by 14 Nov",
    "Quote requests sent to vendors (14 Nov)",
  ])
    it(`leaves "${text}" alone`, () => assert.equal(mentionsMoney(text), false));

  it("a whole message goes when its amount can't be picked out", () => {
    assert.doesNotMatch(hideAmounts("It is 5 लाख in all"), /लाख/);
  });
});

describe("a booked vendor's room", () => {
  it("a rival's quote is announced in Core team, not where the vendor reads it", async (t) => {
    const { call, store } = await startDemo(t);
    const { room } = await book(call, store, "pr");
    const rival = { vendorName: "Rival Caterers", categoryId: "pr", fixedText: "₹40,000" };
    await post(call, `/events/${ID}/quotes`, MANAGER, { ...rival, taxPercent: 0 });
    await settle(store);
    assert.doesNotMatch(textsIn(store, room.id).join(), /Rival Caterers/);
    assert.match(textsIn(store, CORE_TEAM).join(), /Rival Caterers/);
  });

  it("the Planner won't answer in front of the vendor", async (t) => {
    const { call, store } = await startDemo(t);
    const { room } = await book(call, store, "pr");
    const titles = store.tasksForEvent(ID).map(({ title }) => title);
    await say(call, room.id, MANAGER, "@huddle what is due this week?");
    await settle(store);
    const reply = textsIn(store, room.id).at(-1);
    assert.match(reply, /Core team/);
    for (const title of titles) assert.equal(reply.includes(title), false);
  });
});

describe("a shared room", () => {
  it("a lead's reply can't repeat an amount for the whole room", async (t) => {
    const { call, store } = await startDemo(t);
    const soon = new Date(Date.now() + 86400000).toISOString();
    store.tasksForEvent = () => [
      { id: "t", title: "Pay ₹40,000 to the hotel", dueDate: soon, status: "todo", atRisk: false },
    ];
    await say(call, CORE_TEAM, DESIGNER, "@huddle what is due this week?");
    await settle(store);
    assert.doesNotMatch(textsIn(store, CORE_TEAM).at(-1), /40,000/);
  });
});

describe("uploads", () => {
  // The last boundary never comes, so the server holds what it has read until the upload ends.
  const stalledUpload = (base, cookie) =>
    new Promise((resolve) => {
      const { hostname, port } = new URL(base);
      const socket = connect(Number(port), hostname, () => {
        socket.write(
          `POST /api/groups/${CORE_TEAM}/messages HTTP/1.1\r\nHost: x\r\nCookie: ${cookie}\r\n` +
            "Content-Type: multipart/form-data; boundary=b\r\nContent-Length: 999999\r\n\r\n" +
            '--b\r\nContent-Disposition: form-data; name="files"; filename="a.png"\r\n\r\npartial',
        );
        resolve(socket);
      });
    });

  it("refuses more uploads than memory can hold at once, and frees them when they end", async (t) => {
    const { store, base } = await startDemo(t);
    const cookie = sessionCookie(store, MANAGER);
    const send = () => {
      const body = new FormData();
      body.set("files", new Blob([PNG], { type: "image/png" }), "a.png");
      return fetch(`${base}/api/groups/${CORE_TEAM}/messages`, {
        method: "POST",
        headers: { cookie },
        body,
      });
    };
    const stalled = await Promise.all(Array.from({ length: 8 }, () => stalledUpload(base, cookie)));
    await new Promise((resolve) => setTimeout(resolve, 50));
    await assertError(await send(), 429, "RATE_LIMITED");
    for (const socket of stalled) socket.destroy();
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal((await send()).status, 201);
  });

  it("a file is named for what it is, not what it claims to be", async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "huddle-test-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const upload = { groupId: "g", userId: "u" };
    const named = async (originalName, buffer) =>
      (await saveUpload(createStore(), dir, { ...upload, originalName, buffer })).originalName;
    assert.equal(await named("quote.html", PDF), "quote.pdf");
    assert.equal(await named("quote.pdf", PDF), "quote.pdf");
    assert.equal(await named("no extension", PDF), "no extension.pdf");
    assert.equal(await named("a.b.svg", PNG), "a.b.png");
  });

  it("counts a file against the limit before writing it, so parallel uploads can't pass it", async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "huddle-test-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const store = createStore();
    const saving = saveUpload(store, dir, {
      originalName: "a.pdf",
      buffer: PDF,
      groupId: "g",
      userId: "u",
    });
    assert.equal(store.files.size, 1);
    await saving;
  });

  it("forgets a file it couldn't write", async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "huddle-test-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    await writeFile(join(dir, "taken"), "not a directory");
    const store = createStore();
    const upload = { originalName: "a.pdf", buffer: PDF, groupId: "g", userId: "u" };
    await assert.rejects(saveUpload(store, join(dir, "taken"), upload));
    assert.equal(store.files.size, 0);
  });
});

describe("making room for new events", () => {
  it("drops an unfinished event first, never one somebody has set up", async (t) => {
    const { call, store } = await startDemo(t);
    const finished = addEvent(store, { id: "finished" });
    const { event: unfinished } = createEvent(store, { eventType: "wedding", id: "unfinished" });
    for (let i = store.events.size; i < 50; i += 1) addEvent(store, { id: `full-${i}` });
    assert.equal((await post(call, "/events", null, { eventType: "birthday" })).status, 201);
    assert.equal(store.events.has(finished.id), true);
    assert.equal(store.events.has(unfinished.id), false);
  });

  it("removing an event takes its briefs, deliverables, invites and files with it", async (t) => {
    const { store } = await startDemo(t);
    const event = addEvent(store);
    const vendorUserId = `user-manager@${event.id}`;
    const groupId = `g-${event.id}-core-team`;
    store.briefs.set("b", { id: "b", eventId: event.id });
    store.deliverables.set("d", { id: "d", eventId: event.id });
    store.invites.set("hash", { vendorUserId });
    const file = { id: "f", groupId, storedName: "x.pdf" };
    store.files.set("f", file);
    const discarded = [];
    store.discardFiles = (records) => discarded.push(...records);
    deleteEvent(store, event.id);
    assert.equal(store.briefs.has("b"), false);
    assert.equal(store.deliverables.has("d"), false);
    assert.equal(store.invites.has("hash"), false);
    assert.equal(store.files.has("f"), false);
    assert.deepEqual(discarded, [file]);
  });
});

describe("sessions", () => {
  it("a flood of sign-ins as one person pushes out only that person's old sessions", () => {
    const store = createStore();
    const real = store.openSession("real-manager");
    for (let i = 0; i < 5100; i += 1) store.openSession("demo-manager");
    assert.equal(store.sessions.has(real), true);
    assert.ok(store.sessions.size <= 5000);
  });
});

describe("live streams", () => {
  const fakeRes = () => ({
    ended: false,
    writeHead() {},
    write() {},
    on() {},
    end() {
      this.ended = true;
    },
  });

  it("one address can't take every stream", () => {
    const hub = createHub();
    for (let i = 0; i < 30; i += 1) hub.add(fakeRes(), { id: `u${i}` }, undefined, "1.1.1.1");
    assert.equal(hub.size(), 30);
    assert.equal(hub.add(fakeRes(), { id: "next" }, undefined, "1.1.1.1"), false);
    assert.equal(hub.add(fakeRes(), { id: "other" }, undefined, "2.2.2.2"), true);
    hub.close();
  });

  it("a stream ends with its session's lifetime", () => {
    const hub = createHub();
    const store = createStore();
    const sessionId = store.openSession("u1");
    store.sessions.get(sessionId).startedAt = Date.now() - 25 * 3_600_000;
    const res = fakeRes();
    hub.add(res, { id: "u1" }, sessionId, "1.1.1.1");
    hub.send(store, { type: "budget.updated", eventId: "e" });
    assert.equal(res.ended, true);
    hub.close();
  });
});

describe("an invite link", () => {
  const follow = (base, path, cookie) =>
    fetch(`${base}${path}`, { redirect: "manual", headers: cookie ? { cookie } : {} });

  async function invite(call, store) {
    const { vendor } = await book(call, store, "pr");
    const res = await post(call, `/vendors/${encodeURIComponent(vendor.id)}/invite`, MANAGER);
    return (await res.json()).path;
  }

  it("signs in someone who isn't signed in", async (t) => {
    const { call, store, base } = await startDemo(t);
    const res = await follow(base, await invite(call, store));
    assert.equal(res.headers.get("location"), "/");
    assert.match(res.headers.get("set-cookie"), /huddle_session=/);
  });

  it("can't cost someone the event they are in", async (t) => {
    const { call, store, base } = await startDemo(t);
    const path = await invite(call, store);
    const res = await follow(base, path, sessionCookie(store, MANAGER));
    assert.equal(res.headers.get("location"), "/?invite=signed-in");
    assert.equal(res.headers.get("set-cookie"), null);
  });

  it("still works for a vendor already signed in through their link", async (t) => {
    const { call, store, base } = await startDemo(t);
    const path = await invite(call, store);
    const cookie = (await follow(base, path)).headers.get("set-cookie").split(";")[0];
    assert.equal((await follow(base, path, cookie)).headers.get("location"), "/");
  });

  it("ignores a session whose event has gone", async (t) => {
    const { call, store, base } = await startDemo(t);
    const path = await invite(call, store);
    const res = await follow(base, path, `huddle_session=${store.openSession("gone-user")}`);
    assert.equal(res.headers.get("location"), "/");
  });

  it("is rate limited, like everything else", async (t) => {
    const { base } = await startDemo(t);
    for (let i = 0; i < 30; i += 1) await follow(base, "/join/not-a-token");
    assert.equal((await follow(base, "/join/not-a-token")).status, 429);
  });
});

describe("requests from other sites", () => {
  const logout = (base, site, method = "POST", path = "/api/session/logout") =>
    fetch(`${base}${path}`, { method, headers: site ? { "sec-fetch-site": site } : {} });

  it("refuses a write a browser says came from elsewhere", async (t) => {
    const { base } = await startDemo(t);
    await assertError(await logout(base, "cross-site"), 403, "FORBIDDEN");
    await assertError(await logout(base, "same-site"), 403, "FORBIDDEN");
  });

  it("lets through the page's own writes, tools and every read", async (t) => {
    const { base } = await startDemo(t);
    assert.equal((await logout(base, "same-origin")).status, 204);
    assert.equal((await logout(base, "none")).status, 204);
    assert.equal((await logout(base)).status, 204);
    assert.equal((await logout(base, "cross-site", "GET", "/api/event-types")).status, 200);
  });
});

describe("what a vendor receives live", () => {
  it("has amounts, the AI's reasoning and other people's files taken out", async (t) => {
    const { call, store } = await startDemo(t);
    const { vendor, room } = await book(call, store, "pr");
    const hub = createHub();
    t.after(() => hub.close());
    const sent = [];
    hub.add({ write: (chunk) => sent.push(chunk), writeHead() {}, on() {}, end() {} }, vendor);
    hub.send(store, {
      type: "message.created",
      eventId: ID,
      groupId: room.id,
      message: {
        id: "m",
        authorId: MANAGER,
        text: "We paid ₹40,000",
        rationale: "Because of the ₹40,000 quote",
        files: [{ id: "f", name: "rival-quote.pdf" }],
      },
    });
    hub.send(store, {
      type: "directive.updated",
      eventId: ID,
      groupId: room.id,
      directive: { id: "d", groupId: room.id, text: "Pay ₹40,000 by Friday" },
    });
    const received = sent.join("");
    assert.match(received, /message\.created/);
    assert.match(received, /directive\.updated/);
    assert.doesNotMatch(received, /40,000|rival-quote/);
  });
});

describe("streams that stop working", () => {
  const stream = (overrides) => ({ writeHead() {}, write() {}, on() {}, end() {}, ...overrides });

  it("drops a client that stopped reading, before it fills the server's memory", () => {
    const hub = createHub();
    const store = createStore();
    let ended = false;
    const end = () => {
      ended = true;
    };
    hub.add(stream({ writableLength: 2 * 1024 * 1024, end }), { id: "u" });
    hub.send(store, { type: "budget.updated", eventId: "e" });
    store.users.set("u", { id: "u", eventId: "e", kind: "manager" });
    hub.send(store, { type: "budget.updated", eventId: "e" });
    assert.equal(ended, true);
    assert.equal(hub.size(), 0);
    hub.close();
  });

  it("forgets a client whose connection throws", () => {
    const hub = createHub();
    const store = createStore();
    store.users.set("u", { id: "u", eventId: "e", kind: "manager" });
    let open = true;
    const write = () => {
      if (!open) throw new Error("closed");
    };
    hub.add(stream({ write }), { id: "u" });
    open = false;
    hub.send(store, { type: "budget.updated", eventId: "e" });
    assert.equal(hub.size(), 0);
    hub.close();
  });
});

describe("a vendor's overdue step", () => {
  it("is mentioned once, in the room that owns it", async (t) => {
    const { call, store } = await startDemo(t);
    await book(call, store, "pr");
    const step = [...store.tasks.values()].find(({ source }) => source === "vendor");
    const later = new Date(Date.parse(step.dueDate) + 86400000 * 2).toISOString();
    const reminded = () =>
      textsIn(store, step.ownerGroupId).filter((text) => /overdue/.test(text)).length;
    assert.equal(await runReminders(store, later), 1);
    await settle(store);
    assert.equal(reminded(), 1);
    assert.equal(await runReminders(store, later), 0);
  });
});
