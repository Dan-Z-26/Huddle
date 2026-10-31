import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseDueDate, parseEventDate } from "../../server/core/dateText.js";

describe("parseEventDate", () => {
  const cases = [
    ["2027-03-12", "2027-03-12T00:00:00.000Z"],
    ["12 March 2027", "2027-03-12T00:00:00.000Z"],
    ["12th of March, 2027", "2027-03-12T00:00:00.000Z"],
    ["March 12th, 2027", "2027-03-12T00:00:00.000Z"],
    ["mar 3 2027", "2027-03-03T00:00:00.000Z"],
    ["12/03/2027", "2027-03-12T00:00:00.000Z"],
    ["5.1.2028", "2028-01-05T00:00:00.000Z"],
    ["we launch on 1 Sept 2027 in Pune", "2027-09-01T00:00:00.000Z"],
    ["29 Feb 2028", "2028-02-29T00:00:00.000Z"],
  ];
  for (const [text, expected] of cases) {
    it(`reads ${JSON.stringify(text)}`, () => assert.equal(parseEventDate(text), expected));
  }

  it("does not guess a missing year or accept impossible dates", () => {
    for (const text of [
      "12 March",
      "next Friday",
      "31 Feb 2027",
      "29 Feb 2027",
      "2027-13-01",
      "32 Jan 2027",
      "12 Foo 2027",
      "1999-01-01",
      "",
      "soon",
    ]) {
      assert.equal(parseEventDate(text), null, text);
    }
  });

  it("copes with non-strings", () => {
    for (const value of [undefined, null, 20270312]) assert.equal(parseEventDate(value), null);
  });
});

describe("parseDueDate", () => {
  const FRIDAY = "2027-03-12T15:30:00.000Z"; // 12 March 2027 is a Friday
  const cases = [
    ["send the AV specs by Friday", "2027-03-12T00:00:00.000Z"],
    ["by Monday please", "2027-03-15T00:00:00.000Z"],
    ["on Thursday", "2027-03-18T00:00:00.000Z"],
    ["next Friday", "2027-03-19T00:00:00.000Z"],
    ["next Monday", "2027-03-15T00:00:00.000Z"],
    ["today", "2027-03-12T00:00:00.000Z"],
    ["tomorrow morning", "2027-03-13T00:00:00.000Z"],
    ["in 3 days", "2027-03-15T00:00:00.000Z"],
    ["in 2 weeks", "2027-03-26T00:00:00.000Z"],
    ["finish by 20 March 2027", "2027-03-20T00:00:00.000Z"],
  ];
  for (const [text, expected] of cases) {
    it(`reads ${JSON.stringify(text)}`, () => assert.equal(parseDueDate(text, FRIDAY), expected));
  }

  it("crosses a month end", () => {
    assert.equal(parseDueDate("in 3 days", "2027-03-30T10:00:00.000Z"), "2027-04-02T00:00:00.000Z");
  });

  it("returns null when no date is named, and copes with non-strings", () => {
    for (const text of ["as soon as you can", "", "fridays are busy", null, 5]) {
      assert.equal(parseDueDate(text, FRIDAY), null, String(text));
    }
  });
});
