import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { normalisePriorities, rankOf } from "../../server/core/priorities.js";

describe("normalisePriorities", () => {
  it("keeps the user's order, dropping unknown ids and duplicates", () => {
    assert.deepEqual(normalisePriorities(["b", "x", "a", "b"], ["a", "b", "c"]), ["b", "a"]);
  });

  it("handles empty and non-array rankings", () => {
    assert.deepEqual(normalisePriorities([], ["a"]), []);
    assert.deepEqual(normalisePriorities(undefined, ["a"]), []);
  });

  it("does not mutate its input", () => {
    const ranking = ["b", "a", "b"];
    normalisePriorities(ranking, ["a", "b"]);
    assert.deepEqual(ranking, ["b", "a", "b"]);
  });
});

describe("rankOf", () => {
  it("is 1-based, and null when unranked", () => {
    assert.equal(rankOf(["a", "b"], "a"), 1);
    assert.equal(rankOf(["a", "b"], "b"), 2);
    assert.equal(rankOf(["a", "b"], "c"), null);
    assert.equal(rankOf([], "a"), null);
  });
});
