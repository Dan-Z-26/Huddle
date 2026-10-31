// Offline stand-ins for the Vendor model. A file gets a fixed sample; pasted text is read with patterns.

// Quotes are read from their first 8000 characters, as in the vendor agent.
const MAX_READ = 8000;
const SAMPLE = {
  vendorName: "Sample Caterers (demo)",
  perGuestText: "₹1,800 per guest",
  fixedText: "₹50,000",
  taxPercent: 18,
  includes: ["Buffet menu", "Service staff", "Crockery and cutlery"],
  answers: {
    staffing: "12 service staff",
    setupHours: "Setup 3 hours before, teardown 2 hours after",
    cancellationTerms: "50% refundable up to 14 days before",
    dietary: "Vegetarian and Jain options available",
  },
};
const PER_GUEST =
  /(?:₹|rs\.?|inr)?\s*[\d,]+(?:\.\d+)?\s*(?:\/|per\s+)\s*(?:guest|head|person|plate|pax)/i;
const FIXED =
  /(?:fixed|setup|service|flat|lump\s*sum)\D{0,20}((?:₹|rs\.?|inr)\s*[\d,]+(?:\.\d+)?(?:\s*(?:lakh|k))?)/i;
const TAX =
  /(?:(\d{1,2}(?:\.\d+)?)\s*%\s*(?:gst|tax|vat)|(?:gst|tax|vat)\s*[@:]?\s*(\d{1,2}(?:\.\d+)?)\s*%)/i;
function taxPercent(text) {
  const match = text.match(TAX);
  return match ? Number(match[1] ?? match[2]) : undefined;
}
const lineWith = (text, pattern) => text.match(pattern)?.[0].trim().slice(0, 200) ?? null;

/**
 * Reads a pasted quote with simple patterns.
 * @param {string} text The quote text.
 * @returns {object} An object shaped like the quote extraction schema's `extracted`.
 */
export function demoQuoteFromText(input) {
  const text = input.slice(0, MAX_READ);
  const named = text.match(/(?:vendor|from|company)\s*[:-]\s*(.+)/i)?.[1] ?? text.split("\n")[0];
  const includes = (text.match(/includes?\s*:\s*(.+)/i)?.[1] ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return {
    vendorName: named.trim().slice(0, 120) || "Unknown vendor",
    perGuestText: text.match(PER_GUEST)?.[0].trim(),
    fixedText: text.match(FIXED)?.[1].trim(),
    taxPercent: taxPercent(text),
    includes,
    answers: {
      staffing: lineWith(text, /\d+\s+(?:\w+\s+)?(?:staff|waiters|crew)[^.\n]*/i),
      setupHours: lineWith(text, /set-?up[^.\n]*/i),
      cancellationTerms: lineWith(text, /cancel[^.\n]*/i),
      dietary: lineWith(text, /(?:veg|vegan|jain|halal|gluten)[^.\n]*/i),
    },
  };
}

/** The fixed result for an uploaded file in demo mode, since reading files needs a real model. */
export const demoQuoteFromFile = () => structuredClone(SAMPLE);
