import { mentionsMoney } from "../core/amount.js";
import {
  agentPrompt,
  generate as realGenerate,
  generateOrDemo,
  wrapUntrusted,
} from "../llm/index.js";
import { isGrounded } from "./grounded.js";
import { briefOutput, declineOutput } from "./schemas.js";

const DEFAULT_DELIVERABLES = [
  "Licence or registration",
  "Insurance certificate",
  "Staff list",
  "Setup plan",
];
const MAX_DELIVERABLES = 6;

const BRIEF_SYSTEM = agentPrompt({
  role:
    "You are the Vendor agent of Huddle. You write a clear hiring brief that the team will send " +
    "to outside vendors so they can quote.",
  steps: [
    "read the event and the lead's answers",
    "keep to what is stated",
    "write a short brief",
    "list what the vendor must hand over",
  ],
  rules: [
    "NEVER mention a budget, an allocation, a price or any amount of money. This goes outside " +
      "the team.",
    "Fill each part as one or two complete, clear sentences, with no heading in it and no line " +
      "breaks: about (the event and why it matters), scope (what this vendor would do), dates " +
      "(when and where), howWeChoose (how a vendor will be picked).",
    "mustHaves: a list, one short item each, from the answers only. Empty if none were given.",
    "The answers come from the person hiring. Keep what they said and tidy only the wording.",
    "deliverables: three to six documents or items this vendor must provide, specific to the " +
      "category (a menu and a food licence for a caterer, say).",
    "Use only facts given. Never invent dates, numbers or brand names.",
    "Write to an outside vendor who knows nothing about this team: never mention a lead, a " +
      "manager or how the brief was made. If an answer is empty, leave that part empty.",
  ],
});

const DECLINE_SYSTEM = agentPrompt({
  role: "You are the Vendor agent of Huddle. You write a short, gracious note declining a vendor.",
  steps: ["read the facts", "write the note"],
  rules: [
    "Three sentences at most. Thank them, say another vendor was chosen, and leave the door open.",
    "Never mention prices, other vendors' names or why they lost.",
  ],
});

const dateWords = (iso) =>
  new Date(iso).toLocaleDateString("en-GB", { dateStyle: "long", timeZone: "UTC" });

/**
 * Answers for a new brief, filled in from what the event already knows, so the lead only corrects
 * them. Never holds money: budget figures aren't read.
 * @param {object} profile EventProfile.
 * @param {{id: string, name: string}} category The category being hired for.
 * @returns {{scope: string, deliverables: string, dates: string, mustHaves: string,
 *   judging: string}} The answers.
 */
export function defaultAnswers(profile, category) {
  const own = profile.mustHaves.filter(({ categoryId }) => categoryId === category.id);
  return {
    scope: `${category.name} for ${profile.name}, for ${profile.guests.confirmed} guests.`,
    deliverables: "",
    dates: `${dateWords(profile.date)} in ${profile.city}.`,
    mustHaves: own.map(({ text }) => text).join(", "),
    judging: "Fit with our must-haves, clear all-in pricing and reliability.",
  };
}

const SEND_BACK = [
  "Your price at this guest count",
  "What is included and excluded",
  "Taxes",
  "Staffing",
  "Setup and teardown time",
  "Cancellation terms",
  "Any minimum guest count",
  "How long the quote is valid",
];
const TO_CONFIRM = "To be confirmed.";

const listOf = (text) =>
  String(text ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

// Answers are kept as typed, so what is shown reads as a sentence whoever wrote it.
const tidy = (text) => {
  const trimmed = String(text ?? "").trim();
  if (!trimmed) return "";
  const capital = trimmed[0].toUpperCase() + trimmed.slice(1);
  return /[.!?]$/.test(capital) ? capital : `${capital}.`;
};

function plainSections(profile, answers) {
  return {
    about: [profile.name, profile.purpose].filter(Boolean).map(tidy).join(" "),
    scope: answers.scope,
    dates: answers.dates,
    mustHaves: listOf(answers.mustHaves),
    howWeChoose: answers.judging,
  };
}

const bullets = (items) => items.map((item) => `- ${item}`).join("\n");

/**
 * Lays out a brief. The layout is code, so a brief reads the same whether the AI wrote it or the
 * manager typed the answers: a heading, then its text, with a blank line between parts. The page
 * draws headings and lists from this, and it can still be copied or downloaded as plain text.
 * @param {{category: {name: string}, sections: object, deliverables: string[]}} input The parts.
 * @returns {string} The brief.
 */
export function formatBrief({ category, sections, deliverables }) {
  const part = (heading, body) => `${heading}\n${body}`;
  return [
    `Hiring brief: ${category.name}`,
    part("About the event", sections.about || TO_CONFIRM),
    part("Scope", tidy(sections.scope) || TO_CONFIRM),
    part("Dates and place", tidy(sections.dates) || TO_CONFIRM),
    part("Must-haves", sections.mustHaves.length ? bullets(sections.mustHaves) : TO_CONFIRM),
    part("How we will choose", tidy(sections.howWeChoose) || TO_CONFIRM),
    part("What to hand over", bullets(deliverables)),
    part("What to send back", bullets(SEND_BACK)),
  ].join("\n\n");
}

/**
 * Drafts a hiring brief from the EventProfile and the answers given by whoever asked. It goes outside
 * the team, so the budget is never given to the model. Anything that holds money, or a figure nobody
 * gave, is replaced part by part with what was answered.
 * @param {{profile: object, category: {id: string, name: string}, answers: object}} input The event,
 *   the category and the answers.
 * @param {{generate?: Function}} [deps] The model call, replaceable in tests.
 * @returns {Promise<{text: string, deliverables: string[], offline: boolean}>} The brief. Deliverables
 *   someone asked for win over what the AI suggested.
 */
export async function draftBrief({ profile, category, answers }, { generate = realGenerate } = {}) {
  const plain = plainSections(profile, answers);
  const event = JSON.stringify({
    name: profile.name,
    purpose: profile.purpose,
    city: profile.city,
    venueType: profile.venueType,
    guests: profile.guests?.confirmed,
    guestsShouldFeel: profile.attendeeExperience,
  });
  const given = JSON.stringify(answers);
  const content = [
    `Category: ${category.name}`,
    wrapUntrusted("event", event),
    wrapUntrusted("answers", given),
  ].join("\n");
  const { data, offline } = await generateOrDemo(generate, {
    agent: "vendor",
    system: BRIEF_SYSTEM,
    messages: [{ role: "user", content }],
    schema: briefOutput,
    demo: () => ({ ...plain, deliverables: DEFAULT_DELIVERABLES }),
  });
  const allowed = `${event} ${given}`;
  const fit = (text) => !mentionsMoney(text) && isGrounded(text, allowed);
  const choose = (key) => {
    const written = data[key]?.trim();
    if (written && fit(written)) return written;
    return mentionsMoney(plain[key]) ? "" : plain[key];
  };
  const written = (data.mustHaves ?? []).map((item) => item.trim()).filter(Boolean);
  const mustHaves = written.length && written.every(fit) ? written : plain.mustHaves;
  const suggested = (data.deliverables ?? [])
    .map((item) => item.trim())
    .filter((item) => item && !mentionsMoney(item))
    .slice(0, MAX_DELIVERABLES);
  const asked = listOf(answers.deliverables).filter((item) => !mentionsMoney(item));
  const deliverables = [asked, suggested, DEFAULT_DELIVERABLES].find(({ length }) => length);
  const sections = {
    about: choose("about"),
    scope: choose("scope"),
    dates: choose("dates"),
    howWeChoose: choose("howWeChoose"),
    mustHaves: mustHaves.filter((item) => !mentionsMoney(item)),
  };
  return { text: formatBrief({ category, sections, deliverables }), deliverables, offline };
}

/**
 * Words a polite decline for a vendor who wasn't chosen, for the lead to copy.
 * @param {{vendorName: string, categoryName: string, eventName: string}} input Who and what.
 * @param {{generate?: Function}} [deps] The model call, replaceable in tests.
 * @returns {Promise<string>} The note.
 */
export async function draftDecline(
  { vendorName, categoryName, eventName },
  { generate = realGenerate } = {},
) {
  const plain =
    `Dear ${vendorName}, thank you for your quote for ${categoryName} at ${eventName}. ` +
    "We have decided to go with another vendor this time, but we appreciated the care you took " +
    "and would be glad to keep you in mind for future events.";
  const { data } = await generateOrDemo(generate, {
    agent: "vendor",
    system: DECLINE_SYSTEM,
    messages: [
      {
        role: "user",
        content: wrapUntrusted("facts", JSON.stringify({ vendorName, categoryName, eventName })),
      },
    ],
    schema: declineOutput,
    demo: () => ({ text: plain }),
  });
  return data.text && !mentionsMoney(data.text) ? data.text : plain;
}
