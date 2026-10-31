import { emptyProfile, buildBudgetState } from "../../server/core/profile.js";
import { getTemplate } from "../../server/core/templates.js";
import { generate as realGenerate } from "../../server/llm/index.js";

export const NOW = "2027-01-10T09:00:00.000Z"; // a Sunday
export const template = getTemplate("corporate_launch");
export const profile = {
  ...emptyProfile("corporate_launch", "e1"),
  name: "Nova Launch",
  purpose: "Unveil the Nova X1 to partners and press",
  date: "2027-03-12T00:00:00.000Z",
  city: "Pune",
  venueType: "hotel ballroom",
  guests: { min: 200, max: 200, suggested: 210, confirmed: 200 },
  budget: { totalMinor: 160000000, currency: "INR" },
  priorities: ["reveal", "food-beverage", "decor", "gifting"],
  attendeeExperience: "inspired and proud",
  mustHaves: [
    { id: "mh-1", text: "branded reveal stage", categoryId: "decor", minTierId: "full-stage-wrap" },
  ],
  absoluteMustHaveId: "mh-1",
};
export const state = buildBudgetState(profile, template);
export const manager = {
  kind: "manager",
  roleId: "manager",
  eventId: "e1",
  categoryIds: [],
  groupIds: [],
};
export const core = {
  kind: "core",
  roleId: "creative-director",
  eventId: "e1",
  categoryIds: ["decor"],
  groupIds: [],
};

export const demoGenerate = (request) => realGenerate({ ...request, env: {} });

/** A fake model: returns `data`, and records every request it receives. */
export function fakeModel(data) {
  const calls = [];
  return {
    calls,
    generate: async (request) => (
      calls.push(request),
      { data: typeof data === "function" ? data(request) : data, toolCalls: [] }
    ),
  };
}

export const failingModel = async () => {
  throw Object.assign(new Error("down"), { name: "LlmError" });
};
