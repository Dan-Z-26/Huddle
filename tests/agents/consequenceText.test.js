import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { consequenceText } from "../../server/agents/consequenceText.js";

const template = {
  categories: [
    { id: "decor", name: "Décor" },
    { id: "music", name: "Music" },
  ],
};
const profile = { mustHaves: [{ id: "m1", text: "live act" }] };
const text = (consequences) =>
  consequenceText(consequences, { profile, template, currency: "INR" });
const none = {
  shortfall: { lowMinor: 0, highMinor: 0 },
  surplusMinor: 0,
  deltas: [],
  options: [],
  increaseBudget: null,
};

describe("consequenceText", () => {
  it("reports a surplus", () => {
    assert.equal(
      text({ ...none, surplusMinor: 5000000 }),
      "You are within budget, with ₹50,000 to spare.",
    );
  });

  it("shows a range when estimates make the gap uncertain", () => {
    const result = text({
      ...none,
      shortfall: { lowMinor: 1000000, highMinor: 2000000 },
      increaseBudget: { lowMinor: 1000000, highMinor: 2000000 },
    });
    assert.match(result, /over budget\./);
    assert.match(result, /₹10,000 to ₹20,000 over budget/);
    assert.match(result, /\+₹10,000 to ₹20,000 required/);
  });

  it("names an unranked category and says when a cut does not cover the gap", () => {
    const option = {
      categoryId: "music",
      rank: null,
      atLow: null,
      atHigh: {
        cutMinor: 100,
        newTotalMinor: 900,
        pctDrop: 10,
        tierBefore: null,
        tierAfter: null,
        removedEntirely: false,
        coversShortfall: false,
        mustHaveConflicts: [],
      },
    };
    const result = text({
      ...none,
      shortfall: { lowMinor: 5000, highMinor: 5000 },
      options: [option],
    });
    assert.match(result, /Music \(not ranked\): Music drops 10%, to ₹9\./);
    assert.match(result, /This alone does not cover the gap\./);
  });

  it("names the level a cut falls below the lowest", () => {
    const tier = (id, label) => ({ id, label, minMinor: 0 });
    const option = {
      categoryId: "decor",
      rank: 2,
      atLow: null,
      atHigh: {
        cutMinor: 1,
        newTotalMinor: 1,
        pctDrop: 50,
        tierBefore: tier("a", "full wrap"),
        tierAfter: null,
        removedEntirely: false,
        coversShortfall: true,
        mustHaveConflicts: ["m1", "gone"],
      },
    };
    const result = text({ ...none, shortfall: { lowMinor: 1, highMinor: 1 }, options: [option] });
    assert.match(result, /from the 'full wrap' level to 'below the lowest level'/);
    assert.match(result, /must-have 'live act'/);
    assert.match(result, /must-have 'gone'/);
  });

  it("never recommends", () => {
    assert.doesNotMatch(
      text({
        ...none,
        shortfall: { lowMinor: 1, highMinor: 1 },
        increaseBudget: { lowMinor: 1, highMinor: 1 },
      }),
      /recommend|should|best/i,
    );
  });
});
