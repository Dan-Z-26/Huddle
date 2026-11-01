/** Lengths of time in milliseconds, and the one way dates are written out in shared text. */

export const MINUTE_MS = 60_000;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;

/**
 * The calendar day of an ISO time. Days written this way compare and sort as plain text.
 * @param {string} iso An ISO date or time.
 * @returns {string} For example "2027-01-13".
 */
export const dayOf = (iso) => iso.slice(0, 10);

/**
 * A date in words, the same wherever the server runs.
 * @param {string} iso An ISO date.
 * @returns {string} For example "13 January 2027".
 */
export const longDate = (iso) =>
  new Date(iso).toLocaleDateString("en-GB", { dateStyle: "long", timeZone: "UTC" });
