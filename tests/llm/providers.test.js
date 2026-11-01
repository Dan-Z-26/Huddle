import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { step as anthropicStep, toMessages } from "../../server/llm/providers/anthropic.js";
import { step as geminiStep, toContents } from "../../server/llm/providers/gemini.js";

const pdf = { mime: "application/pdf", buffer: Buffer.from("PDF"), name: "q.pdf" };
const png = { mime: "image/png", buffer: Buffer.from("PNG"), name: "m.png" };
const conversation = [
  { role: "user", content: "hello" },
  { role: "assistant", toolCalls: [{ id: "c1", name: "add", args: { a: 1 } }] },
  { role: "tool", results: [{ id: "c1", name: "add", result: { sum: 1 } }] },
  { role: "assistant", content: "done" },
];

describe("toContents (Gemini)", () => {
  it("maps roles, tool calls and tool results", () => {
    const contents = toContents(conversation);
    assert.deepEqual(contents[0], { role: "user", parts: [{ text: "hello" }] });
    assert.deepEqual(contents[1], {
      role: "model",
      parts: [{ functionCall: { name: "add", args: { a: 1 } } }],
    });
    assert.deepEqual(contents[2], {
      role: "user",
      parts: [{ functionResponse: { name: "add", response: { result: { sum: 1 } } } }],
    });
    assert.deepEqual(contents[3], { role: "model", parts: [{ text: "done" }] });
  });

  it("replays the raw model turn so thought signatures survive", () => {
    const raw = {
      role: "model",
      parts: [{ functionCall: { name: "add" }, thoughtSignature: "sig" }],
    };
    const contents = toContents([conversation[0], { ...conversation[1], raw }]);
    assert.equal(contents[1], raw);
  });

  it("attaches files to the first user message only, as base64", () => {
    const contents = toContents(conversation, [pdf, png]);
    assert.deepEqual(contents[0].parts.slice(0, 2), [
      { inlineData: { mimeType: "application/pdf", data: Buffer.from("PDF").toString("base64") } },
      { inlineData: { mimeType: "image/png", data: Buffer.from("PNG").toString("base64") } },
    ]);
    assert.equal(contents[0].parts.at(-1).text, "hello");
    assert.equal(contents[2].parts.length, 1);
  });
});

describe("toMessages (Anthropic)", () => {
  it("maps tool calls and results to tool_use and tool_result blocks", () => {
    const messages = toMessages(conversation);
    assert.deepEqual(messages[1].content, [
      { type: "tool_use", id: "c1", name: "add", input: { a: 1 } },
    ]);
    assert.deepEqual(messages[2], {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "c1", content: '{"sum":1}' }],
    });
  });

  it("sends PDFs as documents and images as images", () => {
    const [first] = toMessages(conversation, [pdf, png]);
    assert.equal(first.content[0].type, "document");
    assert.equal(first.content[0].source.media_type, "application/pdf");
    assert.equal(first.content[1].type, "image");
    assert.equal(first.content.at(-1).text, "hello");
  });
});

// The real SDKs with only the network faked, so an SDK upgrade that changes either shape fails here.
describe("a real model turn", () => {
  const replyWith = (t, body, status = 200) =>
    t.mock.method(
      globalThis,
      "fetch",
      async () =>
        new Response(JSON.stringify(body), {
          status,
          headers: { "content-type": "application/json" },
        }),
    );
  const sent = (mocked) => {
    const [url, init] = mocked.mock.calls[0].arguments;
    return { url: String(url), body: JSON.parse(init.body) };
  };
  const tool = { name: "add", description: "Adds", parameters: { type: "object" } };
  const request = {
    model: "test-model",
    system: "Be brief.",
    messages: [{ role: "user", content: "hello" }],
    tools: [],
    files: [],
    signal: AbortSignal.timeout(5000),
  };

  describe("Gemini", () => {
    const answer = (parts) => ({ candidates: [{ content: { role: "model", parts } }] });

    it("asks for the schema and returns the text", async (t) => {
      const fetched = replyWith(t, answer([{ text: '{"a":1}' }]));
      const { text, toolCalls } = await geminiStep({
        ...request,
        apiKey: "g1",
        jsonSchema: { type: "object" },
      });
      assert.equal(text, '{"a":1}');
      assert.deepEqual(toolCalls, []);
      const { url, body } = sent(fetched);
      assert.match(url, /models\/test-model:generateContent/);
      assert.equal(body.generationConfig.responseMimeType, "application/json");
      assert.equal(body.systemInstruction.parts[0].text, "Be brief.");
    });

    it("declares tools, and returns a tool call with no text beside it", async (t) => {
      const parts = [{ functionCall: { name: "add", args: { a: 1 } } }];
      const fetched = replyWith(t, answer(parts));
      const { text, toolCalls, raw } = await geminiStep({
        ...request,
        apiKey: "g2",
        tools: [tool],
      });
      assert.equal(text, "");
      assert.deepEqual(toolCalls, [{ id: "call-0", name: "add", args: { a: 1 } }]);
      assert.deepEqual(raw.parts, parts);
      assert.equal(sent(fetched).body.tools[0].functionDeclarations[0].name, "add");
    });

    it("reports a busy model with its status, which is what triggers the fallback", async (t) => {
      replyWith(t, { error: { code: 429, message: "busy", status: "RESOURCE_EXHAUSTED" } }, 429);
      await assert.rejects(geminiStep({ ...request, apiKey: "g3" }), { status: 429 });
    });
  });

  describe("Anthropic", () => {
    const answer = (content) => ({
      id: "msg",
      type: "message",
      role: "assistant",
      model: "test-model",
      content,
      stop_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1 },
    });

    it("puts the schema in the system prompt and returns the text", async (t) => {
      const fetched = replyWith(t, answer([{ type: "text", text: '{"a":1}' }]));
      const { text, toolCalls } = await anthropicStep({
        ...request,
        apiKey: "a1",
        jsonSchema: { type: "object" },
      });
      assert.equal(text, '{"a":1}');
      assert.deepEqual(toolCalls, []);
      assert.match(sent(fetched).body.system, /^Be brief\.[\s\S]*JSON Schema/);
    });

    it("declares tools and returns a tool call", async (t) => {
      const content = [{ type: "tool_use", id: "c1", name: "add", input: { a: 1 } }];
      const fetched = replyWith(t, answer(content));
      const { toolCalls } = await anthropicStep({ ...request, apiKey: "a2", tools: [tool] });
      assert.deepEqual(toolCalls, [{ id: "c1", name: "add", args: { a: 1 } }]);
      assert.equal(sent(fetched).body.tools[0].input_schema.type, "object");
    });
  });
});
