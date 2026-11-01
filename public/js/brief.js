import { clear, el, formatDate, formatMoney } from "./dom.js";
import { FIELD_ORDER, FIELD_META } from "./fields.js";

const DAY_MS = 86400000;

/** "75 days to go", "Today", or "Event date passed". */
export function countdown(iso) {
  if (!iso) return "";
  const days = Math.ceil(
    (Date.parse(iso) - Date.parse(new Date().toISOString().slice(0, 10))) / DAY_MS,
  );
  if (days > 1) return `${days} days to go`;
  if (days === 1) return "Tomorrow";
  return days === 0 ? "Today" : "Event date has passed";
}

const VISIBLE_TO_MANAGER = "Visible to the event manager";

// How each field reads on the brief. A missing answer gives nothing, and stays off the page.
const READERS = {
  name: (profile) => profile.name,
  purpose: (profile) => profile.purpose,
  date: (profile) => profile.date && formatDate(profile.date),
  city: (profile) => profile.city,
  venueType: (profile) => profile.venueType,
  guests: ({ guests }) => (guests?.confirmed ? `${guests.confirmed} guests` : ""),
  budget: ({ budget }, { canSeeBudget }) => {
    if (!canSeeBudget) return VISIBLE_TO_MANAGER;
    return budget?.totalMinor && formatMoney(budget.totalMinor, budget.currency);
  },
  priorities: ({ priorities }, { categories }) => {
    const names = new Map(categories.map(({ id, name }) => [id, name]));
    return priorities?.map((id, i) => `${i + 1}. ${names.get(id) ?? id}`).join("  ");
  },
  attendeeExperience: (profile) => profile.attendeeExperience,
  mustHaves: ({ mustHaves }) => mustHaves?.map(({ text }) => text).join(", "),
  absoluteMustHave: ({ mustHaves, absoluteMustHaveId }) =>
    mustHaves?.find(({ id }) => id === absoluteMustHaveId)?.text,
  constraints: ({ constraints }) =>
    Object.values(constraints ?? {})
      .flat()
      .join(", "),
  vendorNeeds: ({ vendorNeeds }) => Object.values(vendorNeeds ?? {}).join(", "),
};

function valueOf(field, profile, categories, canSeeBudget) {
  const value = READERS[field](profile, { categories, canSeeBudget });
  if (value) return value;
  if (profile.skippedFields?.includes(field)) return "Skipped";
  return canSeeBudget ? "" : VISIBLE_TO_MANAGER;
}

/** Draws the event brief: every answer so far. What isn't answered yet stays off the page. */
export function renderBrief(profile, template, canSeeBudget) {
  const list = document.getElementById("plan-summary");
  clear(list);
  let answered = 0;
  for (const field of FIELD_ORDER) {
    const value = valueOf(field, profile, template.categories, canSeeBudget);
    if (!value) continue;
    answered += 1;
    list.append(
      el(
        "div",
        { class: "brief-item" },
        el("dt", { text: FIELD_META[field].title }),
        el("dd", { text: value }),
      ),
    );
  }
  document.getElementById("brief-progress").textContent = answered
    ? `${answered} of ${FIELD_ORDER.length} answered`
    : "Your answers will appear here as you go.";
}
