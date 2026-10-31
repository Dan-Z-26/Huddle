import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { groundedOr, isGrounded } from "../../server/agents/grounded.js";

describe("isGrounded", () => {
  it("accepts figures that appear in the allowed text", () => {
    assert.equal(isGrounded("Décor drops to ₹1,85,000", "décor ₹1,85,000 priority 2"), true);
    assert.equal(isGrounded("no figures at all", ""), true);
  });

  it("rejects figures that were not supplied", () => {
    assert.equal(isGrounded("adds 40 guests", "200 guests"), false);
  });

  it("requires the same unit as the allowed figure", () => {
    assert.equal(isGrounded("adds ₹5 lakh", "your #5 priority"), false);
    assert.equal(isGrounded("5 crore more", "5 lakh"), false);
    assert.equal(isGrounded("a 5 lakh gap", "gap of 5 lakh"), true);
    assert.equal(isGrounded("20% less", "20% less"), true);
    assert.equal(isGrounded("20% less", "20 guests"), false);
  });

  it("rejects spelled-out scale words that were not supplied", () => {
    assert.equal(isGrounded("fifty thousand more", "your #5 priority"), false);
    assert.equal(isGrounded("fifty guests", "fifty guests"), true);
  });

  it("folds full-width digits and rejects other scripts", () => {
    assert.equal(isGrounded("５０ guests", "200 guests"), false);
    assert.equal(isGrounded("５０ guests", "50 guests"), true);
    assert.equal(isGrounded("٥٠ guests", "50 guests"), false);
  });

  it("does not match a unit inside a longer word", () => {
    assert.equal(isGrounded("12 March", "12 March 2027"), true);
    assert.equal(isGrounded("10 km away", "10 km away"), true);
  });
});

describe("groundedOr", () => {
  it("returns trimmed grounded wording", () => {
    assert.equal(groundedOr("  Fine for 200  ", "200 guests", "x"), "Fine for 200");
  });

  it("returns the fallback for empty, ungrounded or non-string wording", () => {
    assert.equal(groundedOr("", "200", "x"), "x");
    assert.equal(groundedOr("300 guests", "200", "x"), "x");
    assert.equal(groundedOr(undefined, "200", "x"), "x");
    assert.equal(groundedOr(undefined, "200"), "");
  });
});
