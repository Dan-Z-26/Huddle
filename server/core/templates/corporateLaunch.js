/** The corporate launch event type: its categories, roles, groups and answer buttons. */
import { capacityDriver, category, defineTemplate, driver, scaledMilestones } from "./shared.js";

const categories = [
  category(
    "reveal",
    "Product reveal",
    ["Simple unveil", "Staged reveal moment"],
    [
      driver("reveal-production", "Reveal production", "fixed", 7000),
      driver("rehearsal-hours", "Rehearsal hours", "perUnit", 3000, { units: 8 }),
    ],
    1500,
  ),
  category(
    "food-beverage",
    "Food & beverage",
    ["Snacks and drinks", "Full sit-down menu"],
    [
      driver("catering", "Catering per guest", "perGuest", 8500),
      driver("service-setup", "Service setup", "fixed", 1500),
    ],
    2500,
  ),
  category(
    "av",
    "AV & production",
    ["Basic sound and screen", "Full production rig"],
    [
      capacityDriver("sound-screen-rig", "Sound and screen rig by audience size", 7000),
      driver("technician-hours", "Technician hours", "perUnit", 3000, { units: 12 }),
    ],
    1800,
  ),
  category(
    "decor",
    "Décor",
    ["Backdrop only", "Full stage wrap"],
    [
      driver("stage-set", "Stage and set", "fixed", 8000),
      driver("signage", "Branding and signage", "fixed", 2000),
    ],
    1200,
  ),
  category(
    "music",
    "Music & theme",
    ["Curated playlist", "Live performance"],
    [
      driver("performance-hours", "Performance hours", "perUnit", 7000, { units: 4 }),
      driver("licensing", "Sound check and licensing", "fixed", 3000),
    ],
    700,
  ),
  category(
    "pr",
    "PR & media",
    ["Press release", "Full media programme"],
    [
      driver("agency-retainer", "Agency retainer", "fixed", 7000),
      driver("press-kits", "Press kits", "perUnit", 3000, { units: 50 }),
    ],
    800,
  ),
  category(
    "photo-video",
    "Photo & video",
    ["Event photos", "Photo and launch film"],
    [
      driver("crew-hours", "Crew hours", "perUnit", 7000, { units: 10 }),
      driver("editing", "Editing and delivery", "fixed", 3000),
    ],
    700,
  ),
  category(
    "gifting",
    "Gifting",
    ["Token gift", "Branded gift kit"],
    [driver("guest-gift", "Gift per guest", "perGuest", 10000)],
    800,
  ),
];

const roles = [
  {
    id: "manager",
    name: "Event manager",
    kind: "manager",
    categoryIds: categories.map(({ id }) => id),
  },
  {
    id: "creative-director",
    name: "Creative director",
    kind: "core",
    categoryIds: ["reveal", "decor", "music", "gifting"],
  },
  {
    id: "production-lead",
    name: "Production lead",
    kind: "core",
    categoryIds: ["reveal", "av"],
  },
  {
    id: "fb-lead",
    name: "F&B lead",
    kind: "core",
    categoryIds: ["food-beverage"],
  },
  { id: "pr-head", name: "PR head", kind: "core", categoryIds: ["pr", "photo-video"] },
];

export const corporateLaunch = defineTemplate({
  eventType: "corporate_launch",
  label: "Corporate product launch",
  categories,
  roles,
  people: {
    manager: "Asha Menon",
    "creative-director": "Rohan Kapoor",
    "production-lead": "Meera Iyer",
    "pr-head": "Dev Sharma",
    "fb-lead": "Kabir Shah",
  },
  categoryGroups: [
    { slug: "food-beverage", name: "Food & beverage", categoryIds: ["food-beverage"] },
    { slug: "stage-decor", name: "Stage & décor", categoryIds: ["reveal", "decor"] },
    { slug: "music-av", name: "Music & AV", categoryIds: ["reveal", "av", "music"] },
    { slug: "pr-media", name: "PR & media", categoryIds: ["pr"] },
    { slug: "photo-video", name: "Photo & video", categoryIds: ["photo-video"] },
  ],
  milestones: scaledMilestones(100),
  intakeOptions: {
    purpose: [
      "Launch a new product",
      "Thank customers and partners",
      "Win press coverage",
      "Bring the team together",
    ],
    venueType: ["Hotel ballroom", "Convention centre", "Our office", "Outdoor venue", "Rooftop"],
    guests: ["50", "100", "200", "300", "500"],
    budget: ["₹5 lakh", "₹10 lakh", "₹25 lakh", "₹50 lakh", "₹1 crore"],
    attendeeExperience: [
      "Excited about the product",
      "Proud to be part of it",
      "Clear on what is new",
      "Keen to talk about it",
    ],
    mustHaves: [
      { text: "A big reveal moment", categoryId: "reveal" },
      { text: "A live product demo", categoryId: "av" },
      { text: "A branded stage", categoryId: "decor" },
      { text: "A press corner", categoryId: "pr" },
      { text: "A launch film", categoryId: "photo-video" },
      { text: "Branded gifts", categoryId: "gifting" },
    ],
    constraints: [
      "Vegetarian options",
      "Wheelchair access",
      "Strict brand guidelines",
      "Fixed venue timings",
      "Embargo until the reveal",
    ],
  },
});
