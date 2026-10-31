import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { advise } from "../../server/agents/advisor.js";
import { demoGenerate, failingModel, fakeModel, NOW, profile, state } from "./fixtures.js";

const run = (generate, extra = {}) =>
  advise({ profile, state, nowIso: NOW, ...extra }, { generate });
const signalId = "no-quotes-reveal";

describe("advise", () => {
  it("gives plain next steps from the signals with no model", async () => {
    const { items } = await run(demoGenerate);
    assert.equal(items[0].signalId, signalId);
    assert.equal(items[0].action, "vendors");
    assert.match(items[0].why, /no vendor quotes yet/);
  });

  it("uses the model's wording, with the action decided in code", async () => {
    const { items } = await run(
      fakeModel({
        items: [
          { signalId, title: "Ask for reveal quotes", why: "The reveal is the night's heart." },
        ],
      }).generate,
    );
    assert.equal(items[0].title, "Ask for reveal quotes");
    assert.equal(items[0].action, "vendors");
  });

  it("drops a step that points at no signal, and any invented figure", async () => {
    const { items } = await run(
      fakeModel({
        items: [
          { signalId: "made-up", title: "Spend more", why: "Luxury sells." },
          { signalId, title: "Book it", why: "It costs ₹9,99,999 and is great." },
        ],
      }).generate,
    );
    assert.equal(items.length, 1);
    assert.match(items[0].why, /no vendor quotes yet/);
    assert.ok(!items[0].why.includes("9,99,999"));
  });

  it("says when the model failed, and still answers", async () => {
    const { items, offline } = await run(failingModel);
    assert.equal(offline, true);
    assert.ok(items.length > 0);
  });

  it("says nothing is needed when there are no signals, without a model call", async () => {
    const quotes = profile.priorities.map((categoryId) => ({ categoryId, status: "accepted" }));
    const result = await run(
      async () => {
        throw new Error("no call needed");
      },
      { quotes },
    );
    assert.deepEqual(result.items, []);
    assert.match(result.summary, /on track/);
  });
});
