import { capacityDriver, category, defineTemplate, driver, scaledMilestones } from "./shared.js";

const categories = [
  category(
    "venue-permits",
    "Venue & permits",
    ["Free public space", "Hired ground with permits"],
    [
      capacityDriver("ground-hire", "Ground hire by capacity", 8000),
      driver("permits", "Permits and licences", "fixed", 2000),
    ],
  ),
  category(
    "food",
    "Food",
    ["Tea and snacks", "Full community meal"],
    [
      driver("meal", "Meal per attendee", "perGuest", 9000),
      driver("food-stalls", "Stalls and serving", "fixed", 1000),
    ],
  ),
  category(
    "av-stage",
    "AV & stage",
    ["Portable PA", "Stage with full sound"],
    [
      driver("stage", "Stage and sound", "fixed", 7000),
      driver("av-operator", "Operator hours", "perUnit", 3000, { units: 6 }),
    ],
  ),
  category(
    "photo-video",
    "Photo & video",
    ["Volunteer photos", "Hired photographer"],
    [driver("coverage-hours", "Coverage hours", "perUnit", 10000, { units: 4 })],
  ),
  category(
    "logistics-safety",
    "Logistics & safety",
    ["Volunteer marshals", "Hired security and first aid"],
    [
      driver("safety-staff", "Safety and first-aid staff", "perUnit", 7000, { units: 8 }),
      driver("barricades", "Barricades and toilets", "fixed", 3000),
    ],
  ),
  category(
    "outreach",
    "Outreach",
    ["Word of mouth", "Posters and local media"],
    [
      driver("posters", "Posters and flyers", "perUnit", 6000, { units: 200 }),
      driver("local-ads", "Local media", "fixed", 4000),
    ],
  ),
  category(
    "activities",
    "Activities",
    ["Open games", "Hosted activities"],
    [driver("activity-kits", "Activity kits", "fixed", 10000)],
  ),
];

const roles = [
  {
    id: "manager",
    name: "Organiser",
    kind: "manager",
    categoryIds: categories.map(({ id }) => id),
  },
  {
    id: "volunteer-lead",
    name: "Volunteer lead",
    kind: "core",
    categoryIds: ["food", "logistics-safety", "outreach", "activities"],
  },
];

export const community = defineTemplate({
  eventType: "community",
  label: "Community event",
  categories,
  roles,
  people: {
    manager: "Fatima Sheikh",
    "volunteer-lead": "Ravi Kulkarni",
  },
  categoryGroups: [
    { slug: "food", categoryIds: ["food"] },
    { slug: "av-stage", categoryIds: ["av-stage"] },
    { slug: "photo-video", categoryIds: ["photo-video"] },
    {
      slug: "venue-logistics",
      categoryIds: ["venue-permits", "logistics-safety"],
    },
  ],
  milestones: scaledMilestones(67),
});
