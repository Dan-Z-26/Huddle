import { createHash } from "node:crypto";
import { parseMoneyField } from "../core/amount.js";
import { generate as realGenerate, generateOrDemo, wrapUntrusted } from "../llm/index.js";
import { groundedOr, isGrounded } from "./grounded.js";
import { quoteExtraction, rfqOutput, vendorAnswerOutput } from "./schemas.js";
import { seededReading } from "./sampleQuotes.js";
import { demoQuoteFromFile, demoQuoteFromText } from "./vendorDemo.js";
import { ANSWER_SYSTEM, QUOTE_SYSTEM, RFQ_SYSTEM } from "./vendorPrompts.js";

const MAX_CACHE = 100;
const MAX_QUOTE_TEXT = 8000;
const MAX_ITEMS = 12;
const caches = { rfq: new Map(), quotes: new Map() };

function remember(store, key, value, cacheable = true) {
  if (cacheable) store.set(key, value);
  if (cacheable && store.size > MAX_CACHE) store.delete(store.keys().next().value);
  return structuredClone(value);
}

const hash = (value) => createHash("sha256").update(value).digest("hex").slice(0, 32);
const dateWords = (iso) =>
  new Date(iso).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });

function categoryOf(template, categoryId) {
  const category = template.categories.find(({ id }) => id === categoryId);
  if (!category) throw new RangeError(`unknown category: ${categoryId}`);
  return category;
}

function standardQuestions(profile) {
  const { guests, date, constraints } = profile;
  const questions = [
    `Please quote for ${guests.confirmed} guests on ${dateWords(date)}, showing the price per guest and any fixed charges separately.`,
    "What exactly is included in the price, and what costs extra?",
    "Are taxes such as GST included? Please show them separately.",
    "How many staff will you provide, and for how many hours?",
    "How much time do you need for setup and teardown?",
    "What are your cancellation and payment terms?",
  ];
  if (constraints.dietary.length)
    questions.push(`Can you meet these dietary needs: ${constraints.dietary.join(", ")}?`);
  if (constraints.accessibility.length)
    questions.push(
      `How will you support these accessibility needs: ${constraints.accessibility.join(", ")}?`,
    );
  return questions;
}

function requirementLines(profile, categoryId) {
  const lines = profile.mustHaves
    .filter((item) => item.categoryId === categoryId)
    .map((item) => `Must-have: ${item.text}`);
  const need = profile.vendorNeeds[categoryId];
  return need ? [...lines, `You asked for: ${need}`] : lines;
}

const merge = (own, extra, allowedText) => {
  const seen = new Set(own.map((line) => line.toLowerCase()));
  const kept = extra.filter(
    (line) => isGrounded(line, allowedText) && !seen.has(line.toLowerCase()),
  );
  return [...own, ...kept].slice(0, MAX_ITEMS);
};

/**
 * Builds the checklist and the RFQ questions for one vendor category. The standard questions and
 * the user's own requirements come from code; the model adds category-specific items, and any
 * item that quotes a number nobody supplied is dropped. Cached until the relevant profile changes.
 * @param {{profile: object, categoryId: string, template: object}} input The confirmed profile,
 *   the category, and the event template.
 * @param {{generate?: Function, cache?: Map}} [deps] The model call and cache, replaceable in tests.
 * @returns {Promise<{checklist: string[], rfqQuestions: string[], rationale: string}>} The lists.
 * @throws {RangeError} When the category does not exist.
 */
export async function buildRfq(
  { profile, categoryId, template },
  { generate = realGenerate, cache = caches.rfq } = {},
) {
  const category = categoryOf(template, categoryId);
  const relevant = {
    categoryId,
    guests: profile.guests.confirmed,
    date: profile.date,
    city: profile.city,
    venueType: profile.venueType,
    mustHaves: profile.mustHaves.filter((item) => item.categoryId === categoryId),
    constraints: profile.constraints,
    need: profile.vendorNeeds[categoryId],
  };
  const key = JSON.stringify(relevant);
  if (cache.has(key)) return structuredClone(cache.get(key));

  const demo = async () => ({
    checklist: category.drivers.map((driver) => `Confirm ${driver.label.toLowerCase()}`),
    rfqQuestions: [],
    rationale: "These are the standard questions plus the things you told me you need.",
  });
  const content = [
    `Category: ${category.name}`,
    wrapUntrusted("event profile", JSON.stringify({ ...relevant, purpose: profile.purpose })),
  ].join("\n");
  const { data, fellBack, offline } = await generateOrDemo(generate, {
    agent: "vendor",
    system: RFQ_SYSTEM,
    messages: [{ role: "user", content }],
    schema: rfqOutput,
    demo,
  });
  const questions = standardQuestions(profile);
  const lines = requirementLines(profile, categoryId);
  const allowedText = `${JSON.stringify(relevant)} ${questions.join(" ")} ${lines.join(" ")}`;
  return remember(
    cache,
    key,
    {
      checklist: merge(lines, data.checklist, allowedText),
      rfqQuestions: merge(questions, data.rfqQuestions, allowedText),
      rationale: groundedOr(data.rationale, ""),
      offline,
    },
    !fellBack,
  );
}

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
  { generate = realGenerate, cache = caches.quotes } = {},
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
  const demo = async () =>
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

/**
 * Answers what someone actually asked about vendors, using the event and its checklist, rather than
 * handing everyone the same list.
 * @param {{text: string, categoryName: string, profile: object, rfq: object, fallback: string}}
 *   input What was asked, about which category, what is known, and the list to fall back on.
 * @param {{generate?: Function}} [deps] The model call, replaceable in tests.
 * @returns {Promise<string>} The reply; anything citing a figure from outside these facts becomes
 *   the fallback.
 */
export async function answerVendorQuestion(
  { text, categoryName, profile, rfq, fallback },
  { generate = realGenerate } = {},
) {
  const facts = JSON.stringify({
    event: {
      name: profile.name,
      purpose: profile.purpose,
      city: profile.city,
      venueType: profile.venueType,
      guests: profile.guests?.confirmed,
      mustHaves: profile.mustHaves?.map((item) => item.text),
      constraints: profile.constraints,
    },
    checklist: rfq.checklist,
    questions: rfq.rfqQuestions,
  });
  const { data } = await generateOrDemo(generate, {
    agent: "vendor",
    system: ANSWER_SYSTEM,
    messages: [
      {
        role: "user",
        content: [
          `Category: ${categoryName}`,
          wrapUntrusted("what is known", facts),
          wrapUntrusted("message", text),
        ].join("\n"),
      },
    ],
    schema: vendorAnswerOutput,
    demo: async () => ({ reply: fallback.slice(0, 1500), rationale: "" }),
  });
  return groundedOr(data.reply, `${facts} ${text}`, fallback);
}
