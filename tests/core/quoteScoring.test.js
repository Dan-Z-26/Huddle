import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { normaliseQuote, quotePricesWithTax, scoreQuotes } from "../../server/core/quoteScoring.js";

const answered = { staffing: "6", setupHours: 2, cancellationTerms: "7 days", dietary: "veg" };
const quote = (id, perGuestMinor, fixedMinor, extra = {}) => ({
  id,
  categoryId: "food",
  vendorName: `Vendor ${id}`,
  status: "confirmed",
  perGuestMinor,
  fixedMinor,
  taxBps: 0,
  mustHaveIdsMet: [],
  answers: answered,
  ...extra,
});

describe("quotePricesWithTax", () => {
  it("rounds tax per component, half up", () => {
    assert.deepEqual(quotePricesWithTax({ perGuestMinor: 25, fixedMinor: 24, taxBps: 1800 }), {
      perGuestMinor: 30,
      fixedMinor: 28,
    });
  });

  it("counts null prices and tax as zero", () => {
    assert.deepEqual(quotePricesWithTax({ perGuestMinor: null, fixedMinor: null, taxBps: null }), {
      perGuestMinor: 0,
      fixedMinor: 0,
    });
  });
});

describe("normaliseQuote", () => {
  it("totals per guest plus fixed, with tax applied per component", () => {
    const { totalMinor, missing } = normaliseQuote(quote("a", 25, 24, { taxBps: 1800 }), 3);
    assert.equal(totalMinor, 30 * 3 + 28);
    assert.deepEqual(missing, []);
  });

  it("lists null and absent answers, plus price when both prices are 0", () => {
    const partial = quote("a", 0, 0, {
      answers: { staffing: null, setupHours: 0, dietary: "veg" },
    });
    const { totalMinor, missing } = normaliseQuote(partial, 100);
    assert.equal(totalMinor, 0);
    assert.deepEqual(missing, ["staffing", "cancellationTerms", "price"]);
  });

  it("treats no answers at all as all missing", () => {
    const { missing } = normaliseQuote(quote("a", 1, 0, { answers: undefined }), 1);
    assert.deepEqual(missing, ["staffing", "setupHours", "cancellationTerms", "dietary"]);
  });

  it("does not call a one-sided price missing", () => {
    assert.deepEqual(normaliseQuote(quote("a", 0, 5), 1).missing, []);
    assert.deepEqual(normaliseQuote(quote("a", 5, 0), 1).missing, []);
  });
});

describe("scoreQuotes", () => {
  const mustHaves = [
    { id: "m1", categoryId: "food" },
    { id: "m2", categoryId: "food" },
    { id: "elsewhere", categoryId: "music" },
  ];
  const score = (quotes, overrides = {}) =>
    scoreQuotes(quotes, {
      guestCount: 10,
      priorities: ["food", "music", "decor"],
      mustHaves,
      categoryId: "food",
      ...overrides,
    });
  // Cheap meets nothing and costs half; dear meets everything.
  const cheap = quote("cheap", 100, 0);
  const dear = quote("dear", 200, 0, { mustHaveIdsMet: ["m1", "m2"] });

  it("reports totals, fit and flags", () => {
    const [row] = score([dear]);
    assert.deepEqual(row, {
      quoteId: "dear",
      vendorName: "Vendor dear",
      totalMinor: 2000,
      mustHaveFit: 100,
      score: 100,
      missing: [],
      riskFlags: [],
    });
  });

  it("weights fit at 80% at first rank", () => {
    const [cheapRow, dearRow] = score([cheap, dear], { priorities: ["food", "music"] });
    assert.equal(cheapRow.score, 20); // 0 fit x 80% + 100 cost x 20%
    assert.equal(dearRow.score, 90); // 100 fit x 80% + 50 cost x 20%
  });

  it("weights fit at 40% at last rank", () => {
    const [cheapRow, dearRow] = score([cheap, dear], { priorities: ["music", "food"] });
    assert.equal(cheapRow.score, 60);
    assert.equal(dearRow.score, 70);
  });

  it("interpolates the weight between ranks", () => {
    const [cheapRow] = score([cheap, dear], { priorities: ["music", "food", "decor"] });
    assert.equal(cheapRow.score, 40); // middle of three is 60% fit
  });

  it("gives a sole ranked category 80% and an unranked one 40%", () => {
    assert.equal(score([cheap, dear], { priorities: ["food"] })[0].score, 20);
    assert.equal(score([cheap, dear], { priorities: ["music"] })[0].score, 60);
    assert.equal(score([cheap, dear], { priorities: [] })[0].score, 60);
  });

  it("counts fit as 100 for a category with no must-haves", () => {
    const [row] = score([cheap], { mustHaves: [{ id: "x", categoryId: "music" }] });
    assert.equal(row.mustHaveFit, 100);
    assert.deepEqual(row.riskFlags, []);
  });

  it("works out partial fit", () => {
    const [row] = score([quote("a", 100, 0, { mustHaveIdsMet: ["m1"] })]);
    assert.equal(row.mustHaveFit, 50);
    assert.deepEqual(row.riskFlags, ["must_have_unmet:m2"]);
  });

  it("always flags an unmet absolute must-have, even on the top score", () => {
    const rows = score([quote("a", 100, 0, { mustHaveIdsMet: ["m1"] })], {
      absoluteMustHaveId: "m2",
    });
    assert.deepEqual(rows[0].riskFlags, ["absolute_must_have_unmet:m2"]);
  });

  it("does not flag an absolute must-have once it is met", () => {
    const rows = score([dear], { absoluteMustHaveId: "m2" });
    assert.deepEqual(rows[0].riskFlags, []);
  });

  it("does not flag another category's absolute must-have", () => {
    const rows = score([dear], { absoluteMustHaveId: "elsewhere" });
    assert.deepEqual(rows[0].riskFlags, []);
  });

  it("reports missing info and gives an unpriced quote no cost credit", () => {
    const unpriced = quote("free", 0, 0, { answers: { ...answered, dietary: null } });
    const [freeRow, cheapRow] = score([unpriced, cheap], { mustHaves: [] });
    assert.deepEqual(freeRow.missing, ["dietary", "price"]);
    assert.deepEqual(freeRow.riskFlags, ["no_price"]);
    assert.equal(freeRow.score, 80); // 100 fit x 80%, 0 cost
    assert.equal(cheapRow.score, 100);
  });

  it("copes when no quote has a price", () => {
    const [row] = score([quote("free", 0, 0)], { mustHaves: [] });
    assert.equal(row.score, 80);
  });

  it("keeps input order rather than ranking vendors", () => {
    assert.deepEqual(
      score([cheap, dear]).map(({ quoteId }) => quoteId),
      ["cheap", "dear"],
    );
  });

  it("skips other categories and unconfirmed extracted quotes", () => {
    const rows = score([
      quote("other", 1, 0, { categoryId: "music" }),
      quote("extracted", 1, 0, { status: "extracted" }),
      quote("accepted", 100, 0, { status: "accepted" }),
    ]);
    assert.deepEqual(
      rows.map(({ quoteId }) => quoteId),
      ["accepted"],
    );
  });

  it("returns nothing for no quotes", () => assert.deepEqual(score([]), []));

  it("rounds the score to an integer within 0-100", () => {
    const [row] = score([quote("a", 300, 0), quote("b", 700, 0)], {
      priorities: ["music", "food", "decor", "x"],
      mustHaves: [],
    }).slice(1);
    assert.ok(Number.isInteger(row.score));
    assert.ok(row.score >= 0 && row.score <= 100);
  });
});

describe("scoreQuotes: a quote that never reported its must-haves", () => {
  it("counts them all as unmet rather than met", () => {
    const silent = quote("a", 100, 0, { mustHaveIdsMet: undefined });
    const [row] = scoreQuotes([silent], {
      guestCount: 1,
      priorities: ["food"],
      mustHaves: [{ id: "m1", categoryId: "food" }],
      categoryId: "food",
      absoluteMustHaveId: "m1",
    });
    assert.equal(row.mustHaveFit, 0);
    assert.deepEqual(row.riskFlags, ["absolute_must_have_unmet:m1"]);
  });
});
