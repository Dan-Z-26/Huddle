import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createHub } from "../../server/sse.js";
import { DEMO_EVENT_ID as ID } from "../../server/store/seed.js";
import { assertError, startDemo } from "./helpers.js";

const MANAGER = `user-manager@${ID}`;
const DESIGNER = `user-creative-director@${ID}`;
const PR_HEAD = `user-pr-head@${ID}`;

/** Opens the stream as a user and collects the events it receives. */
async function listen(t, base, as) {
  const controller = new AbortController();
  const res = await fetch(`${base}/api/stream`, {
    headers: { cookie: `huddle_user=${encodeURIComponent(as)}` },
    signal: controller.signal,
  });
  t.after(() => controller.abort());
  if (res.status !== 200) return { res, events: [] };
  const events = [];
  const reader = res.body.getReader();
  let buffer = "";
  (async () => {
    for (;;) {
      const { value, done } = await reader.read().catch(() => ({ done: true }));
      if (done) return;
      buffer += Buffer.from(value).toString();
      for (const block of buffer.split("\n\n").slice(0, -1)) {
        const data = block.match(/^data: (.*)$/m)?.[1];
        if (data) events.push(JSON.parse(data));
      }
      buffer = buffer.slice(buffer.lastIndexOf("\n\n") + 2);
    }
  })();
  return { res, events };
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 80));

describe("event stream", () => {
  it("needs a user, and says it is a stream", async (t) => {
    const { base, call } = await startDemo(t);
    await assertError(await call("/stream"), 401, "UNAUTHENTICATED");
    const { res } = await listen(t, base, MANAGER);
    assert.equal(res.headers.get("content-type"), "text/event-stream");
    assert.equal(res.headers.get("cache-control"), "no-store");
  });

  it("delivers a message only to members of its group", async (t) => {
    const { base, call } = await startDemo(t);
    const member = await listen(t, base, DESIGNER);
    const outsider = await listen(t, base, PR_HEAD);
    await tick();
    await call(`/groups/g-${ID}-stage-decor/messages`, {
      as: MANAGER,
      method: "POST",
      body: { text: "Reveal rehearsal at 4" },
    });
    await tick();
    assert.ok(
      member.events.some(
        ({ type, message }) =>
          type === "message.created" && message.text === "Reveal rehearsal at 4",
      ),
    );
    assert.ok(!outsider.events.some(({ message }) => message?.text === "Reveal rehearsal at 4"));
  });

  it("never sends another event's messages", async (t) => {
    const { base, call } = await startDemo(t);
    const { event } = await (
      await call("/events", { method: "POST", body: { eventType: "birthday" } })
    ).json();
    const other = await listen(t, base, `user-manager@${event.id}`);
    await tick();
    await call(`/groups/g-${ID}-core-team/messages`, {
      as: MANAGER,
      method: "POST",
      body: { text: "private" },
    });
    await tick();
    assert.deepEqual(other.events, []);
  });

  it("pings budget changes to the manager and core members, with no figures in them", async (t) => {
    const { base, call } = await startDemo(t);
    const manager = await listen(t, base, MANAGER);
    await tick();
    const { changeId } = await (
      await call(`/events/${ID}/changes`, {
        as: MANAGER,
        method: "POST",
        body: { text: "add 10 guests" },
      })
    ).json();
    await call(`/events/${ID}/changes/${changeId}/accept`, {
      as: MANAGER,
      method: "POST",
      body: {},
    });
    await tick();
    const ping = manager.events.find(({ type }) => type === "budget.updated");
    assert.deepEqual(Object.keys(ping).sort(), ["eventId", "type"]);
    assert.ok(manager.events.some(({ type }) => type === "timeline.updated"));
    assert.ok(manager.events.some(({ type }) => type === "notice.created"));
  });

  it("limits connections per person", async (t) => {
    const { base } = await startDemo(t);
    const results = [];
    for (let i = 0; i < 6; i++) results.push(await listen(t, base, MANAGER));
    assert.deepEqual(
      results.map(({ res }) => res.status),
      [200, 200, 200, 200, 200, 429],
    );
  });
});

describe("hub", () => {
  it("forgets a client that has closed", () => {
    const hub = createHub();
    const res = {
      handlers: {},
      writeHead() {},
      write() {},
      on(name, fn) {
        this.handlers[name] = fn;
      },
      end() {},
    };
    assert.equal(hub.add(res, { id: "u1" }), true);
    assert.equal(hub.size(), 1);
    res.handlers.close();
    assert.equal(hub.size(), 0);
    hub.close();
  });

  it("sends a heartbeat comment to keep the connection open", async () => {
    const hub = createHub({ heartbeatMs: 10 });
    const written = [];
    hub.add(
      { writeHead() {}, write: (chunk) => written.push(chunk), on() {}, end() {} },
      { id: "u1" },
    );
    await new Promise((resolve) => setTimeout(resolve, 40));
    hub.close();
    assert.ok(written.some((chunk) => chunk.startsWith(": heartbeat")));
  });
});
