import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { generateIdeas } from "../../server/agents/ideas.js";
import { demoGenerate, failingModel, fakeModel, profile, state, template } from "./fixtures.js";

const run = (generate, extra = {}) =>
  generateIdeas({ profile, state, template, ...extra }, { generate });
const idea = (overrides = {}) => ({
  title: "A quiet reveal",
  whyItFits: "It suits your press audience.",
  categoryId: "reveal",
  level: "light",
  ...overrides,
});

describe("generateIdeas", () => {
  it("builds ideas from the user's own priorities and wishes in demo mode", async () => {
    const { ideas } = await run(demoGenerate);
    assert.deepEqual(
      ideas.map((i) => i.categoryId),
      ["reveal", "food-beverage", "decor"],
    );
    assert.match(ideas[0].whyItFits, /Product reveal as your #1 priority/);
    assert.match(ideas[0].whyItFits, /inspired and proud/);
    assert.match(ideas[2].whyItFits, /must-have "branded reveal stage"/);
  });

  it("states what each idea means for its category's budget, in code", async () => {
    const { ideas } = await run(demoGenerate);
    assert.match(
      ideas[0].costShare,
      /^A moderate idea within the Product reveal budget of ₹[\d,]+ \(your #1 priority\)\.$/,
    );
    assert.match(ideas[1].costShare, /^A light idea/);
  });

  it("marks an unranked category as such", async () => {
    const { generate } = fakeModel({ ideas: [idea({ categoryId: "music" })], rationale: "ok" });
    const { ideas } = await run(generate);
    assert.match(ideas[0].costShare, /\(not ranked\)\.$/);
  });

  it("drops ideas for unknown categories or with invented numbers, and keeps at most five", async () => {
    const many = Array.from({ length: 6 }, (_, i) =>
      idea({ title: `Idea ${i}`.replace(/\d/, "x") }),
    );
    const { generate } = fakeModel({
      ideas: [
        idea({ categoryId: "fireworks" }),
        idea({ title: "Spend 500000 on a drone show" }),
        ...many,
      ],
      rationale: "ok",
    });
    const { ideas } = await run(generate);
    assert.equal(ideas.length, 5);
    assert.ok(ideas.every((i) => i.categoryId === "reveal" && !/500000|fireworks/.test(i.title)));
  });

  it("sends the profile in delimiters and passes mood boards and floor plans to the model", async () => {
    const { generate, calls } = fakeModel({ ideas: [], rationale: "ok" });
    const files = [{ mime: "image/png", buffer: Buffer.from("png"), name: "moodboard.png" }];
    await run(generate, { files });
    assert.equal(calls[0].agent, "ideas");
    assert.deepEqual(calls[0].files, files);
    assert.match(calls[0].messages[0].content, /<<<UNTRUSTED event profile>>>/);
    assert.match(calls[0].system, /never generic ideas and never default luxury/i);
  });

  it("falls back to the offline ideas when the model fails", async () => {
    const { ideas } = await run(failingModel);
    assert.equal(ideas.length, 3);
  });

  it("does not change the profile or state", async () => {
    const before = structuredClone({ profile, state });
    await run(demoGenerate);
    assert.deepEqual({ profile, state }, before);
  });
});

describe("generateIdeas: very long text", () => {
  it("does not crash offline when the guest feeling is very long", async () => {
    const long = { ...profile, attendeeExperience: "proud ".repeat(80) };
    const { ideas } = await generateIdeas(
      { profile: long, state, template },
      { generate: demoGenerate },
    );
    assert.ok(ideas.length > 0);
  });
});
