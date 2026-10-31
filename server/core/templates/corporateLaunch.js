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
  ),
  category(
    "food-beverage",
    "Food & beverage",
    ["Snacks and drinks", "Full sit-down menu"],
    [
      driver("catering", "Catering per guest", "perGuest", 8500),
      driver("service-setup", "Service setup", "fixed", 1500),
    ],
  ),
  category(
    "av",
    "AV & production",
    ["Basic sound and screen", "Full production rig"],
    [
      capacityDriver("sound-screen-rig", "Sound and screen rig by audience size", 7000),
      driver("technician-hours", "Technician hours", "perUnit", 3000, { units: 12 }),
    ],
  ),
  category(
    "decor",
    "Décor",
    ["Backdrop only", "Full stage wrap"],
    [
      driver("stage-set", "Stage and set", "fixed", 8000),
      driver("signage", "Branding and signage", "fixed", 2000),
    ],
  ),
  category(
    "music",
    "Music & theme",
    ["Curated playlist", "Live performance"],
    [
      driver("performance-hours", "Performance hours", "perUnit", 7000, { units: 4 }),
      driver("licensing", "Sound check and licensing", "fixed", 3000),
    ],
  ),
  category(
    "pr",
    "PR & media",
    ["Press release", "Full media programme"],
    [
      driver("agency-retainer", "Agency retainer", "fixed", 7000),
      driver("press-kits", "Press kits", "perUnit", 3000, { units: 50 }),
    ],
  ),
  category(
    "photo-video",
    "Photo & video",
    ["Event photos", "Photo and launch film"],
    [
      driver("crew-hours", "Crew hours", "perUnit", 7000, { units: 10 }),
      driver("editing", "Editing and delivery", "fixed", 3000),
    ],
  ),
  category(
    "gifting",
    "Gifting",
    ["Token gift", "Branded gift kit"],
    [driver("guest-gift", "Gift per guest", "perGuest", 10000)],
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
    categoryIds: ["reveal", "av", "food-beverage"],
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
  },
  categoryGroups: [
    { slug: "food-beverage", categoryIds: ["food-beverage"] },
    { slug: "stage-decor", categoryIds: ["reveal", "decor"] },
    { slug: "music-av", categoryIds: ["reveal", "av", "music"] },
    { slug: "pr-media", categoryIds: ["pr"] },
    { slug: "photo-video", categoryIds: ["photo-video"] },
  ],
  milestones: scaledMilestones(100),
});
