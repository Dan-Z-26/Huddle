import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { noticeFacts, noticeTargets, word } from "../../server/agents/notices.js";
import { demoGenerate, failingModel, fakeModel, template } from "./fixtures.js";

const deltas = [
  { categoryId: "food-beverage", beforeMinor: 40000000, afterMinor: 50000000 },
  { categoryId: "reveal", beforeMinor: 60000000, afterMinor: 61000000 },
  { categoryId: "gifting", beforeMinor: 10000000, afterMinor: 12500000 },
];
const map = template.categoryGroupMap;

describe("noticeTargets", () => {
  it("looks each changed category up in the template map, in code", () => {
    const targets = noticeTargets({ deltas, categoryGroupMap: map });
    const bySlug = Object.fromEntries(targets.map((t) => [t.slug, t.categoryIds]));
    assert.deepEqual(bySlug["food-beverage"], ["food-beverage"]);
    assert.deepEqual(bySlug["stage-decor"], ["reveal"]);
    assert.deepEqual(bySlug["music-av"], ["reveal"]);
    assert.deepEqual(bySlug["core-team"], ["gifting"]);
  });

  it("notifies nobody when nothing changed, and only affected groups otherwise", () => {
    assert.deepEqual(noticeTargets({ deltas: [], categoryGroupMap: map }), []);
    const slugs = noticeTargets({ deltas: [deltas[0]], categoryGroupMap: map }).map((t) => t.slug);
    assert.deepEqual(slugs, ["food-beverage"]);
  });

  it("sends an unmapped category to Core team", () => {
    const targets = noticeTargets({ deltas: [{ categoryId: "mystery" }], categoryGroupMap: map });
    assert.deepEqual(targets, [{ slug: "core-team", categoryIds: ["mystery"] }]);
  });

  it("merges categories that share a group", () => {
    const both = [{ categoryId: "reveal" }, { categoryId: "decor" }];
    const stage = noticeTargets({ deltas: both, categoryGroupMap: map }).find(
      (t) => t.slug === "stage-decor",
    );
    assert.deepEqual(stage.categoryIds, ["reveal", "decor"]);
  });
});

describe("noticeFacts", () => {
  const facts = (categoryIds, guests = { before: 200, after: 250 }, groupSlug = categoryIds[0]) =>
    noticeFacts({ guests, deltas, categoryIds, groupSlug, template, currency: "INR" });

  it("gives a group only its own categories' costs and the guest count", () => {
    assert.deepEqual(facts(["food-beverage"]), [
      "Guest count is now 250 (it was 200).",
      "Food & beverage cost changes from ₹4,00,000 to ₹5,00,000.",
    ]);
  });

  it("never mentions other categories or a total budget", () => {
    const text = facts(["food-beverage"]).join(" ");
    assert.doesNotMatch(text, /Gifting|Product reveal|total|budget/i);
  });

  it("leaves out the guest line when the count didn't change", () => {
    assert.equal(facts(["gifting"], null, "core-team").length, 1);
    assert.equal(facts(["gifting"], { before: 200, after: 200 }, "core-team").length, 1);
  });

  it("shows amounts when every core member of the group owns the category", () => {
    assert.match(facts(["reveal"], null, "stage-decor")[0], /₹6,00,000 to ₹6,10,000/);
  });

  it("leaves amounts out when a core member of the group doesn't own the category", () => {
    // Core team includes the PR head, who doesn't own gifting.
    assert.deepEqual(facts(["gifting"], null, "core-team"), ["Gifting cost has changed."]);
  });

  it("leaves amounts out for an unknown group", () => {
    assert.deepEqual(facts(["reveal"], null, "nope"), ["Product reveal cost has changed."]);
  });
});

describe("word", () => {
  const input = { facts: ["Guest count is now 250 (it was 200)."], groupName: "Food & beverage" };

  it("states the facts plainly in demo mode", async () => {
    const result = await word(input, { generate: demoGenerate });
    assert.equal(result.wording, "Update: Guest count is now 250 (it was 200).");
  });

  it("uses the model's friendlier wording when it sticks to the facts", async () => {
    const { generate } = fakeModel({
      wording: "Heads-up: we're now 250 guests, up from 200.",
      rationale: "ok",
    });
    assert.match((await word(input, { generate })).wording, /^Heads-up/);
  });

  it("falls back to the plain facts if the model adds a number", async () => {
    const { generate } = fakeModel({
      wording: "Please update your quote for 260 guests.",
      rationale: "ok",
    });
    assert.equal(
      (await word(input, { generate })).wording,
      "Update: Guest count is now 250 (it was 200).",
    );
  });

  it("works when the model is down, and sends the facts as delimited data", async () => {
    assert.match((await word(input, { generate: failingModel })).wording, /^Update:/);
    const { generate, calls } = fakeModel({ wording: "Hi", rationale: "ok" });
    await word(input, { generate });
    assert.match(calls[0].messages[0].content, /<<<UNTRUSTED facts>>>/);
    assert.equal(calls[0].agent, "notices");
    assert.match(calls[0].system, /never mention a total budget/i);
  });
});
