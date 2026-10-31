import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseGuestCount } from "../../server/core/guestCount.js";

const result = (min, max, suggested, needsConfirmation) => ({
  min,
  max,
  suggested,
  needsConfirmation,
});

describe("parseGuestCount", () => {
  const cases = [
    ["200", result(200, 200, 200, false)],
    ["around 200", result(200, 200, 210, true)],
    ["200-250", result(200, 250, 263, true)],
    ["300 if partners come", result(300, 300, 315, true)],
    ["200 guests", result(200, 200, 200, false)],
    ["exactly 200 people.", result(200, 200, 200, false)],
    ["200 - 250", result(200, 250, 263, true)],
    ["200–250", result(200, 250, 263, true)],
    ["200 to 250", result(200, 250, 263, true)],
    ["200 or 250", result(200, 250, 263, true)],
    ["between 200 and 250", result(200, 250, 263, true)],
    ["maybe 300, could be 350", result(300, 300, 315, true)],
    ["1", result(1, 1, 1, false)],
    ["about 1", result(1, 1, 2, true)],
  ];
  for (const [text, expected] of cases) {
    it(`parses "${text}"`, () => assert.deepEqual(parseGuestCount(text), expected));
  }

  it("orders a reversed range", () => {
    assert.deepEqual(parseGuestCount("250-200"), result(200, 250, 263, true));
    assert.deepEqual(parseGuestCount("250 to 200"), result(200, 250, 263, true));
  });

  it("reads comma-grouped numbers", () => {
    assert.deepEqual(parseGuestCount("1,200"), result(1200, 1200, 1200, false));
    assert.deepEqual(parseGuestCount("1,00,000"), result(100000, 100000, 100000, false));
    assert.deepEqual(parseGuestCount("around 1,200"), result(1200, 1200, 1260, true));
    assert.deepEqual(parseGuestCount("1,000-1,200"), result(1000, 1200, 1260, true));
  });

  it("uses integer rounding at the suggested boundary", () => {
    assert.equal(parseGuestCount("around 100").suggested, 105);
    assert.equal(parseGuestCount("around 101").suggested, 107);
    assert.equal(parseGuestCount("around 20").suggested, 21);
  });

  it("skips ordinals and scaled shorthand rather than misreading them", () => {
    assert.equal(parseGuestCount("2k"), null);
    assert.equal(parseGuestCount("1.5k"), null);
    assert.equal(parseGuestCount("on the 12th floor, 200 guests").max, 200);
  });

  for (const text of ["0", "zero", "-5", "-5 to 10", "around -20", "0-50", "not sure yet", ""]) {
    it(`returns null for "${text}"`, () => assert.equal(parseGuestCount(text), null));
  }

  it("returns null for non-strings and unsafe numbers", () => {
    assert.equal(parseGuestCount(200), null);
    assert.equal(parseGuestCount(null), null);
    assert.equal(parseGuestCount("99999999999999999"), null);
  });
});
