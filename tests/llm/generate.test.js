import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { z } from "zod";
import { generate } from "../../server/llm/index.js";

const schema = z.object({ answer: z.string(), rationale: z.string() });
const good = JSON.stringify({ answer: "42", rationale: "because" });
const ENV = {
  GEMINI_API_KEY: "k",
  GEMINI_FAST_MODEL: "fast",
  GEMINI_SMART_MODEL: "smart",
  LLM_MAX_PER_MINUTE: "1000",
};
const messages = [{ role: "user", content: "hi" }];

// A fake provider: `respond(request, callNumber)` decides each reply; `calls` records requests.
function fakeProvider(respond) {
  const calls = [];
  return {
    calls,
    step: async (request) => {
      calls.push({ ...request, messages: [...request.messages] });
      return respond(request, calls.length);
    },
  };
}

const add = {
  name: "add",
  description: "adds",
  parameters: z.object({ a: z.number(), b: z.number() }),
  handler: ({ a, b }) => ({ sum: a + b }),
};

describe("generate: demo mode", () => {
  it("runs the heuristic, with tools, and validates its output", async () => {
    const result = await generate({
      agent: "budget",
      messages,
      schema,
      tools: [add],
      env: {},
      demo: async ({ callTool }) => {
        const { sum } = await callTool({ name: "add", args: { a: 2, b: 3 } });
        return { answer: String(sum), rationale: "demo" };
      },
    });
    assert.deepEqual(result.data, { answer: "5", rationale: "demo" });
    assert.equal(result.demo, true);
    assert.equal(result.toolCalls[0].result.sum, 5);
  });

  it("rejects heuristic output that breaks the schema", async () => {
    await assert.rejects(
      generate({ agent: "budget", messages, schema, env: {}, demo: async () => ({ answer: 1 }) }),
    );
  });

  it("fails clearly when an agent has no heuristic", async () => {
    await assert.rejects(generate({ agent: "budget", messages, schema, env: {} }), /no demo/);
  });
});

describe("generate: live", () => {
  it("returns validated data from a schema-only call, with no tools sent", async () => {
    const gemini = fakeProvider(() => ({ text: good, toolCalls: [] }));
    const result = await generate({
      agent: "planner",
      system: "s",
      messages,
      schema,
      env: ENV,
      providers: { gemini },
    });
    assert.deepEqual(result.data, { answer: "42", rationale: "because" });
    assert.deepEqual([result.provider, result.model, result.demo], ["gemini", "fast", false]);
    assert.equal(gemini.calls.length, 1);
    assert.deepEqual(gemini.calls[0].tools, []);
    assert.equal(gemini.calls[0].jsonSchema.type, "object");
    assert.equal("$schema" in gemini.calls[0].jsonSchema, false);
  });

  it("accepts JSON wrapped in a code fence", async () => {
    const gemini = fakeProvider(() => ({ text: "```json\n" + good + "\n```", toolCalls: [] }));
    const result = await generate({
      agent: "planner",
      messages,
      schema,
      env: ENV,
      providers: { gemini },
    });
    assert.equal(result.data.answer, "42");
  });

  it("runs tools first without a schema, then asks for the schema answer without tools", async () => {
    const gemini = fakeProvider((request, n) =>
      n === 1
        ? { text: "", toolCalls: [{ id: "c1", name: "add", args: { a: 2, b: 3 } }], raw: { r: 1 } }
        : request.tools.length > 0
          ? { text: "done", toolCalls: [] }
          : { text: good, toolCalls: [] },
    );
    const result = await generate({
      agent: "budget",
      messages,
      schema,
      tools: [add],
      env: ENV,
      providers: { gemini },
    });
    assert.deepEqual(result.toolCalls, [{ name: "add", args: { a: 2, b: 3 }, result: { sum: 5 } }]);
    const [first, second] = gemini.calls;
    assert.equal(first.jsonSchema, undefined);
    assert.equal(first.tools[0].name, "add");
    assert.deepEqual(second.messages.at(-1), {
      role: "tool",
      results: [{ id: "c1", name: "add", result: { sum: 5 } }],
    });
    assert.equal(second.messages.at(-2).raw.r, 1);
    const last = gemini.calls.at(-1);
    assert.deepEqual(last.tools, []);
    assert.ok(last.jsonSchema);
  });

  it("stops at 4 tool calls even if the model keeps asking", async () => {
    let ran = 0;
    const counted = { ...add, handler: () => ({ n: (ran += 1) }) };
    const gemini = fakeProvider((request) =>
      request.tools.length > 0
        ? { text: "", toolCalls: [{ id: "x", name: "add", args: { a: 1, b: 1 } }] }
        : { text: good, toolCalls: [] },
    );
    const result = await generate({
      agent: "budget",
      messages,
      schema,
      tools: [counted],
      env: ENV,
      providers: { gemini },
    });
    assert.equal(ran, 4);
    assert.equal(result.toolCalls.length, 4);
    assert.deepEqual(gemini.calls.at(-1).tools, []);
  });

  it("trims a batch of tool calls to the cap", async () => {
    let ran = 0;
    const counted = { ...add, handler: () => ({ n: (ran += 1) }) };
    const six = Array.from({ length: 6 }, (_, i) => ({
      id: `c${i}`,
      name: "add",
      args: { a: 1, b: 1 },
    }));
    const gemini = fakeProvider((request) =>
      request.tools.length > 0 ? { text: "", toolCalls: six } : { text: good, toolCalls: [] },
    );
    await generate({
      agent: "budget",
      messages,
      schema,
      tools: [counted],
      env: ENV,
      providers: { gemini },
    });
    assert.equal(ran, 4);
  });

  it("gives the model an error result for bad tool arguments", async () => {
    const gemini = fakeProvider((request, n) =>
      n === 1
        ? { text: "", toolCalls: [{ id: "c", name: "add", args: { a: "x" } }] }
        : request.tools.length > 0
          ? { text: "ok", toolCalls: [] }
          : { text: good, toolCalls: [] },
    );
    const result = await generate({
      agent: "budget",
      messages,
      schema,
      tools: [add],
      env: ENV,
      providers: { gemini },
    });
    assert.deepEqual(result.toolCalls[0].result, { error: "invalid arguments" });
  });

  it("retries once on invalid output, telling the model what was wrong", async () => {
    const gemini = fakeProvider((_request, n) => ({
      text: n === 1 ? "not json" : good,
      toolCalls: [],
    }));
    const result = await generate({
      agent: "planner",
      messages,
      schema,
      env: ENV,
      providers: { gemini },
    });
    assert.equal(result.data.answer, "42");
    assert.equal(gemini.calls.length, 2);
    assert.match(gemini.calls[1].messages.at(-1).content, /not JSON/);
  });

  it("throws an LlmError after two invalid replies, without echoing them", async () => {
    const gemini = fakeProvider(() => ({
      text: '{"answer": 5, "secret": "do not leak"}',
      toolCalls: [],
    }));
    await assert.rejects(
      generate({ agent: "planner", messages, schema, env: ENV, providers: { gemini } }),
      (err) => err.name === "LlmError" && !err.message.includes("leak"),
    );
    assert.equal(gemini.calls.length, 4, "twice on the model, then twice on its fallback");
  });

  it("gives the provider a timeout signal", async () => {
    const gemini = fakeProvider(() => ({ text: good, toolCalls: [] }));
    await generate({ agent: "planner", messages, schema, env: ENV, providers: { gemini } });
    assert.ok(gemini.calls[0].signal instanceof AbortSignal);
  });
});

describe("generate: failures and fallback", () => {
  const FALLBACK_ENV = {
    ...ENV,
    ANTHROPIC_API_KEY: "a",
    FALLBACK_PROVIDER: "anthropic",
    FALLBACK_MODEL: "fb",
  };
  const failing = (status) =>
    fakeProvider(() => {
      throw Object.assign(new Error("secret provider detail"), { status });
    });
  const working = () => fakeProvider(() => ({ text: good, toolCalls: [] }));

  for (const status of [429, 500, 503]) {
    it(`retries once on the fallback provider after a ${status}`, async () => {
      const anthropic = working();
      const result = await generate({
        agent: "planner",
        messages,
        schema,
        env: FALLBACK_ENV,
        providers: { gemini: failing(status), anthropic },
      });
      assert.deepEqual([result.provider, result.model], ["anthropic", "fb"]);
    });
  }

  it("does not use the fallback for a client error such as 400", async () => {
    const anthropic = working();
    await assert.rejects(
      generate({
        agent: "planner",
        messages,
        schema,
        env: FALLBACK_ENV,
        providers: { gemini: failing(400), anthropic },
      }),
      (err) => err.name === "LlmError" && !err.message.includes("secret"),
    );
    assert.equal(anthropic.calls.length, 0);
  });

  it("fails with a safe LlmError when there is no fallback", async () => {
    await assert.rejects(
      generate({
        agent: "planner",
        messages,
        schema,
        env: ENV,
        providers: { gemini: failing(429) },
      }),
      (err) => err.name === "LlmError" && err.status === 429 && !err.message.includes("secret"),
    );
  });

  it("fails when the fallback fails too", async () => {
    await assert.rejects(
      generate({
        agent: "planner",
        messages,
        schema,
        env: FALLBACK_ENV,
        providers: { gemini: failing(500), anthropic: failing(500) },
      }),
      (err) => err.name === "LlmError",
    );
  });

  it("treats a timeout as retryable", async () => {
    const timeout = fakeProvider(() => {
      throw Object.assign(new Error("t"), { name: "TimeoutError" });
    });
    const result = await generate({
      agent: "planner",
      messages,
      schema,
      env: FALLBACK_ENV,
      providers: { gemini: timeout, anthropic: working() },
    });
    assert.equal(result.provider, "anthropic");
  });
});

describe("generate: tool stage ending in text", () => {
  const ENV2 = { GEMINI_API_KEY: "k", GEMINI_FAST_MODEL: "m", GEMINI_SMART_MODEL: "m" };
  const tool = { name: "t", description: "d", parameters: z.object({}), handler: () => 1 };

  it("uses a valid answer from the tool stage without another call", async () => {
    const gemini = fakeProvider(() => ({ text: '{"answer":"yes"}', toolCalls: [] }));
    const shape = z.object({ answer: z.string() });
    const { data } = await generate({
      agent: "planner",
      messages,
      schema: shape,
      tools: [tool],
      env: ENV2,
      providers: { gemini },
    });
    assert.deepEqual(data, { answer: "yes" });
    assert.equal(gemini.calls.length, 1);
  });

  it("ends on the user's turn before asking for the final answer", async () => {
    const replies = ["some prose", '{"answer":"yes"}'];
    const gemini = fakeProvider(() => ({ text: replies.shift(), toolCalls: [] }));
    await generate({
      agent: "planner",
      messages,
      schema: z.object({ answer: z.string() }),
      tools: [tool],
      env: ENV2,
      providers: { gemini },
    });
    assert.equal(gemini.calls.at(-1).messages.at(-1).role, "user");
  });

  it("honours a lower tool cap", async () => {
    const gemini = fakeProvider((request) =>
      request.tools.length
        ? { text: "", toolCalls: [{ id: "1", name: "t", args: {} }] }
        : { text: '{"answer":"yes"}', toolCalls: [] },
    );
    const { toolCalls } = await generate({
      agent: "planner",
      messages,
      schema: z.object({ answer: z.string() }),
      tools: [tool],
      maxToolCalls: 1,
      env: ENV2,
      providers: { gemini },
    });
    assert.equal(toolCalls.length, 1);
  });
});

describe("generate: timeouts", () => {
  const ENV3 = {
    GEMINI_API_KEY: "k",
    GEMINI_FAST_MODEL: "m",
    GEMINI_SMART_MODEL: "m",
    LLM_TIMEOUT_MS: "1000",
  };
  const good2 = '{"answer":"yes"}';
  const shape = z.object({ answer: z.string() });

  it("gives a request with a file three times as long to answer", async () => {
    const seen = [];
    const gemini = fakeProvider((request) => {
      seen.push(request.signal);
      return { text: good2, toolCalls: [] };
    });
    const run = (files) =>
      generate({
        agent: "vendor",
        messages,
        schema: shape,
        files,
        env: ENV3,
        providers: { gemini },
      });
    await run([]);
    await run([{ mime: "application/pdf", buffer: Buffer.from("%PDF-"), name: "q.pdf" }]);
    assert.equal(seen.length, 2);
    assert.ok(seen.every((signal) => signal instanceof AbortSignal));
  });
});

describe("generate: pacing calls per minute", () => {
  const answering = () => {
    const made = [];
    return {
      made,
      gemini: {
        step: async () => {
          made.push(Date.now());
          return { text: '{"ok":true}', toolCalls: [] };
        },
      },
    };
  };
  const ask = (model, gemini, perMinute) =>
    generate({
      agent: "budget",
      system: "s",
      messages: [{ role: "user", content: "hi" }],
      schema: z.object({ ok: z.boolean() }),
      demo: async () => ({ ok: false }),
      env: {
        GEMINI_API_KEY: "k",
        GEMINI_FAST_MODEL: model,
        GEMINI_SMART_MODEL: model,
        LLM_MAX_PER_MINUTE: String(perMinute),
      },
      providers: { gemini },
    });

  it("lets calls through up to the limit", async () => {
    const { gemini, made } = answering();
    await Promise.all([1, 2, 3].map(() => ask("pace-a", gemini, 3)));
    assert.equal(made.length, 3);
  });

  it("fails fast past the limit rather than waiting most of a minute", async () => {
    const { gemini, made } = answering();
    await ask("pace-b", gemini, 1);
    await assert.rejects(ask("pace-b", gemini, 1), (err) => {
      assert.equal(err.name, "LlmError");
      assert.equal(err.status, 429);
      return true;
    });
    assert.equal(made.length, 1);
  });

  it("keeps each model's count separate", async () => {
    const { gemini, made } = answering();
    await ask("pace-c", gemini, 1);
    await ask("pace-d", gemini, 1);
    assert.equal(made.length, 2);
  });
});
