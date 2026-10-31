const NUMBER = /\d[\d,]*(?:\.\d+)?/g;

const numbersIn = (text) => (text.match(NUMBER) ?? []).map((number) => number.replaceAll(",", ""));

/**
 * Checks that model-written text uses only numbers that code or the user already supplied, which
 * keeps invented figures out of anything shown to people.
 * @param {string} text The model's wording.
 * @param {string} allowedText Everything the model was allowed to quote.
 * @returns {boolean} True when every number in `text` also appears in `allowedText`.
 */
export function isGrounded(text, allowedText) {
  const allowed = new Set(numbersIn(allowedText));
  return numbersIn(text).every((number) => allowed.has(number));
}
