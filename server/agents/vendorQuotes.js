/** The Vendor agent reading a quote from text or a file. A person confirms it before it counts. */
import { createHash } from "node:crypto";
import { parseMoneyField } from "../core/amount.js";
import { categoryOf } from "../core/templates.js";
import { generate as realGenerate, generateOrDemo, wrapUntrusted } from "../llm/index.js";
import { groundedOr } from "./grounded.js";
import { seededReading } from "./sampleQuotes.js";
import { quoteExtraction } from "./schemas.js";
import { remember } from "./vendorCache.js";
import { demoQuoteFromFile, demoQuoteFromText } from "./vendorDemo.js";
import { QUOTE_SYSTEM } from "./vendorPrompts.js";

const MAX_QUOTE_TEXT = 8000;
const MAX_QUOTED = 40;
const MAX_ITEM_TEXT = 120;
const UNREAD_FILE =
  "The AI couldn't read this file just now. Please add the quote again in a moment, or type the figures here";
const quoteCache = new Map();

const hash = (value) => createHash("sha256").update(value).digest("hex").slice(0, 32);
const clean = (value, max) =>
  typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null;

// A price in the event's currency, in minor units; anything else is 0 and a warning.
function readPrice(text, label, currency, warnings) {
  if (!text) return 0;
  const said = text.slice(0, MAX_QUOTED);
  const amount = parseMoneyField(text, currency);
  if (!amount) {
    warnings.push(`I couldn't read the ${label} price "${said}"`);
    return 0;
  }
  if (amount.currency && amount.currency !== currency) {
    warnings.push(`The ${label} price "${said}" isn't in ${currency}`);
    return 0;
  }
  return amount.minor;
}

const cleanList = (items = []) => items.map((item) => clean(item, MAX_ITEM_TEXT)).filter(Boolean);

/**
 * Builds a quote from fields as stated by a person or read from a document. Prices and tax are
 * parsed in code; must-have ids are kept only if they belong to this category.
 * @param {object} extracted Fields in the shape of the quote extraction schema.
 * @param {{categoryId: string, profile: object, fileId?: string | null}} context Where it belongs.
 * @returns {{quote: object, warnings: string[]}} A quote with status "extracted" (no id or event),
 *   and anything that could not be read.
 */
export function quoteFromExtracted(extracted, { categoryId, profile, fileId }) {
  const warnings = [];
  const currency = profile.budget?.currency ?? "INR";
  const perGuestMinor = readPrice(extracted.perGuestText, "per-guest", currency, warnings);
  const fixedMinor = readPrice(extracted.fixedText, "fixed", currency, warnings);
  if (!perGuestMinor && !fixedMinor) warnings.push("No price found: please enter it yourself");
  const mustHaveIds = new Set(
    profile.mustHaves.filter((item) => item.categoryId === categoryId).map(({ id }) => id),
  );
  const answers = extracted.answers ?? {};
  return {
    quote: {
      categoryId,
      status: "extracted",
      vendorName: clean(extracted.vendorName, 120) ?? "Unknown vendor",
      perGuestMinor,
      fixedMinor,
      taxBps: Math.round((extracted.taxPercent ?? 0) * 100),
      // Silence about tax is a hidden cost, so it is told apart from a stated zero.
      taxStated: extracted.taxPercent != null,
      exclusions: cleanList(extracted.exclusions),
      minGuests: extracted.minGuests ?? null,
      validUntil: clean(extracted.validUntil, 80),
      sources: Object.fromEntries(
        Object.entries(extracted.sources ?? {}).map(([key, text]) => [key, clean(text, 160)]),
      ),
      includes: cleanList(extracted.includes),
      mustHaveIdsMet: (extracted.mustHaveIdsMet ?? []).filter((id) => mustHaveIds.has(id)),
      answers: Object.fromEntries(
        ["staffing", "setupHours", "cancellationTerms", "dietary"].map((key) => [
          key,
          clean(answers[key], 200),
        ]),
      ),
      sourceFileId: fileId ?? null,
    },
    warnings,
  };
}

// By the file's content, so the same file is only ever read once, whoever uploads it again.
const quoteKey = (eventId, categoryId, body, file) =>
  file
    ? `file:${eventId}:${categoryId}:${hash(file.buffer)}`
    : `text:${hash(`${eventId}:${categoryId}:${body}`)}`;

// Quote text and file contents are untrusted data; with no model, stored or simple readings answer.
function offlineReading(body, file) {
  if (!file)
    return {
      extracted: demoQuoteFromText(body),
      rationale: "I read the quote with simple rules.",
    };
  return {
    extracted: seededReading(file.buffer) ?? demoQuoteFromFile(),
    rationale: "This is a sample result, because no AI key is set.",
  };
}

function askVendor({ profile, categoryId, body, file, generate }) {
  const mustHaves = profile.mustHaves
    .filter((item) => item.categoryId === categoryId)
    .map(({ id, text: label }) => ({ id, text: label }));
  const content = [
    wrapUntrusted("must-haves for this category", JSON.stringify(mustHaves)),
    wrapUntrusted("quote text", body || "(no pasted text; see the attached file)", MAX_QUOTE_TEXT),
  ].join("\n");
  return generateOrDemo(generate, {
    agent: "vendor",
    system: QUOTE_SYSTEM,
    messages: [{ role: "user", content }],
    files: file ? [{ mime: file.mime, buffer: file.buffer, name: file.name }] : [],
    schema: quoteExtraction,
    demo: () => quoteExtraction.parse(offlineReading(body, file)),
  });
}

/**
 * Reads one vendor quote from pasted text and/or an uploaded file into structured fields. Prices
 * and tax are parsed in code from what the quote states. Quote text and file contents are
 * untrusted data. The result has status "extracted": a person must confirm it before use. Each
 * file is read once and cached by its id.
 * @param {{profile: object, categoryId: string, template: object, text?: string,
 *   file?: {id: string, mime: string, buffer: Buffer, name: string}}} input The context, plus the
 *   quote as text or a file.
 * @param {{generate?: Function, cache?: Map}} [deps] The model call and cache, replaceable in tests.
 * @returns {Promise<{extractedQuote: object, warnings: string[], rationale: string}>} The quote
 *   (without id or event id, which the caller assigns), warnings to show, and a rationale.
 * @throws {RangeError} When the category does not exist.
 */
export async function extractQuote(
  { profile, categoryId, template, text = "", file },
  { generate = realGenerate, cache = quoteCache } = {},
) {
  categoryOf(template, categoryId);
  const body = text.slice(0, MAX_QUOTE_TEXT);
  const key = quoteKey(profile.id, categoryId, body, file);
  if (cache.has(key)) {
    const known = structuredClone(cache.get(key));
    if (file) known.extractedQuote.sourceFileId = file.id;
    return known;
  }
  const { data, fellBack, offline } = await askVendor({
    profile,
    categoryId,
    body,
    file,
    generate,
  });
  // A real file the model failed on must never come back looking read: someone would confirm a
  // vendor and prices that aren't in it. They get an empty form and the reason instead.
  if (file && fellBack && !seededReading(file.buffer)) {
    const { quote } = quoteFromExtracted({}, { categoryId, profile, fileId: file.id });
    return {
      extractedQuote: { ...quote, vendorName: "" },
      warnings: [UNREAD_FILE],
      rationale: "",
      offline: false,
    };
  }
  const { quote, warnings } = quoteFromExtracted(data.extracted, {
    categoryId,
    profile,
    fileId: file?.id,
  });
  return remember(
    cache,
    key,
    { extractedQuote: quote, warnings, rationale: groundedOr(data.rationale, ""), offline },
    !fellBack,
  );
}
