/** The Discovery agent's instructions, and how each request to it is written. */
import { agentPrompt, wrapUntrusted } from "../llm/index.js";

/** The Discovery agent's instructions. */
export const SYSTEM = agentPrompt({
  role:
    "You are the Discovery agent of Huddle, a warm, practical event planner who listens. You " +
    "help an organiser describe their event, one question at a time. A good event fits the " +
    "organiser, the planner and the guests; it is not the most expensive one.",
  steps: [
    "understand the answer",
    "check the profile and constraints so far",
    "check the priorities and must-haves",
    "use a tool for any number you need",
    "use only tool results",
    "write the output",
  ],
  rules: [
    "Extract only what the user actually said. Never invent values and never do arithmetic.",
    "In names and descriptions, fix obvious spelling mistakes and shorthand ('vegeterian' to " +
      "'vegetarian', 'n' to 'and') and use normal capitals, without changing the meaning or adding " +
      "anything.",
    "Copy dates and money exactly as the user wrote them (date, budgetText, guestText); code " +
      "parses them.",
    "Priorities: only the category ids you are given, in exactly the order the user ranked " +
      "them. Never assume a ranking.",
    "If the user says none or skip for an optional field, set skipped to true.",
    "Set nextField to the first field in the missing list that is still unanswered after this " +
      "answer, and write nextQuestion as one short, friendly question about that field only.",
    "When the field being answered is opening, the user is describing the event in their own " +
      "words. Extract every field they state and leave out the rest: purpose is what the event " +
      "is about and what it should achieve, in their words, and venueType is the kind of place " +
      "if they mention one. Take name only if they name the event. Then fill options: three to " +
      "five short, neutral answer buttons for each of name (possible titles), purpose, " +
      "venueType, attendeeExperience, mustHaves (with categoryId) and constraints, " +
      "written for this particular event. No digits, prices, brands or default luxury.",
    "Also when the field being answered is opening, fill questions: for each field in the " +
      "missing list, one short, friendly question about that field only, written for this " +
      "particular event and referring to what the user told you. No digits.",
  ],
});

function summarise(profile) {
  const { guests, budget, mustHaves, constraints, vendorNeeds, priorities } = profile;
  const filled = ["name", "purpose", "date", "city", "venueType", "attendeeExperience"]
    .filter((key) => profile[key])
    .map((key) => [key, profile[key]]);
  return JSON.stringify({
    ...Object.fromEntries(filled),
    guests: guests.confirmed ?? (guests.max ? `${guests.min}-${guests.max}` : undefined),
    budget: budget.totalMinor ? "set" : undefined,
    priorities,
    mustHaves: mustHaves.map(({ text }) => text),
    constraints,
    vendorNeeds,
  });
}

/**
 * Writes one model request: what is being asked, and the user's words as delimited data.
 * @param {{profile: object, template: object, field: string, answer: string, missing: string[]}}
 *   input The profile so far, the template, the field being answered, the answer and what is left.
 * @returns {string} The message.
 */
export function buildMessage({ profile, template, field, answer, missing }) {
  const categories = template.categories.map(({ id, name, tiers }) => ({
    id,
    name,
    tiers: tiers.map((tier) => tier.id),
  }));
  return [
    `Event type: ${template.eventType}`,
    `Field being answered: ${field}`,
    `Missing fields in order: ${missing.join(", ")}`,
    `Categories: ${JSON.stringify(categories)}`,
    wrapUntrusted("profile so far", summarise(profile)),
    wrapUntrusted("user answer", answer),
  ].join("\n");
}
