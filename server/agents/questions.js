const names = (template, ids) =>
  ids.map((id) => template.categories.find((category) => category.id === id)?.name ?? id);

const QUESTIONS = {
  name: (_p, t) => `What would you like to call this ${t.label.toLowerCase()}?`,
  purpose: () => "What is it about, and what do you want it to achieve?",
  date: () => "What date is it on? Please include the year, for example 12 March 2027.",
  city: () => "Which city will it be in?",
  venueType: () =>
    "What kind of venue are you thinking of? For example a hotel ballroom, an outdoor lawn, an office or a community hall.",
  guests: () => "Roughly how many guests do you expect? A range or a rough number is fine.",
  budget: () =>
    "What is your total budget? You can write it the way you say it, like 16 lakh. I'll use INR unless you tell me otherwise.",
  priorities: (_p, t) =>
    `Please rank these from most to least important to you: ${t.categories.map(({ name }) => name).join(", ")}.`,
  attendeeExperience: () => "When guests leave, what should they feel or remember?",
  mustHaves: () =>
    "Is there anything that absolutely has to be part of it? List as many as you like, or say none.",
  absoluteMustHave: (p) =>
    `If you could keep only one, which is the absolute must-have? ${p.mustHaves.map(({ text }) => text).join("; ")}.`,
  constraints: () =>
    "Any constraints I should plan around: hard deadlines, dietary or accessibility needs, brand rules, venue limits? Say none if not.",
  vendorNeeds: (p, t) =>
    `What do you need from each vendor category (for example a halal menu from the caterer)? Your top areas: ${names(t, p.priorities.slice(0, 3)).join(", ")}. Say skip to decide later.`,
};

/** The fixed question for an intake field; the model may reword it, but this is the fallback. */
export function questionFor(field, profile, template) {
  return QUESTIONS[field](profile, template);
}

/** The follow-up that turns a fuzzy guest range into one confirmed planning number. */
export function guestConfirmation({ min, max, suggested }) {
  const said = min === max ? `around ${max}` : `${min} to ${max}`;
  return `You said ${said} guests. Shall I plan for ${suggested} (your upper estimate plus a 5% buffer)? Say yes, or tell me the number you prefer.`;
}
