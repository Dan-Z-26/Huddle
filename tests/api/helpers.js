import assert from "node:assert/strict";
import { createApp } from "../../server/app.js";
import { errorHandler } from "../../server/http.js";
import { createStore } from "../../server/store/index.js";
import { DEMO_EVENT_ID, seedDemo } from "../../server/store/seed.js";
import { createEvent, createWorkspace } from "../../server/store/workspace.js";

// Demo mode: no provider keys, so no network.
for (const key of Object.keys(process.env)) if (/_API_KEY$/.test(key)) delete process.env[key];

const SEEDED_AT = "2026-10-31T09:00:00.000Z";

/**
 * Starts the app on port 0 and closes it when the test ends.
 * Mount throwaway routes outside /api: they sit after createApp's /api 404 and error handler, so
 * this adds a second error handler behind them.
 * @param {import("node:test").TestContext} t
 * @param {{ store?: object, mount?: (app: import("express").Express) => void }} [options]
 * @returns {Promise<string>} Base URL.
 */
export async function serve(t, { store = createStore(), mount } = {}) {
  const app = createApp({ store });
  mount?.(app);
  app.use(errorHandler);

  const server = await new Promise((resolve, reject) => {
    const listening = app.listen(0, "127.0.0.1", (err) => (err ? reject(err) : resolve(listening)));
  });
  t.after(() => {
    server.closeAllConnections();
    return new Promise((resolve) => server.close(resolve));
  });
  return `http://127.0.0.1:${server.address().port}`;
}

/**
 * Asserts a response is the shared error shape with the given status and code.
 * @param {Response} res
 * @param {number} status
 * @param {string} code
 * @returns {Promise<{ code: string, message: string }>} The error object.
 */
export async function assertError(res, status, code) {
  assert.equal(res.status, status);
  assert.match(res.headers.get("content-type"), /^application\/json/);
  const body = await res.json();
  assert.deepEqual(Object.keys(body), ["error"]);
  assert.deepEqual(Object.keys(body.error).sort(), ["code", "message"]);
  assert.equal(body.error.code, code);
  return body.error;
}

/**
 * Serves a store seeded with the demo event, and returns a JSON caller that acts as a given user.
 * @param {import("node:test").TestContext} t
 * @returns {Promise<{store: object, call: Function}>} The store, and `call(path, { as, method, body })`.
 */
export async function startDemo(t) {
  const store = createStore();
  seedDemo(store, SEEDED_AT);
  const base = await serve(t, { store });
  const call = (path, { as, method = "GET", body } = {}) =>
    fetch(`${base}/api${path}`, {
      method,
      headers: {
        ...(as ? { cookie: `huddle_user=${encodeURIComponent(as)}` } : {}),
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  return { store, call };
}

/**
 * Adds a second, complete event by copying the demo profile, for tests that need two workspaces.
 * @param {object} store A store holding the demo event.
 * @param {object} [overrides] Profile fields to replace; `id` defaults to "other".
 * @returns {object} The new event.
 */
export function addEvent(store, overrides = {}) {
  const profile = {
    ...structuredClone(store.events.get(DEMO_EVENT_ID)),
    id: "other",
    intakeStatus: "in_progress",
    ...overrides,
  };
  const { event } = createEvent(store, { eventType: profile.eventType, id: profile.id, profile });
  createWorkspace(store, event, SEEDED_AT);
  return event;
}

/**
 * Serialises everything a route could change, so a refused call can be shown to change nothing.
 * @param {object} store The store.
 * @returns {string} A comparable snapshot.
 */
export const snapshot = (store) =>
  JSON.stringify(
    ["events", "budgets", "tasks", "groups", "messages", "pendingChanges"].map((name) => [
      ...store[name],
    ]),
  );
