import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { rewordLines, speak } from "../../server/agents/speech.js";
import { failingModel, fakeModel } from "./fixtures.js";

const input = {
  agent: "Vendor",
  situation: "A brief was approved.",
  facts: ["The PR brief is approved. You can send it out."],
  fallback: "The PR brief is approved. You can send it out.",
};

describe("speak", () => {
  it("uses what the model wrote, and tells it who is speaking", async () => {
    const wording = "Good news: Asha signed off the PR brief, so it can go out to vendors now.";
    const { generate, calls } = fakeModel({ wording, rationale: "Told by the facts." });
    assert.equal((await speak(input, { generate })).wording, wording);
    assert.match(calls[0].messages[0].content, /You are the Vendor agent/);
    assert.match(calls[0].messages[0].content, /UNTRUSTED facts/);
  });

  it("refuses a figure nobody gave, or an amount, and says the plain thing instead", async () => {
    for (const wording of [
      "The brief is approved, send it to 12 vendors.",
      "It came in at ₹5 lakh.",
    ]) {
      const { generate } = fakeModel({ wording, rationale: "x" });
      assert.equal((await speak(input, { generate })).wording, input.fallback);
    }
  });

  it("says the plain thing when the model is down, or there is no key", async () => {
    assert.equal((await speak(input, { generate: failingModel })).wording, input.fallback);
    assert.equal((await speak(input)).wording, input.fallback);
  });
});

describe("rewordLines", () => {
  const lines = ["This is the core room.", "Ask @huddle for a brief."];

  it("uses the model's lines, and keeps any that stray", async () => {
    const { generate } = fakeModel({ lines: ["Core team lives here.", "It costs ₹9 lakh."] });
    assert.deepEqual(await rewordLines({ lines, context: "{}" }, { generate }), [
      "Core team lives here.",
      lines[1],
    ]);
  });

  it("keeps them all when the count is wrong, or the model is down", async () => {
    const { generate } = fakeModel({ lines: ["Just one."] });
    assert.deepEqual(await rewordLines({ lines, context: "{}" }, { generate }), lines);
    assert.deepEqual(
      await rewordLines({ lines, context: "{}" }, { generate: failingModel }),
      lines,
    );
  });
});
