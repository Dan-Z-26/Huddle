import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseAmount } from "../../server/core/amount.js";

const minor = (text) => parseAmount(text)?.minor ?? null;

describe("parseAmount", () => {
  const cases = [
    ["16 lakh", 160000000],
    ["16 Lakhs", 160000000],
    ["16L", 160000000],
    ["₹16,00,000", 160000000],
    ["Rs. 1,25,000", 12500000],
    ["INR 5000", 500000],
    ["1.5 crore", 1500000000],
    ["2 cr", 2000000000],
    ["5k", 500000],
    ["5 thousand", 500000],
    ["$2m", 200000000],
    ["2.5 million", 250000000],
    ["about 16 lakh rupees", 160000000],
    ["our budget is 1600000", 160000000],
    ["₹1,600,000.50", 160000050],
    ["0.5 lakh", 5000000],
  ];
  for (const [text, expected] of cases) {
    it(`reads ${JSON.stringify(text)}`, () => assert.equal(minor(text), expected));
  }

  it("reports the currency when the text names one", () => {
    assert.equal(parseAmount("₹5000").currency, "INR");
    assert.equal(parseAmount("Rs 5000").currency, "INR");
    assert.equal(parseAmount("$5000").currency, "USD");
    assert.equal(parseAmount("€5000").currency, "EUR");
    assert.equal(parseAmount("5000").currency, null);
  });

  it("prefers a marked amount over a head count in the same sentence", () => {
    assert.equal(minor("200 guests and 16 lakh"), 160000000);
    assert.equal(minor("16 lakh for 250 guests"), 160000000);
  });

  it("never reads a head count or a small plain number as a budget", () => {
    for (const text of [
      "200 guests",
      "around 250 people",
      "500",
      "12 March",
      "5 months",
      "no idea",
    ]) {
      assert.equal(parseAmount(text), null, text);
    }
  });

  it("rejects zero, negative-looking and too-large amounts", () => {
    for (const text of ["0 lakh", "Rs 0", "100000 crore", "9999999999999999999 lakh"]) {
      assert.equal(parseAmount(text), null, text);
    }
  });

  it("copes with non-strings", () => {
    for (const value of [undefined, null, 5, {}]) assert.equal(parseAmount(value), null);
  });

  it("stays in whole minor units for awkward decimals", () => {
    assert.ok(Number.isInteger(minor("1.234567 lakh")));
    assert.equal(minor("1.234567 lakh"), 12345670);
  });
});
