import { MAX_MINOR } from "./money.js";

// Only the start of a reply is read: amounts are short, and the patterns stay fast on huge input.
const MAX_READ = 500;

// Profile text is capped well below this, so nothing real is left unread.
const MAX_MONEY_SCAN = 2000;
const CURRENCIES = new Map([
  ["₹", "INR"],
  ["rs", "INR"],
  ["rs.", "INR"],
  ["inr", "INR"],
  ["$", "USD"],
  ["usd", "USD"],
  ["€", "EUR"],
  ["eur", "EUR"],
  ["£", "GBP"],
  ["gbp", "GBP"],
]);
const SCALES = new Map([
  ["k", 1e3],
  ["thousand", 1e3],
  ["l", 1e5],
  ["lk", 1e5],
  ["lks", 1e5],
  ["lac", 1e5],
  ["lacs", 1e5],
  ["lakh", 1e5],
  ["lakhs", 1e5],
  ["m", 1e6],
  ["mn", 1e6],
  ["million", 1e6],
  ["cr", 1e7],
  ["crore", 1e7],
  ["crores", 1e7],
  ["bn", 1e9],
  ["billion", 1e9],
]);
const CANDIDATE = new RegExp(
  String.raw`(₹|\$|€|£|\brs\.?|\binr\b|\busd\b|\beur\b|\bgbp\b)?\s*(\d[\d,]*(?:\.\d{1,6})?)\s*(lakhs?|lacs?|lks?|crores?|cr|thousand|million|billion|mn|bn|k|l|m)?(?![a-z])`,
  "gi",
);
const FOLLOWED_BY_PEOPLE = /^\s*(?:guests?|people|persons?|pax|attendees)/i;
const MIN_PLAIN_AMOUNT = 1000;

function toMinor(digits, unit) {
  const [whole, fraction = ""] = digits.replaceAll(",", "").split(".");
  const scale = BigInt(SCALES.get(unit?.toLowerCase()) ?? 1);
  const minor = (BigInt(whole + fraction) * scale * 100n) / 10n ** BigInt(fraction.length);
  return Number(minor);
}

/**
 * Reads a money amount out of free text, such as "16 lakh", "₹16,00,000", "1.5 crore" or "$2m".
 * Plain numbers count only from 1,000 up and when they are not a head count, so "200 guests" is
 * never read as a budget.
 * @param {string} text The user's words.
 * @returns {{minor: number, currency: string | null} | null} Integer minor units (paise or cents)
 *   and the currency if the text names one; null when there is no usable amount.
 */
export function parseAmount(input) {
  if (typeof input !== "string") return null;
  const text = input.slice(0, MAX_READ);
  const candidates = [...text.matchAll(CANDIDATE)];
  const marked = candidates.find(([, symbol, , unit]) => symbol || unit);
  const plain = candidates.find(([match, , digits, ,]) => {
    const value = Number(digits.replaceAll(",", ""));
    const after = text.slice(text.indexOf(match) + match.length);
    return value >= MIN_PLAIN_AMOUNT && !FOLLOWED_BY_PEOPLE.test(after);
  });
  const chosen = marked ?? plain;
  if (!chosen) return null;
  const [, symbol, digits, unit] = chosen;
  const minor = toMinor(digits, unit);
  if (!Number.isSafeInteger(minor) || minor < 1 || minor > MAX_MINOR) return null;
  return { minor, currency: CURRENCIES.get(symbol?.toLowerCase()) ?? null };
}

const MONEY_WORDS =
  /[₹$€£]|\b(?:rs\.?|inr|usd|eur|gbp|rupees?|dollars?|euros?|pounds?|lakhs?|lacs?|crores?|thousand|million|grand)\b/i;
// Four digits are money unless they look like a year (1900 to 2099).
const BIG_NUMBER = /\d{5,}|\d{1,3}(?:,\d{2,3})+|\b(?!(?:19|20)\d\d\b)\d{4}\b|\d\s*\/-/;
const SHORT_AMOUNT = /\b\d+(?:\.\d+)?\s*(?:k|m|mn|cr|l|lac)\b/i;
const NEAR_MONEY_WORD =
  /\b(?:budget|cost|costs|spend|spending|price|fee|cap|capped)\b[^.]{0,30}\d/i;

/**
 * Says whether free text seems to state an amount of money, so it can be kept from people who may
 * not see budgets. Errs towards yes: wrongly hiding a sentence costs less than leaking a total.
 * Years and small counts ("by 1 Feb 2027", "200 guests") don't count.
 * @param {string} text Free text.
 * @returns {boolean} True when the text looks like it holds an amount.
 */
export function mentionsMoney(text) {
  return [MONEY_WORDS, BIG_NUMBER, SHORT_AMOUNT, NEAR_MONEY_WORD].some((pattern) =>
    pattern.test(String(text ?? "").slice(0, MAX_MONEY_SCAN)),
  );
}
