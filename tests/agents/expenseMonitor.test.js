import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { alertFacts, wordAlert } from "../../server/agents/expenseMonitor.js";
import { failingModel, fakeModel } from "./fixtures.js";

const alert = { status: "over", name: "AV & production", categoryId: "av" };

describe("alertFacts", () => {
  it("says what crossed which line and who logged it", () => {
    const facts = alertFacts({
      alert,
      description: "LED wall",
      actorName: "Meera",
    }).join(" ");
    assert.match(facts, /AV & production has gone over its plan/);
    assert.match(facts, /Meera just logged "LED wall"/);
  });

  it("has nothing to decide when only nearing the plan", () => {
    const facts = alertFacts({ alert: { ...alert, status: "near" } }).join(" ");
    assert.match(facts, /used most of its plan/);
    assert.match(facts, /Nothing needs deciding/);
  });

  it("drops anything typed with an amount in it", () => {
    const facts = alertFacts({
      alert,
      description: "advance of 3 lakh",
      actorName: "Meera",
    }).join(" ");
    assert.doesNotMatch(facts, /lakh|₹/);
    assert.doesNotMatch(facts, /Meera/);
  });
});

describe("wordAlert", () => {
  const facts = alertFacts({ alert, description: "LED wall", actorName: "Meera" });

  it("uses the model's wording when it stays within the facts", async () => {
    const wording = "AV & production has gone over its plan after the LED wall. Meera logged it.";
    const { generate, calls } = fakeModel({ wording, rationale: "From the facts." });
    const result = await wordAlert({ facts }, { generate });
    assert.equal(result.wording, wording);
    assert.equal(calls.length, 1);
    assert.match(calls[0].messages[0].content, /UNTRUSTED facts/);
  });

  for (const [what, wording] of [
    ["an amount", "AV & production is ₹46,661 over its plan."],
    ["any number", "AV & production is 18 percent over its plan."],
    ["the ranking", "AV & production is your top priority and is over its plan."],
    ["a figure in words", "AV & production has used about double its plan."],
  ])
    it(`replaces wording that gives away ${what}`, async () => {
      const { generate } = fakeModel({ wording, rationale: "Fine." });
      assert.equal((await wordAlert({ facts }, { generate })).wording, facts.join(" "));
    });

  it("falls back to the plain facts when the model fails", async () => {
    const { wording, rationale } = await wordAlert({ facts }, { generate: failingModel });
    assert.equal(wording, facts.join(" "));
    assert.ok(rationale);
  });
});
