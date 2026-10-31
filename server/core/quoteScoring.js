import { withTax } from "./money.js";
import { rankOf } from "./priorities.js";

const ANSWER_KEYS = ["staffing", "setupHours", "cancellationTerms", "dietary"];
const TOP_RANK_FIT_WEIGHT = 80;
const LAST_RANK_FIT_WEIGHT = 40;

/**
 * Applies a quote's tax to each of its price components.
 * @param {object} quote Quote; null prices count as 0.
 * @returns {{perGuestMinor: number, fixedMinor: number}} Tax-inclusive prices.
 */
export function quotePricesWithTax(quote) {
  const taxBps = quote.taxBps ?? 0;
  return {
    perGuestMinor: withTax(quote.perGuestMinor ?? 0, taxBps),
    fixedMinor: withTax(quote.fixedMinor ?? 0, taxBps),
  };
}

/**
 * Normalises a quote to its tax-inclusive total at a guest count and lists unanswered fields.
 * @param {object} quote Quote.
 * @param {number} guestCount Guest count.
 * @returns {{totalMinor: number, missing: string[]}} Total and missing fields.
 */
export function normaliseQuote(quote, guestCount) {
  const { perGuestMinor, fixedMinor } = quotePricesWithTax(quote);
  const missing = ANSWER_KEYS.filter((key) => quote.answers?.[key] == null);
  if (!quote.perGuestMinor && !quote.fixedMinor) missing.push("price");
  if (quote.taxStated === false) missing.push("tax");
  return { totalMinor: perGuestMinor * guestCount + fixedMinor, missing };
}

function fitWeight(priorities, categoryId) {
  const rank = rankOf(priorities, categoryId);
  if (rank === null) return LAST_RANK_FIT_WEIGHT;
  if (priorities.length === 1) return TOP_RANK_FIT_WEIGHT;
  const span = TOP_RANK_FIT_WEIGHT - LAST_RANK_FIT_WEIGHT;
  return TOP_RANK_FIT_WEIGHT - (span * (rank - 1)) / (priorities.length - 1);
}

function riskFlagsFor(unmetMustHaves, absoluteMustHaveId, missing) {
  const mustHaveFlags = unmetMustHaves.map((mustHave) =>
    mustHave.id === absoluteMustHaveId
      ? `absolute_must_have_unmet:${mustHave.id}`
      : `must_have_unmet:${mustHave.id}`,
  );
  return missing.includes("price") ? [...mustHaveFlags, "no_price"] : mustHaveFlags;
}

/**
 * Scores a category's confirmed quotes on must-have fit and cost, weighted by the category's rank.
 * Quotes stay in input order, and extracted quotes are skipped until a person confirms them.
 * @param {object[]} quotes Quotes.
 * @param {{guestCount: number, priorities: string[], mustHaves: object[], categoryId: string,
 *   absoluteMustHaveId?: string | null}} context Scoring context.
 * @returns {Array<{quoteId: string, vendorName: string, totalMinor: number, mustHaveFit: number,
 *   score: number, missing: string[], riskFlags: string[]}>} One row per scored quote.
 */
export function scoreQuotes(
  quotes,
  { guestCount, priorities, mustHaves, categoryId, absoluteMustHaveId = null },
) {
  const scorable = quotes.filter((q) => q.categoryId === categoryId && q.status !== "extracted");
  const categoryMustHaves = mustHaves.filter((mustHave) => mustHave.categoryId === categoryId);
  const fitPct = fitWeight(priorities, categoryId);
  const normalised = scorable.map((quote) => normaliseQuote(quote, guestCount));
  const prices = normalised.map(({ totalMinor }) => totalMinor).filter((total) => total > 0);
  const cheapest = Math.min(...prices);

  return scorable.map((quote, index) => {
    const { totalMinor, missing } = normalised[index];
    const met = quote.mustHaveIdsMet ?? [];
    const unmet = categoryMustHaves.filter((mustHave) => !met.includes(mustHave.id));
    const fit = categoryMustHaves.length
      ? ((categoryMustHaves.length - unmet.length) * 100) / categoryMustHaves.length
      : 100;
    const costScore = totalMinor > 0 ? (cheapest * 100) / totalMinor : 0;
    return {
      quoteId: quote.id,
      vendorName: quote.vendorName,
      totalMinor,
      mustHaveFit: Math.round(fit),
      score: Math.round((fit * fitPct + costScore * (100 - fitPct)) / 100),
      missing,
      riskFlags: riskFlagsFor(unmet, absoluteMustHaveId, missing),
    };
  });
}
