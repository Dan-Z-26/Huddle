import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { toChangeEvents } from "../../server/agents/changeProposals.js";
import { changeProposal } from "../../server/agents/schemas.js";

const categoryIds = ["decor", "music"];
const convert = (proposal) => toChangeEvents([{ confidence: 0.9, ...proposal }], { categoryIds });

describe("toChangeEvents", () => {
  it("passes a guest count change through untouched", () => {
    const { events } = convert({ type: "guest_count", delta: 50 });
    assert.deepEqual(events, [{ type: "guest_count", delta: 50, confidence: 0.9 }]);
    assert.deepEqual(convert({ type: "guest_count", to: 250 }).events[0].to, 250);
  });

  it("asks when a guest change has neither or both of delta and to", () => {
    assert.equal(convert({ type: "guest_count" }).questions.length, 1);
    assert.equal(convert({ type: "guest_count", delta: 5, to: 9 }).questions.length, 1);
  });

  it("reads money from the user's words, in code", () => {
    assert.equal(
      convert({ type: "budget_total", amountText: "18 lakh" }).events[0].toMinor,
      180000000,
    );
    const category = convert({
      type: "category_amount",
      category: "decor",
      amountText: "₹2,50,000",
    });
    assert.equal(category.events[0].amountMinor, 25000000);
  });

  it("asks instead of guessing when an amount can't be read", () => {
    const { events, questions } = convert({ type: "budget_total", amountText: "a bit more" });
    assert.deepEqual(events, []);
    assert.match(questions[0].reason, /amount/);
  });

  it("turns a priced swap into a user-priced driver and an unpriced swap into a bare swap", () => {
    const priced = convert({
      type: "line_item_swap",
      category: "music",
      remove: "DJ",
      add: "live band",
      priceText: "1.2 lakh",
      priceKind: "fixed",
    }).events[0];
    assert.deepEqual(priced.price, { kind: "fixed", source: "user", unitMinor: 12000000 });
    const bare = convert({
      type: "line_item_swap",
      category: "music",
      remove: "DJ",
      add: "live band",
    }).events[0];
    assert.equal("price" in bare, false);
  });

  it("turns a model estimate into a labelled estimate range in paise", () => {
    const { events } = convert({
      type: "line_item_add",
      category: "decor",
      label: "Flowers",
      estimate: { lowRupees: 30000, highRupees: 50000 },
    });
    assert.deepEqual(events[0].item, {
      label: "Flowers",
      kind: "fixed",
      source: "estimate",
      estimate: { lowMinor: 3000000, highMinor: 5000000 },
    });
  });

  it("gives per-unit items their unit count, defaulting to 1", () => {
    const { events } = convert({
      type: "line_item_add",
      category: "music",
      label: "Sound tech",
      priceText: "₹3000",
      priceKind: "perUnit",
      units: 8,
    });
    assert.deepEqual(events[0].item.units, 8);
    const noUnits = convert({
      type: "line_item_add",
      category: "music",
      label: "x",
      priceText: "₹3000",
      priceKind: "perUnit",
    });
    assert.equal(noUnits.events[0].item.units, 1);
  });

  it("asks for a price when adding an item with none", () => {
    assert.equal(
      convert({ type: "line_item_add", category: "decor", label: "Fog" }).questions.length,
      1,
    );
  });

  it("turns low confidence and unknown categories into questions, never events", () => {
    const low = toChangeEvents([{ type: "guest_count", delta: 5, confidence: 0.69 }], {
      categoryIds,
    });
    assert.deepEqual(low.events, []);
    assert.equal(low.questions.length, 1);
    assert.equal(
      convert({ type: "category_amount", category: "fireworks", amountText: "1 lakh" }).events
        .length,
      0,
    );
    assert.equal(
      toChangeEvents([{ type: "guest_count", delta: 5, confidence: 0.7 }], { categoryIds }).events
        .length,
      1,
    );
  });

  it("keeps good proposals when others in the same batch need a question", () => {
    const { events, questions } = toChangeEvents(
      [
        { type: "guest_count", delta: 50, confidence: 1 },
        { type: "budget_total", amountText: "???", confidence: 1 },
      ],
      { categoryIds },
    );
    assert.equal(events.length, 1);
    assert.equal(questions.length, 1);
  });
});

describe("changeProposal schema", () => {
  it("accepts a valid proposal and rejects one that carries raw minor-unit money", () => {
    assert.ok(
      changeProposal.safeParse({ type: "budget_total", amountText: "18 lakh", confidence: 0.9 })
        .success,
    );
    assert.equal(
      changeProposal.safeParse({ type: "budget_total", toMinor: 5, confidence: 0.9 }).success,
      false,
    );
    assert.equal(
      changeProposal.safeParse({ type: "guest_count", delta: 1.5, confidence: 1 }).success,
      false,
    );
    assert.equal(
      changeProposal.safeParse({ type: "guest_count", delta: 5, confidence: 2 }).success,
      false,
    );
  });
});
