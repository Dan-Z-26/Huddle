import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import {
  createAiLimiter,
  errorHandler,
  HttpError,
  requireUser,
  validate,
} from "../../server/http.js";
import { createStore } from "../../server/store/index.js";
import { assertError, serve } from "./helpers.js";

function storeWithUsers() {
  const store = createStore();
  store.users.set("u-manager", { id: "u-manager", name: "Asha", kind: "manager" });
  store.users.set("u with space", { id: "u with space", name: "Ravi", kind: "core" });
  store.users.set("agent-planner", { id: "agent-planner", name: "Planner", kind: "agent" });
  return store;
}

async function serveWhoAmI(t) {
  return serve(t, {
    store: storeWithUsers(),
    mount: (app) => app.get("/t/me", requireUser, (req, res) => res.json({ id: req.user.id })),
  });
}

const getMe = (base, cookie) =>
  fetch(`${base}/t/me`, cookie === undefined ? {} : { headers: { cookie } });

test("requireUser returns 401 without a usable cookie", async (t) => {
  const base = await serveWhoAmI(t);
  const rejected = [
    undefined,
    "other=u-manager",
    "huddle_session=nobody",
    "huddle_session=",
    "huddle_session",
    ";;;=;=",
    "huddle_session=%E0%A4%A",
    "huddle_session=__proto__",
    "huddle_session=constructor",
    "__proto__=u-manager",
    "huddle_session=agent-planner",
  ];
  for (const cookie of rejected) {
    await assertError(await getMe(base, cookie), 401, "UNAUTHENTICATED");
  }
});

test("requireUser resolves a live session to req.user, and the role comes from the server", async (t) => {
  const store = storeWithUsers();
  const base = await serve(t, {
    store,
    mount: (app) => app.get("/t/me", requireUser, (req, res) => res.json({ id: req.user.id })),
  });
  const session = store.openSession("u-manager");
  for (const cookie of [
    `huddle_session=${session}`,
    `a=1; __proto__=x; huddle_session=${session}; b=2`,
  ]) {
    const res = await getMe(base, cookie);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { id: "u-manager" });
  }
  // Naming a person in the cookie gets you nowhere: only a session id the server issued counts.
  await assertError(await getMe(base, "huddle_session=u-manager"), 401, "UNAUTHENTICATED");
  store.sessions.get(session).startedAt = 0;
  await assertError(await getMe(base, `huddle_session=${session}`), 401, "UNAUTHENTICATED");
  const agent = store.openSession("agent-planner");
  await assertError(await getMe(base, `huddle_session=${agent}`), 401, "UNAUTHENTICATED");
});

test("validate passes parsed body, params and query through req.valid", async (t) => {
  const schema = z.object({
    body: z.object({ name: z.string().max(5) }),
    params: z.object({ id: z.string().max(10) }),
    query: z.object({ limit: z.coerce.number().int() }),
  });
  const base = await serve(t, {
    mount: (app) => app.post("/t/items/:id", validate(schema), (req, res) => res.json(req.valid)),
  });

  const res = await fetch(`${base}/t/items/i1?limit=5`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Asha", dropped: true }),
  });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), {
    body: { name: "Asha" },
    params: { id: "i1" },
    query: { limit: 5 },
  });
});

test("validate fails with 400 and a message that echoes no input", async (t) => {
  const base = await serve(t, {
    mount: (app) => {
      const nameSchema = z.object({ body: z.object({ name: z.string().max(5) }) });
      app.post("/t/name", validate(nameSchema), (_req, res) => res.end());
      const strictSchema = z.strictObject({ body: z.strictObject({}) });
      app.post("/t/strict", validate(strictSchema), (_req, res) => res.end());
      const querySchema = z.object({ query: z.object({ limit: z.coerce.number().int() }) });
      app.get("/t/query", validate(querySchema), (_req, res) => res.end());
    },
  });
  const post = (path, body) =>
    fetch(`${base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  const tooLong = await assertError(
    await post("/t/name", { name: "secret-value" }),
    400,
    "BAD_REQUEST",
  );
  assert.equal(tooLong.message, "Invalid request: body.name");

  const unknownKey = await assertError(
    await post("/t/strict", { "secret-key": 1 }),
    400,
    "BAD_REQUEST",
  );
  assert.doesNotMatch(unknownKey.message, /secret-key/);

  // Express 5 leaves req.body undefined when no body was sent.
  await assertError(await fetch(`${base}/t/name`, { method: "POST" }), 400, "BAD_REQUEST");
  await assertError(await fetch(`${base}/t/query?limit=abc`), 400, "BAD_REQUEST");
});

test("HttpError reaches the client with its status, code and message", async (t) => {
  const base = await serve(t, {
    mount: (app) =>
      app.get("/t/forbidden", () => {
        throw HttpError(403, "FORBIDDEN", "Managers only.");
      }),
  });
  const error = await assertError(await fetch(`${base}/t/forbidden`), 403, "FORBIDDEN");
  assert.equal(error.message, "Managers only.");
});

test("the limiter returns 429 in the error shape after max, per instance", async (t) => {
  const mountLimited = (app) =>
    app.get("/t/ai", createAiLimiter({ windowMs: 60_000, max: 2 }), (_req, res) => res.end());
  const base = await serve(t, { mount: mountLimited });
  const otherBase = await serve(t, { mount: mountLimited });

  assert.equal((await fetch(`${base}/t/ai`)).status, 200);
  assert.equal((await fetch(`${base}/t/ai`)).status, 200);
  await assertError(await fetch(`${base}/t/ai`), 429, "RATE_LIMITED");

  assert.equal((await fetch(`${otherBase}/t/ai`)).status, 200);
});

test("errorHandler hands off once headers are sent, rather than writing twice", (t) => {
  const next = t.mock.fn();
  const res = { headersSent: true, status: t.mock.fn() };
  const err = new Error("late");
  errorHandler(err, {}, res, next);
  assert.deepEqual(next.mock.calls[0].arguments, [err]);
  assert.equal(res.status.mock.callCount(), 0);
});

test("a library 5xx stays a generic 500, whatever its own status and message", async (t) => {
  t.mock.method(console, "error", () => {});
  const base = await serve(t, {
    mount: (app) =>
      app.get("/t/upstream", () => {
        throw Object.assign(new Error("sk-secret-key"), { status: 503 });
      }),
  });
  const error = await assertError(await fetch(`${base}/t/upstream`), 500, "INTERNAL");
  assert.equal(error.message, "Something went wrong.");
});
