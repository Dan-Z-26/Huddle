const BPS_DENOMINATOR = 10000;

/**
 * Formats integer minor units as display money, with en-IN grouping for INR.
 * shortcut: assumes a two-decimal currency, upgrade when a zero-decimal currency is supported.
 * @param {number} minor Amount in minor units (paise).
 * @param {string} [currency] ISO 4217 code.
 * @returns {string} For example "₹1,25,000".
 */
export function formatMoney(minor, currency = "INR") {
  const fractionDigits = minor % 100 === 0 ? 0 : 2;
  return new Intl.NumberFormat(currency === "INR" ? "en-IN" : "en-US", {
    style: "currency",
    currency,
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: 2,
  }).format(minor / 100);
}

/**
 * Integer division rounded down, without passing through a float quotient.
 * @param {number} numerator Non-negative integer.
 * @param {number} denominator Positive integer.
 * @returns {number} floor(numerator / denominator).
 */
export function divFloor(numerator, denominator) {
  return (numerator - (numerator % denominator)) / denominator;
}

/**
 * Takes a basis-point share of an amount, rounded down.
 * @param {number} minor Non-negative integer amount.
 * @param {number} bps Basis points (10000 = 100%).
 * @returns {number} Integer share.
 */
export function shareOfBps(minor, bps) {
  return divFloor(minor * bps, BPS_DENOMINATOR);
}

/**
 * Adds tax to one price component, rounding the tax half up.
 * @param {number} minor Non-negative integer price.
 * @param {number} taxBps Tax rate in basis points.
 * @returns {number} Price including tax.
 */
export function withTax(minor, taxBps) {
  return minor + divFloor(minor * taxBps + BPS_DENOMINATOR / 2, BPS_DENOMINATOR);
}
