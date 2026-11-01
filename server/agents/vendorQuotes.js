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
const UNREAD_FILE =
  "The AI couldn't read this file just now. Please add the quote again in a moment, or type the figures here";
const quoteCache = new Map();

const hash = (value) => createHash("sha256").update(value).digest("hex").slice(0, 32);
const clean = (value, max) =>
  typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null;

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
  const price = (text, label) => {
    if (!text) return 0;
    const amount = parseMoneyField(text, currency);
    if (!amount) warnings.push(`I couldn't read the ${label} price "${text.slice(0, 40)}"`);
    else if (amount.currency && amount.currency !== currency) {
      warnings.push(`The ${label} price "${text.slice(0, 40)}" isn't in ${currency}`);
      return 0;
    }
    return amount?.minor ?? 0;
  };
  const perGuestMinor = price(extracted.perGuestText, "per-guest");
  const fixedMinor = price(extracted.fixedText, "fixed");
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
      exclusions: (extracted.exclusions ?? []).map((item) => clean(item, 120)).filter(Boolean),
      minGuests: extracted.minGuests ?? null,
      validUntil: clean(extracted.validUntil, 80),
      sources: Object.fromEntries(
        Object.entries(extracted.sources ?? {}).map(([key, text]) => [key, clean(text, 160)]),
      ),
      includes: (extracted.includes ?? []).map((item) => clean(item, 120)).filter(Boolean),
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
 *   (without id or event id, which the route assigns), warnings to show, and a rationale.
 * @throws {RangeError} When the category does not exist.
 */
export async function extractQuote(
  { profile, categoryId, template, text = "", file },
  { generate = realGenerate, cache = quoteCache } = {},
) {
  categoryOf(template, categoryId);
  const body = text.slice(0, MAX_QUOTE_TEXT);
  // By the file's content, so the same file is only ever read once, whoever uploads it again.
  const key = file
    ? `file:${profile.id}:${categoryId}:${hash(file.buffer)}`
    : `text:${hash(`${profile.id}:${categoryId}:${body}`)}`;
  if (cache.has(key)) {
    const known = structuredClone(cache.get(key));
    if (file) known.extractedQuote.sourceFileId = file.id;
    return known;
  }

  const mustHaves = profile.mustHaves
    .filter((item) => item.categoryId === categoryId)
    .map(({ id, text: label }) => ({ id, text: label }));
  const demo = () =>
    quoteExtraction.parse({
      extracted: file
        ? (seededReading(file.buffer) ?? demoQuoteFromFile())
        : demoQuoteFromText(body),
      rationale: file
        ? "This is a sample result, because no AI key is set."
        : "I read the quote with simple rules.",
    });
  const content = [
    wrapUntrusted("must-haves for this category", JSON.stringify(mustHaves)),
    wrapUntrusted("quote text", body || "(no pasted text; see the attached file)", MAX_QUOTE_TEXT),
  ].join("\n");
  const { data, fellBack, offline } = await generateOrDemo(generate, {
    agent: "vendor",
    system: QUOTE_SYSTEM,
    messages: [{ role: "user", content }],
    files: file ? [{ mime: file.mime, buffer: file.buffer, name: file.name }] : [],
    schema: quoteExtraction,
    demo,
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
