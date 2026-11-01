/** Reading amounts of money from people's words, and keeping amounts out of shared text. */
import { MAX_MINOR } from "./money.js";

// Only the start of a reply is read: amounts are short, and the patterns stay fast on huge input.
const MAX_READ = 500;

// Above the longest message or brief, so nothing real is left unread.
const MAX_MONEY_SCAN = 8000;
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
const FOLLOWED_BY_CURRENCY = [
  [/^\s*(?:rupees?|rs\b)/i, "INR"],
  [/^\s*dollars?\b/i, "USD"],
  [/^\s*euros?\b/i, "EUR"],
  [/^\s*pounds?\b/i, "GBP"],
];
const LOOKS_LIKE_YEAR = /^(?:19|20)\d\d$/;
const PLAIN_PRICE = /^[\d,.]+\s*(?:\/|per\b|a\s|$)/i;
const MIN_PLAIN_AMOUNT = 1000;

function toMinor(digits, unit) {
  const [whole, fraction = ""] = digits.replaceAll(",", "").split(".");
  const scale = BigInt(SCALES.get(unit?.toLowerCase()) ?? 1);
  const minor = (BigInt(whole + fraction) * scale * 100n) / 10n ** BigInt(fraction.length);
  return Number(minor);
}

// A figure marked as money wins. Otherwise a plain number that isn't a head count, and a year is
// only an amount if nothing else could be: "for the 2026 launch we paid 40000".
function chooseCandidate(candidates, after, writtenCurrency) {
  const marked = candidates.find((match) => match[1] || match[3] || writtenCurrency(match));
  if (marked) return marked;
  const plain = candidates.filter((match) => {
    const value = Number(match[2].replaceAll(",", ""));
    return value >= MIN_PLAIN_AMOUNT && !FOLLOWED_BY_PEOPLE.test(after(match));
  });
  return plain.find(({ 2: digits }) => !LOOKS_LIKE_YEAR.test(digits)) ?? plain[0];
}

/**
 * Reads a money amount out of free text, such as "16 lakh", "₹16,00,000", "1.5 crore" or "$2m".
 * Plain numbers count only from 1,000 up and when they are not a head count, so "200 guests" is
 * never read as a budget.
 * @param {string} input The user's words.
 * @returns {{minor: number, currency: string | null} | null} Integer minor units (paise or cents)
 *   and the currency if the text names one; null when there is no usable amount.
 */
export function parseAmount(input) {
  if (typeof input !== "string") return null;
  const text = input.slice(0, MAX_READ);
  const after = (match) => text.slice(match.index + match[0].length);
  const writtenCurrency = (match) =>
    FOLLOWED_BY_CURRENCY.find(([pattern]) => pattern.test(after(match)))?.[1];
  const chosen = chooseCandidate([...text.matchAll(CANDIDATE)], after, writtenCurrency);
  if (!chosen) return null;
  const [, symbol, digits, unit] = chosen;
  const minor = toMinor(digits, unit);
  if (!Number.isSafeInteger(minor) || minor < 1 || minor > MAX_MINOR) return null;
  return {
    minor,
    currency: CURRENCIES.get(symbol?.toLowerCase()) ?? writtenCurrency(chosen) ?? null,
  };
}

/**
 * Reads a field that can only hold money, so a plain "800" or "800 per plate" counts, unlike in free
 * text, and in the event's currency. A negative amount isn't one.
 * @param {string} text The field.
 * @param {string} currency The event's currency.
 * @returns {{minor: number, currency: string | null} | null} As for `parseAmount`.
 */
export function parseMoneyField(text, currency) {
  const trimmed = String(text ?? "").trim();
  if (trimmed.startsWith("-")) return null;
  return parseAmount(PLAIN_PRICE.test(trimmed) ? `${currency} ${trimmed}` : trimmed);
}

const AMOUNT_HIDDEN = "[amount]";
const WHOLE_MESSAGE_HIDDEN = "(this message held an amount, so it is hidden from the room)";

/**
 * Takes amounts out of text that a whole room will read, leaving the rest of the sentence.
 * @param {string} text Free text.
 * @returns {string} The text with amounts replaced; if that isn't enough, a note saying it's hidden.
 */
export function hideAmounts(text) {
  // The pattern can take in the spaces around an amount, and those aren't part of it.
  const masked = text.replace(CANDIDATE, (match, symbol, digits, unit) =>
    symbol || unit || Number(digits.replaceAll(",", "")) >= MIN_PLAIN_AMOUNT
      ? `${match.match(/^\s*/)[0]}${AMOUNT_HIDDEN}${match.match(/\s*$/)[0]}`
      : match,
  );
  return mentionsMoney(masked) ? WHOLE_MESSAGE_HIDDEN : masked;
}

const MONEY_WORDS =
  /[₹$€£]|\b(?:rs\.?|inr|usd|eur|gbp|rupees?|dollars?|euros?|pounds?|lakhs?|lacs?|crores?|thousand|million|grand)\b/i;
// Four digits are money unless they look like a year (1900 to 2099).
const BIG_NUMBER = /\d{5,}|\d{1,3}(?:,\d{2,3})+|\b(?!(?:19|20)\d\d\b)\d{4}\b|\d\s*\/-/;
// A currency run straight into its figure, as in "Rs850", has no word boundary between them.
const CODE_THEN_FIGURE = /\b(?:rs|inr|usd|eur|gbp)\.?\s*\d/i;
// \b doesn't work on Devanagari, and हज़ार can be typed either way.
const HINDI_MONEY = /रुपय|रुपए|लाख|करोड|हजार|हज\u093cार|ह\u095bार/;
const SHORT_AMOUNT = /\b\d+(?:\.\d+)?\s*(?:k|m|mn|cr|l|lac|lk|lks|lkh)\b/i;
// Bounded, so a long run of digits and commas can't make this scan quadratic.
const RATE =
  /\b\d[\d,.]{0,20}\s*(?:\/|per|a)\s*(?:plate|cover|seat|table|kit|unit|item|head|guest|person|pax|hour|day|night)\b/i;
const EACH = /\b\d[\d,.]{0,20}\s*(?:each|apiece)\b/i;
// Straight after the verb: "paid [amount] for 200 chairs" has already had its amount taken out.
const VERB_THEN_FIGURE = /\b(?:quoted|charged|charges|paid)\s+\d/i;
const NEAR_MONEY_WORD =
  /\b(?:budget|cost|costs|spend|spending|price|fee|cap|capped)\b[^.]{0,30}\d/i;

const MONEY_PATTERNS = [
  MONEY_WORDS,
  CODE_THEN_FIGURE,
  HINDI_MONEY,
  BIG_NUMBER,
  SHORT_AMOUNT,
  RATE,
  EACH,
  VERB_THEN_FIGURE,
  NEAR_MONEY_WORD,
];

/**
 * Says whether free text seems to state an amount of money, so it can be kept from people who may
 * not see budgets. Errs towards yes: wrongly hiding a sentence costs less than leaking a total.
 * Years and small counts ("by 1 Feb 2027", "200 guests") don't count.
 * @param {string} text Free text.
 * @returns {boolean} True when the text looks like it holds an amount.
 */
export function mentionsMoney(text) {
  const read = String(text ?? "").slice(0, MAX_MONEY_SCAN);
  return MONEY_PATTERNS.some((pattern) => pattern.test(read));
}
