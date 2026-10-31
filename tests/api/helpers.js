import assert from "node:assert/strict";
import { createApp } from "../../server/app.js";
import { errorHandler } from "../../server/http.js";
import { createStore } from "../../server/store/index.js";

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
