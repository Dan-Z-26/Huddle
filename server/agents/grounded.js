const AMOUNT =
  /(\d[\d,]*(?:\.\d+)?)\s*(lakhs?|crores?|thousand|million|billion|percent|%|k\b|m\b)?/gi;
const SCALE_WORDS =
  /\b(?:ten|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|lakhs?|crores?|million|billion)\b/gi;

// @huddle is how people call the Planner, so telling them about it pings nobody.
const LINKS_AND_MENTIONS = /(?:https?:\/\/|www\.)\S+|@(?!huddle\b)\w+/gi;
const fold = (text) => String(text ?? "").normalize("NFKC");
const hasForeignDigits = (text) =>
  [...text.matchAll(/\p{Nd}/gu)].some(([digit]) => !/\d/.test(digit));
const wordsIn = (text) =>
  new Set((text.match(SCALE_WORDS) ?? []).map((word) => word.toLowerCase()));

function amountsIn(text) {
  return [...text.matchAll(AMOUNT)].map(([, digits, unit = ""]) => ({
    number: digits.replaceAll(",", ""),
    unit: unit.toLowerCase().replace(/s$/, "").replace("percent", "%"),
  }));
}

/**
 * Checks that model-written text uses only figures that code or the user already supplied, which
 * keeps invented amounts out of anything shown to people. A number followed by a unit (lakh, crore,
 * %, k) must appear with that same unit in `allowedText`; spelled-out scale words must appear there
 * too. Digits from other scripts are refused.
 * @param {string} text The model's wording.
 * @param {string} allowedText Everything the model was allowed to quote.
 * @returns {boolean} True when every figure in `text` is also in `allowedText`.
 */
export function isGrounded(text, allowedText) {
  const wanted = fold(text);
  const allowed = fold(allowedText);
  if (hasForeignDigits(wanted)) return false;
  const have = amountsIn(allowed);
  const numbers = new Set(have.map(({ number }) => number));
  const withUnit = new Set(have.map(({ number, unit }) => `${number}${unit}`));
  const known = wordsIn(allowed);
  return (
    amountsIn(wanted).every(({ number, unit }) =>
      unit ? withUnit.has(`${number}${unit}`) : numbers.has(number),
    ) && [...wordsIn(wanted)].every((word) => known.has(word))
  );
}

/**
 * Returns model wording when it is grounded, else a safe fallback. Links and @mentions are removed,
 * because only code decides who gets pinged and nothing from a model should be clickable.
 * @param {string | undefined} text The model's wording.
 * @param {string} allowedText Everything the model was allowed to quote.
 * @param {string} [fallback] Used when the wording is empty or cites a figure that was not supplied.
 * @returns {string} Trimmed wording or the fallback.
 */
export function groundedOr(text, allowedText, fallback = "") {
  const wording = typeof text === "string" ? text.replace(LINKS_AND_MENTIONS, "").trim() : "";
  return wording && isGrounded(wording, allowedText) ? wording : fallback;
}
