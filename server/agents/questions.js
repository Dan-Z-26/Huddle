const names = (template, ids) =>
  ids.map((id) => template.categories.find((category) => category.id === id)?.name ?? id);

const QUESTIONS = {
  name: (_p, t) => `What should we call this ${t.label.toLowerCase()}?`,
  purpose: () => "What is the event about, and what should it achieve?",
  date: () => "What date is the event?",
  city: () => "Which city is it in?",
  venueType: () => "What type of venue are you considering?",
  guests: () => "How many guests are you expecting? A rough number or a range works.",
  budget: () => "What is your total budget? Amounts are in INR unless you say otherwise.",
  priorities: () => "Rank the categories from most to least important to you.",
  attendeeExperience: () => "When guests leave, what should they feel or remember?",
  mustHaves: () => "What must be part of this event? List as many as you like, or say none.",
  absoluteMustHave: () => "If you could keep only one of your must-haves, which would it be?",
  constraints: () =>
    "Are there constraints to plan around, such as deadlines, dietary or accessibility needs, brand rules or venue limits? Say none if not.",
  vendorNeeds: (p, t) =>
    `What do you need from each vendor category, starting with ${names(t, p.priorities.slice(0, 3)).join(", ")}? Say skip to decide later.`,
};

/** The fixed question for an intake field; the model may reword it, but this is the fallback. */
export function questionFor(field, profile, template) {
  return QUESTIONS[field](profile, template);
}

/** The follow-up that turns a fuzzy guest range into one confirmed planning number. */
export function guestConfirmation({ min, max, suggested }) {
  const said = min === max ? `around ${max}` : `${min} to ${max}`;
  return `You mentioned ${said} guests. Shall I plan for ${suggested}, your upper estimate plus a 5% buffer? Reply yes, or give the number you prefer.`;
}
