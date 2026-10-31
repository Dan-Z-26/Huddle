const MONTHS = /^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*$/i;
const MONTH_NAMES = [
  "jan",
  "feb",
  "mar",
  "apr",
  "may",
  "jun",
  "jul",
  "aug",
  "sep",
  "oct",
  "nov",
  "dec",
];
const ISO = /(\d{4})-(\d{1,2})-(\d{1,2})/;
const DAY_FIRST_NUMERIC = /(\d{1,2})[/.](\d{1,2})[/.](\d{4})/;
const DAY_MONTH_YEAR = /(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?([a-z]{3,9})\.?,?\s+(\d{4})/i;
const MONTH_DAY_YEAR = /([a-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})/i;

function monthNumber(name) {
  return MONTHS.test(name) ? MONTH_NAMES.indexOf(name.slice(0, 3).toLowerCase()) + 1 : 0;
}

function readParts(text) {
  let match = text.match(ISO);
  if (match) return { year: +match[1], month: +match[2], day: +match[3] };
  match = text.match(DAY_FIRST_NUMERIC);
  if (match) return { year: +match[3], month: +match[2], day: +match[1] };
  match = text.match(DAY_MONTH_YEAR);
  if (match) return { year: +match[3], month: monthNumber(match[2]), day: +match[1] };
  match = text.match(MONTH_DAY_YEAR);
  if (match) return { year: +match[3], month: monthNumber(match[1]), day: +match[2] };
  return null;
}

/**
 * Reads a calendar date from text such as "2027-03-12", "12 March 2027", "March 12th, 2027" or
 * "12/03/2027" (day first). A date without a year is not guessed.
 * @param {string} text The user's words.
 * @returns {string | null} ISO date at 00:00 UTC, or null when there is no valid full date.
 */
export function parseEventDate(text) {
  if (typeof text !== "string") return null;
  const parts = readParts(text);
  if (!parts || parts.month < 1 || parts.month > 12 || parts.year < 2000 || parts.year > 2100) {
    return null;
  }
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
  const sameDay =
    date.getUTCFullYear() === parts.year &&
    date.getUTCMonth() === parts.month - 1 &&
    date.getUTCDate() === parts.day;
  return sameDay ? date.toISOString() : null;
}
