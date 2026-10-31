import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { toMessages } from "../../server/llm/providers/anthropic.js";
import { toContents } from "../../server/llm/providers/gemini.js";

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
