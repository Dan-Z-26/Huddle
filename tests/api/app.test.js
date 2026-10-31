import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { createApp } from "../../server/app.js";
import { createStore } from "../../server/store/index.js";
import { assertError, serve } from "./helpers.js";

const postJson = (url, body) =>
  fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body });

test("sets the exact strict CSP and security headers", async (t) => {
  const base = await serve(t);
  const res = await fetch(`${base}/api/anything`);

  const csp = res.headers.get("content-security-policy");
  assert.deepEqual(csp.split(";").sort(), [
    "base-uri 'self'",
    "connect-src 'self'",
    "default-src 'self'",
    "font-src 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "img-src 'self'",
    "object-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
  ]);
  assert.doesNotMatch(csp, /unsafe-inline/);
  assert.doesNotMatch(csp, /upgrade-insecure-requests/);
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  assert.equal(res.headers.get("x-powered-by"), null);
  assert.equal(res.headers.get("access-control-allow-origin"), null);
});

test("unknown API paths return 404 JSON for any method", async (t) => {
  const base = await serve(t);
  await assertError(await fetch(`${base}/api/nope`), 404, "NOT_FOUND");
  await assertError(await fetch(`${base}/api`), 404, "NOT_FOUND");
  await assertError(await fetch(`${base}/api/a/b`, { method: "DELETE" }), 404, "NOT_FOUND");
});

test("API responses, including errors, are never cached", async (t) => {
  const base = await serve(t);
  assert.equal((await fetch(`${base}/api/nope`)).headers.get("cache-control"), "no-store");
});

test("a missing static file is a plain 404, not a crash", async (t) => {
  const base = await serve(t);
  assert.equal((await fetch(`${base}/no-such-file.txt`)).status, 404);
});

test("JSON over 100 kb returns 413; just under the limit is accepted", async (t) => {
  const base = await serve(t, {
    mount: (app) => app.post("/t/echo", (req, res) => res.json({ size: req.body.text.length })),
  });
  const tooBig = await postJson(`${base}/api/x`, JSON.stringify({ text: "a".repeat(102400) }));
  await assertError(tooBig, 413, "PAYLOAD_TOO_LARGE");

  const fits = await postJson(`${base}/t/echo`, JSON.stringify({ text: "a".repeat(102000) }));
  assert.equal(fits.status, 200);
});

test("malformed JSON returns 400 without quoting the body", async (t) => {
  const base = await serve(t);
  const res = await postJson(`${base}/api/x`, '{"secret-value": oops');
  const error = await assertError(res, 400, "BAD_REQUEST");
  assert.doesNotMatch(error.message, /secret-value|oops|JSON/);
});

test("a badly encoded path param returns 400", async (t) => {
  const base = await serve(t, {
    mount: (app) => app.get("/t/items/:id", (_req, res) => res.end()),
  });
  await assertError(await fetch(`${base}/t/items/%E0%A4%A`), 400, "BAD_REQUEST");
});

test("thrown errors return a generic 500 and log nothing sensitive", async (t) => {
  const logged = t.mock.method(console, "error", () => {});
  const base = await serve(t, {
    mount: (app) => {
      app.get("/t/sync", () => {
        throw new Error("sk-secret-key");
      });
      app.get("/t/async", async () => {
        throw new TypeError("sk-secret-key");
      });
    },
  });

  for (const path of ["/t/sync?token=sk-secret-query", "/t/async"]) {
    const res = await fetch(`${base}${path}`);
    const text = await res.clone().text();
    const error = await assertError(res, 500, "INTERNAL");
    assert.equal(error.message, "Something went wrong.");
    assert.doesNotMatch(text, /sk-secret|at .*\.js/);
  }

  const output = logged.mock.calls.flatMap((call) => call.arguments).join(" ");
  assert.match(output, /Unhandled TypeError on GET \/t\/async/);
  assert.doesNotMatch(output, /sk-secret/);
});

test("createApp's own handler turns an unknown error into a safe 500", async (t) => {
  const logged = t.mock.method(console, "error", () => {});
  const app = createApp({ store: createStore() });
  // Fails the first header, inside createApp's helmet, so no route or second handler is added.
  const server = createServer((req, res) => {
    const { setHeader } = res;
    res.setHeader = () => {
      res.setHeader = setHeader;
      throw new TypeError("sk-secret-key");
    };
    app(req, res);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections();
    return new Promise((resolve) => server.close(resolve));
  });
  const base = `http://127.0.0.1:${server.address().port}`;

  for (const path of ["/api/anything", "/index.html"]) {
    const res = await fetch(`${base}${path}`);
    const text = await res.clone().text();
    const error = await assertError(res, 500, "INTERNAL");
    assert.equal(error.message, "Something went wrong.");
    assert.doesNotMatch(text, /sk-secret|at .*\.js/);
  }

  const output = logged.mock.calls.flatMap((call) => call.arguments).join(" ");
  assert.match(output, /Unhandled TypeError on GET \/api\/anything/);
  assert.doesNotMatch(output, /sk-secret/);
});
