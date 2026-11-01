import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { defaultAnswers, draftBrief, formatBrief } from "../../server/agents/hiring.js";
import { failingModel, fakeModel, profile } from "./fixtures.js";

const category = { id: "decor", name: "Décor" };
const answers = { ...defaultAnswers(profile, category), deliverables: "" };
const HEADINGS = [
  "About the event",
  "Scope",
  "Dates and place",
  "Must-haves",
  "How we will choose",
  "What to hand over",
  "What to send back",
];
const written = {
  about: "A launch that unveils the Nova X1 to partners and press.",
  scope: "Design and build the reveal stage.",
  dates: "12 March 2027 in Pune.",
  mustHaves: ["A branded reveal stage"],
  howWeChoose: "Fit, clear pricing and reliability.",
  deliverables: ["Stage drawings", "Fire safety certificate"],
};
const partsOf = (text) => text.split("\n\n").map((part) => part.split("\n")[0]);

describe("the brief's layout", () => {
  it("is the same whether the AI wrote it, the model failed, or there is no key", async () => {
    const { generate } = fakeModel(written);
    for (const deps of [{ generate }, { generate: failingModel }, undefined]) {
      const { text } = await draftBrief({ profile, category, answers }, deps);
      assert.deepEqual(partsOf(text), ["Hiring brief: Décor", ...HEADINGS]);
    }
  });

  it("uses what the AI wrote, with lists as lists", async () => {
    const { generate } = fakeModel(written);
    const { text, deliverables } = await draftBrief({ profile, category, answers }, { generate });
    assert.match(text, /Scope\nDesign and build the reveal stage\./);
    assert.match(text, /Must-haves\n- A branded reveal stage/);
    assert.match(text, /What to hand over\n- Stage drawings\n- Fire safety certificate/);
    assert.deepEqual(deliverables, written.deliverables);
  });

  it("tidies what someone typed, and keeps the deliverables they asked for", async () => {
    const typed = {
      ...answers,
      scope: "stage and backdrop only",
      mustHaves: "led wall, fire exits",
      deliverables: "site plan, insurance",
    };
    const { text, deliverables } = await draftBrief(
      { profile, category, answers: typed },
      { generate: failingModel },
    );
    assert.match(text, /Scope\nStage and backdrop only\./);
    assert.match(text, /Must-haves\n- led wall\n- fire exits/);
    assert.deepEqual(deliverables, ["site plan", "insurance"]);
  });

  it("replaces only the part holding money or an invented figure", async () => {
    const { generate } = fakeModel({
      ...written,
      scope: "Build the stage for ₹5 lakh.",
      dates: "Over 45 days of setup.",
    });
    const { text } = await draftBrief({ profile, category, answers }, { generate });
    assert.doesNotMatch(text, /₹|lakh|45 days/);
    assert.match(text, /Hiring|About the event\nA launch that unveils/);
    assert.ok(text.includes(answers.scope));
  });

  it("says what is still open rather than leaving a gap", () => {
    const text = formatBrief({
      category,
      sections: { about: "", scope: "", dates: "", mustHaves: [], howWeChoose: "" },
      deliverables: ["Setup plan"],
    });
    assert.match(text, /Must-haves\nTo be confirmed\./);
    assert.match(text, /Scope\nTo be confirmed\./);
  });
});
