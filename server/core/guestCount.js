import { divFloor } from "./money.js";

// Only the start of a reply is read: counts are short, and the patterns stay fast on huge input.
const MAX_READ = 500;

const NUMBER = String.raw`\d[\d,]*\d|\d`;
const BARE_COUNT = new RegExp(
  String.raw`^\s*(?:exactly\s+)?(?:${NUMBER})(?:\s*(?:guests?|people|persons?|pax|attendees))?\s*\.?\s*$`,
  "i",
);
const RANGE = new RegExp(
  String.raw`(?<![-\d,])(${NUMBER})\s*(?:-|–|—|\bto\b|\bor\b)\s*(${NUMBER})`,
  "i",
);
// "around 200, maybe 300 if partners come": a second number only counts after a hedge like "maybe".
const HEDGED = new RegExp(
  String.raw`(?<![-\d,])(${NUMBER})(?:\s*(?:guests?|people|persons?|pax|attendees|or so))?\s*[,;.-]?\s*(?:but\s+)?\b(?:maybe|perhaps|possibly|up to|at most|could be|might be)\s+(?:about\s+|around\s+)?(${NUMBER})`,
  "i",
);
// The lookahead skips "2k" and "12th", which are not plain head counts.
const SINGLE = new RegExp(String.raw`(?<!\w)(-?)(${NUMBER})(?![\d.]*[a-z])`, "i");

const toCount = (digits) => Number(digits.replaceAll(",", ""));
const isValidCount = (count) => Number.isSafeInteger(count) && count >= 1;

function readCounts(text) {
  const range = text.replace(/between\s+(\S+)\s+and\b/i, "$1 to").match(RANGE);
  if (range) return [toCount(range[1]), toCount(range[2])];
  const hedged = text.match(HEDGED);
  if (hedged) return [toCount(hedged[1]), toCount(hedged[2])];
  const single = text.match(SINGLE);
  if (!single || single[1]) return null;
  return [toCount(single[2])];
}

/**
 * Parses a fuzzy guest-count answer into a range plus a suggested planning number.
 * @param {string} text For example "around 200", "200-250", "300 if partners come"
 *   or "around 200, maybe 300".
 * @returns {{min: number, max: number, suggested: number, needsConfirmation: boolean} | null}
 *   Null when the text holds no positive count.
 */
export function parseGuestCount(input) {
  if (typeof input !== "string") return null;
  const text = input.slice(0, MAX_READ);
  const counts = readCounts(text);
  if (!counts || !counts.every(isValidCount)) return null;
  const min = Math.min(...counts);
  const max = Math.max(...counts);
  const needsConfirmation = !BARE_COUNT.test(text);
  const suggested = needsConfirmation ? divFloor(max * 105 + 99, 100) : max;
  return { min, max, suggested, needsConfirmation };
}
