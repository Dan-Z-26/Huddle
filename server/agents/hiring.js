import { mentionsMoney } from "../core/amount.js";
import {
  agentPrompt,
  generate as realGenerate,
  generateOrDemo,
  wrapUntrusted,
} from "../llm/index.js";
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
    "text: plain text under 1500 characters, with short labelled parts: About the event, Scope, " +
      "Dates, Must-haves, How we will choose, What to send back.",
    "deliverables: three to six documents or items this vendor must provide, specific to the " +
      "category (a menu and a food licence for a caterer, say).",
    "Use only facts given. Never invent dates, numbers or brand names.",
    "Write to an outside vendor who knows nothing about this team: never mention a lead, a " +
      "manager or how the brief was made. If an answer is empty, say it is still to be confirmed.",
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

function plainBrief(profile, category, answers) {
  return [
    `Hiring brief: ${category.name}`,
    `About the event: ${profile.name}. ${profile.purpose}`,
    `Scope: ${answers.scope}`,
    `Dates: ${answers.dates}`,
    `Must-haves: ${answers.mustHaves || "None stated yet."}`,
    `How we will choose: ${answers.judging}`,
    "What to send back: your price at this guest count, what is included and excluded, taxes, " +
      "staffing, setup time, cancellation terms, any minimum guest count and how long the quote " +
      "is valid.",
  ]
    .filter((line) => !mentionsMoney(line))
    .join("\n");
}

/**
 * Drafts a hiring brief from the EventProfile and the lead's answers. It goes outside the team, so
 * the budget is never given to the model, and anything mentioning money is thrown away.
 * @param {{profile: object, category: {id: string, name: string}, answers: object}} input The event,
 *   the category and the answers.
 * @param {{generate?: Function}} [deps] The model call, replaceable in tests.
 * @returns {Promise<{text: string, deliverables: string[], offline: boolean}>} The brief.
 */
export async function draftBrief({ profile, category, answers }, { generate = realGenerate } = {}) {
  const plain = plainBrief(profile, category, answers);
  const content = [
    `Category: ${category.name}`,
    wrapUntrusted(
      "event",
      JSON.stringify({
        name: profile.name,
        purpose: profile.purpose,
        city: profile.city,
        venueType: profile.venueType,
        guestsShouldFeel: profile.attendeeExperience,
      }),
    ),
    wrapUntrusted("lead answers", JSON.stringify(answers)),
  ].join("\n");
  const { data, offline } = await generateOrDemo(generate, {
    agent: "vendor",
    system: BRIEF_SYSTEM,
    messages: [{ role: "user", content }],
    schema: briefOutput,
    demo: async () => ({ text: plain, deliverables: DEFAULT_DELIVERABLES }),
  });
  const items = (data.deliverables ?? [])
    .map((item) => item.trim())
    .filter((item) => item && !mentionsMoney(item))
    .slice(0, MAX_DELIVERABLES);
  return {
    text: data.text && !mentionsMoney(data.text) ? data.text : plain,
    deliverables: items.length ? items : DEFAULT_DELIVERABLES,
    offline,
  };
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
    demo: async () => ({ text: plain }),
  });
  return data.text && !mentionsMoney(data.text) ? data.text : plain;
}
