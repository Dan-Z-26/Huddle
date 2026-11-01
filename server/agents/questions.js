import { categoryName } from "../core/templates.js";
const names = (template, ids) => ids.map((id) => categoryName(template, id));

const QUESTIONS = {
  name: (_p, t) => `What should we call this ${t.label.toLowerCase()}?`,
  purpose: () => "What is the event about, and what should it achieve?",
  date: () => "When is it?",
  city: () => "Which city is it in?",
  venueType: () => "What kind of venue are you thinking of?",
  guests: () => "How many guests do you expect?",
  budget: () => "What is your total budget?",
  priorities: () => "What matters most to you?",
  attendeeExperience: () => "When guests leave, what should they feel?",
  mustHaves: () => "What must be part of this event?",
  absoluteMustHave: () => "If you could keep only one, which would it be?",
  constraints: () => "Is there anything to plan around?",
  vendorNeeds: (p, t) =>
    `Anything specific you need from vendors, starting with ${names(t, p.priorities.slice(0, 3)).join(", ")}?`,
};

/** The fixed question for an intake field; the model may reword it, but this is the fallback. */
export function questionFor(field, profile, template) {
  return QUESTIONS[field](profile, template);
}

/** The follow-up that turns a fuzzy guest range into one confirmed planning number. */
export function guestConfirmation({ min, max, suggested }) {
  const said = min === max ? `around ${max}` : `${min} to ${max}`;
  return `You mentioned ${said} guests. Shall I plan for ${suggested}, your upper estimate plus a 5% buffer? Or give the number you prefer.`;
}

const textOf = (option) => (typeof option === "string" ? option : option.text);

/**
 * The answer buttons for a field: this event's own must-haves or guest suggestion where they
 * apply, then what the AI wrote for this event, then the event type's standard ones.
 * @param {string | null} field The field being asked.
 * @param {object} profile EventProfile.
 * @param {object} template The event template.
 * @returns {string[]} Button labels, which are also the answers they send.
 */
export function optionsFor(field, profile, template) {
  if (field === "absoluteMustHave") return profile.mustHaves.map(({ text }) => text);
  if (field === "guests" && profile.guests.suggested > 0 && profile.guests.confirmed === null)
    return [`Yes, plan for ${profile.guests.suggested}`];
  const options = profile.suggestedOptions?.[field] ?? template.intakeOptions[field] ?? [];
  return options.map(textOf);
}

/** The category of a must-have the user tapped, from the buttons they were offered. */
export function categoryOfOption(text, profile, template) {
  const options = [
    ...(profile.suggestedOptions?.mustHaves ?? []),
    ...(template.intakeOptions.mustHaves ?? []),
  ];
  return options.find((option) => option.text === text)?.categoryId ?? null;
}

const MAX_OPTIONS = 6;
const MAX_OPTION_LENGTH = 60;

function usableTexts(list = []) {
  const seen = new Set();
  return list
    .map((text) => (typeof text === "string" ? text.trim() : ""))
    .filter((text) => {
      // A button never carries a figure: numbers come from the user or from code.
      const fine = text && text.length <= MAX_OPTION_LENGTH && !/\d/.test(text);
      const fresh = fine && !seen.has(text.toLowerCase());
      if (fresh) seen.add(text.toLowerCase());
      return fresh;
    })
    .slice(0, MAX_OPTIONS);
}

/**
 * Checks the answer buttons the model wrote for this event. A field with too few usable ones is
 * left out, so the event type's standard buttons are used instead.
 * @param {object | undefined} options The model's options.
 * @param {object} template The event template.
 * @returns {object} Usable options by field.
 */
export function cleanOptions(options, template) {
  const clean = {};
  for (const field of ["name", "purpose", "venueType", "attendeeExperience", "constraints"]) {
    const texts = usableTexts(options?.[field]);
    if (texts.length >= 2) clean[field] = texts;
  }
  const known = new Set(template.categories.map(({ id }) => id));
  const items = options?.mustHaves ?? [];
  const texts = usableTexts(items.map(({ text }) => text));
  if (texts.length >= 2)
    clean.mustHaves = texts.map((text) => {
      const categoryId = items.find((item) => item.text.trim() === text)?.categoryId;
      return { text, categoryId: known.has(categoryId) ? categoryId : null };
    });
  return clean;
}
