import { createEvent, createWorkspace, postAgentMessage } from "./workspace.js";

export const DEMO_EVENT_ID = "demo";
const DAY_MS = 86400000;
const DEMO_LEAD_DAYS = 75;

function demoProfile(nowIso) {
  const date = new Date(Date.parse(nowIso.slice(0, 10)) + DEMO_LEAD_DAYS * DAY_MS).toISOString();
  return {
    id: DEMO_EVENT_ID,
    eventType: "corporate_launch",
    name: "Nova X1 Launch",
    purpose: "Unveil the Nova X1 to partners and press",
    date,
    city: "Pune",
    venueType: "hotel ballroom",
    guests: { min: 200, max: 200, suggested: 210, confirmed: 200 },
    budget: { totalMinor: 160000000, currency: "INR" },
    priorities: ["reveal", "food-beverage", "decor", "av", "pr", "gifting", "music", "photo-video"],
    attendeeExperience: "inspired and proud to be first to see it",
    mustHaves: [
      {
        id: "mh-1",
        text: "branded reveal stage",
        categoryId: "decor",
        minTierId: "full-stage-wrap",
      },
      { id: "mh-2", text: "vegetarian menu options", categoryId: "food-beverage", minTierId: null },
    ],
    absoluteMustHaveId: "mh-1",
    constraints: {
      deadlines: ["Press embargo lifts at 11 am"],
      dietary: ["vegetarian options"],
      accessibility: ["wheelchair access"],
      brand: [],
      venue: [],
    },
    vendorNeeds: {},
    skippedFields: ["vendorNeeds"],
    intakeStatus: "in_progress",
  };
}

/**
 * Fills the store with a complete demo event so the app is useful the moment it starts.
 * @param {object} store The store.
 * @param {string} [nowIso] The current time; the event date is set relative to it.
 * @returns {string} The demo event id.
 */
export function seedDemo(store, nowIso = new Date().toISOString()) {
  const { event } = createEvent(store, {
    eventType: "corporate_launch",
    id: DEMO_EVENT_ID,
    profile: demoProfile(nowIso),
  });
  const { groups } = createWorkspace(store, event, nowIso);
  const bySlug = Object.fromEntries(groups.map((group) => [group.slug, group]));
  const say = (slug, text) =>
    postAgentMessage(store, {
      groupId: bySlug[slug].id,
      authorId: `agent-planner@${DEMO_EVENT_ID}`,
      text,
      nowIso,
    });
  say("core-team", "This is the core team room. Budget talk and quote comparisons live here.");
  say("stage-decor", "Stage and décor room. Your must-have: a branded reveal stage.");
  say("food-beverage", "Food and beverage room. Remember the vegetarian options.");
  return DEMO_EVENT_ID;
}
