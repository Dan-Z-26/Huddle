import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { divFloor, formatMoney, shareOfBps, wholeMoney, withTax } from "../../server/core/money.js";

describe("formatMoney", () => {
  it("uses en-IN grouping for INR and drops zero paise", () => {
    assert.equal(formatMoney(160000000, "INR"), "₹16,00,000");
    assert.equal(formatMoney(12500000, "INR"), "₹1,25,000");
  });

  it("defaults to INR and shows paise when present", () => {
    assert.equal(formatMoney(12345), "₹123.45");
    assert.equal(formatMoney(150), "₹1.50");
  });

  it("handles zero and negatives", () => {
    assert.equal(formatMoney(0), "₹0");
    assert.equal(formatMoney(-12500000), "-₹1,25,000");
  });

  it("uses western grouping for other currencies", () => {
    assert.equal(formatMoney(160000000, "USD"), "$1,600,000");
  });
});

describe("integer helpers", () => {
  it("divFloor rounds down exactly", () => {
    assert.equal(divFloor(10, 3), 3);
    assert.equal(divFloor(9, 3), 3);
    assert.equal(divFloor(0, 7), 0);
  });

  it("shareOfBps rounds down", () => {
    assert.equal(shareOfBps(1000, 3333), 333);
    assert.equal(shareOfBps(1000, 10000), 1000);
    assert.equal(shareOfBps(0, 5000), 0);
  });

  it("withTax rounds the tax half up", () => {
    assert.equal(withTax(100, 1800), 118);
    assert.equal(withTax(25, 1800), 30); // tax 4.5 rounds to 5
    assert.equal(withTax(24, 1800), 28); // tax 4.32 rounds to 4
    assert.equal(withTax(100, 0), 100);
    assert.equal(withTax(0, 1800), 0);
  });

  it("withTax matches exact BigInt arithmetic, so no float leaks in", () => {
    for (const taxBps of [1, 333, 1800, 2800]) {
      for (const minor of [1, 7, 333, 99999, 123456789, 9007199254]) {
        const tax = (BigInt(minor) * BigInt(taxBps) + 5000n) / 10000n;
        assert.equal(BigInt(withTax(minor, taxBps)), BigInt(minor) + tax);
      }
    }
  });
});

describe("wholeMoney", () => {
  it("rounds to whole rupees for sentences", () => {
    assert.equal(wholeMoney(38095238), "₹3,80,952");
    assert.equal(wholeMoney(38095250), "₹3,80,953");
    assert.equal(wholeMoney(12500000), "₹1,25,000");
  });

  it("keeps paise under one rupee, so a real difference never reads as zero", () => {
    assert.equal(wholeMoney(40), "₹0.40");
    assert.equal(wholeMoney(0), "₹0");
  });
});
