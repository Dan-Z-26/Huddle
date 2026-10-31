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

function valueOf(field, profile, categories, canSeeBudget) {
  const names = new Map(categories.map(({ id, name }) => [id, name]));
  const skipped = profile.skippedFields?.includes(field);
  const values = {
    name: profile.name,
    purpose: profile.purpose,
    date: profile.date && formatDate(profile.date),
    city: profile.city,
    venueType: profile.venueType,
    guests: profile.guests?.confirmed ? `${profile.guests.confirmed} guests` : "",
    budget: canSeeBudget
      ? profile.budget?.totalMinor &&
        formatMoney(profile.budget.totalMinor, profile.budget.currency)
      : "Visible to the event manager",
    priorities: profile.priorities?.map((id, i) => `${i + 1}. ${names.get(id) ?? id}`).join("  "),
    attendeeExperience: profile.attendeeExperience,
    mustHaves: profile.mustHaves?.map(({ text }) => text).join(", "),
    absoluteMustHave: profile.mustHaves?.find(({ id }) => id === profile.absoluteMustHaveId)?.text,
    constraints: Object.values(profile.constraints ?? {})
      .flat()
      .join(", "),
    vendorNeeds: Object.values(profile.vendorNeeds ?? {}).join(", "),
  };
  if (values[field]) return values[field];
  if (skipped) return "Skipped";
  return canSeeBudget ? "" : "Visible to the event manager";
}

/** Draws the event brief: every intake answer so far, and what is still to do. */
export function renderBrief(profile, template, canSeeBudget) {
  const list = document.getElementById("plan-summary");
  clear(list);
  let answered = 0;
  for (const field of FIELD_ORDER) {
    const value = valueOf(field, profile, template.categories, canSeeBudget);
    if (value) answered += 1;
    list.append(
      el(
        "div",
        { class: `brief-item ${value ? "is-answered" : "todo"}` },
        el(
          "dt",
          {},
          el("span", { class: "tick", "aria-hidden": "true" }),
          FIELD_META[field].title,
          el("span", { class: "sr-only", text: value ? " (answered)" : " (to do)" }),
        ),
        el("dd", { text: value || "Not answered yet" }),
      ),
    );
  }
  document.getElementById("brief-progress").textContent =
    `${answered} of ${FIELD_ORDER.length} answered`;
}
