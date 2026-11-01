/** The Vendor agent's checklists and quote questions, and its answers about vendors. */
import { categoryOf } from "../core/templates.js";
import { longDate } from "../core/time.js";
import { generate as realGenerate, generateOrDemo, wrapUntrusted } from "../llm/index.js";
import { groundedOr, isGrounded } from "./grounded.js";
import { rfqOutput, vendorAnswerOutput } from "./schemas.js";
import { remember } from "./vendorCache.js";
import { ANSWER_SYSTEM, RFQ_SYSTEM } from "./vendorPrompts.js";

const MAX_ITEMS = 12;
const rfqCache = new Map();

function standardQuestions(profile) {
  const { guests, date, constraints } = profile;
  const questions = [
    `Please quote for ${guests.confirmed} guests on ${longDate(date)}, showing the price per guest and any fixed charges separately.`,
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
  { generate = realGenerate, cache = rfqCache } = {},
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

  const demo = () => ({
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
    demo: () => ({ reply: fallback.slice(0, 1500), rationale: "" }),
  });
  return groundedOr(data.reply, `${facts} ${text}`, fallback);
}
