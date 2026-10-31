import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { assertError, startDemo } from "./helpers.js";

const ID = "demo";
const ask = (call, as) => call(`/events/${ID}/advice`, { as, method: "POST" });

describe("POST /events/:id/advice", () => {
  it("gives the manager next steps with somewhere to go", async (t) => {
    const { call } = await startDemo(t);
    const { items } = await (await ask(call, "user-manager@demo")).json();
    assert.ok(items.length > 0);
    assert.ok(items.every(({ action, title, why }) => action && title && why));
  });

  it("is manager only: it reads budget figures", async (t) => {
    const { call } = await startDemo(t);
    await assertError(await ask(call, "user-pr-head@demo"), 403, "FORBIDDEN");
  });
});

describe("the AI budget", () => {
  it("isn't used up by tapped setup answers", async (t) => {
    const { call } = await startDemo(t);
    const { event } = await (
      await call("/events", { method: "POST", body: { eventType: "birthday" } })
    ).json();
    const as = `user-manager@${event.id}`;
    for (let i = 0; i < 60; i++) {
      const res = await call(`/events/${event.id}/intake`, {
        as,
        method: "POST",
        body: { answer: `Name ${i}`, mode: "direct" },
      });
      assert.equal(res.status, 200);
      // Stay on the same question, so every tap is a real one.
      await call(`/events/${event.id}/profile`, { as, method: "PATCH", body: { name: "" } });
    }
  });
});
