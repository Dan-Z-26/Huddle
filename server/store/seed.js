/** The complete demo event, so the app is useful the moment it starts. */
import { DAY_MS, dayOf } from "../core/time.js";
import { agentIdFor } from "./ids.js";
import { addExpense, createEvent, createWorkspace, postAgentMessage } from "./workspace.js";

export const DEMO_EVENT_ID = "demo";
const DEMO_LEAD_DAYS = 75;
const DEMO_EXPENSES = [
  ["Caterer advance", 5000000, "food-beverage", false],
  ["Stage design deposit", 7500000, "decor", false],
  ["Press kit printing", 1800000, "pr", false],
  ["Backup generator, not in any quote", 2500000, null, true],
];

function demoProfile(nowIso) {
  const date = new Date(Date.parse(dayOf(nowIso)) + DEMO_LEAD_DAYS * DAY_MS).toISOString();
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
  for (const [description, amountMinor, categoryId, fromBuffer] of DEMO_EXPENSES)
    addExpense(
      store,
      {
        eventId: DEMO_EVENT_ID,
        description,
        amountMinor,
        categoryId,
        fromBuffer,
        createdById: `user-manager@${DEMO_EVENT_ID}`,
      },
      nowIso,
    );
  const bySlug = Object.fromEntries(groups.map((group) => [group.slug, group]));
  const say = (slug, text) =>
    postAgentMessage(store, {
      groupId: bySlug[slug].id,
      authorId: agentIdFor("planner", DEMO_EVENT_ID),
      text,
      nowIso,
    });
  say("core-team", "This is the core team room. Budget talk and quote comparisons live here.");
  say("stage-decor", "Stage and décor room. Your must-have: a branded reveal stage.");
  say("food-beverage", "Food and beverage room. Remember the vegetarian options.");
  const toHire = "When you're ready to hire, ask @huddle to draft a vendor brief.";
  say("pr-media", `PR and media room. ${toHire}`);
  say("food-beverage", toHire);
  say("music-av", `Music and AV room. ${toHire}`);
  return DEMO_EVENT_ID;
}
