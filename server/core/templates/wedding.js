import { capacityDriver, category, defineTemplate, driver, scaledMilestones } from "./shared.js";

const categories = [
  category(
    "venue",
    "Venue",
    ["Community hall", "Full-service venue"],
    [
      capacityDriver("venue-hire", "Venue hire by capacity", 8500),
      driver("venue-staff", "Venue staff and cleaning", "fixed", 1500),
    ],
  ),
  category(
    "catering",
    "Catering",
    ["Single-cuisine buffet", "Multi-cuisine spread"],
    [
      driver("catering-plate", "Catering per plate", "perGuest", 9000),
      driver("kitchen-setup", "Kitchen setup", "fixed", 1000),
    ],
  ),
  category(
    "decor",
    "Décor",
    ["Mandap only", "Full venue styling"],
    [
      driver("mandap", "Mandap and stage", "fixed", 7000),
      driver("florals", "Flowers and lighting", "fixed", 3000),
    ],
  ),
  category(
    "photo-video",
    "Photo & video",
    ["Photos only", "Photos and film"],
    [
      driver("shoot-days", "Shoot days", "perUnit", 8000, { units: 2 }),
      driver("album", "Album and editing", "fixed", 2000),
    ],
  ),
  category(
    "music",
    "Music",
    ["DJ set", "Live band"],
    [
      driver("music-hours", "Performance hours", "perUnit", 8000, { units: 5 }),
      driver("sound", "Sound system", "fixed", 2000),
    ],
  ),
  category(
    "attire",
    "Attire",
    ["Ready to wear", "Custom outfits"],
    [
      driver("outfits", "Outfits", "perUnit", 8000, { units: 4 }),
      driver("alterations", "Alterations and styling", "fixed", 2000),
    ],
  ),
  category(
    "invitations",
    "Invitations",
    ["Digital invitations", "Printed invitation suite"],
    [
      driver("invites", "Invitation per guest", "perGuest", 8000),
      driver("invite-design", "Invitation design", "fixed", 2000),
    ],
  ),
];

const roles = [
  {
    id: "manager",
    name: "Wedding planner",
    kind: "manager",
    categoryIds: categories.map(({ id }) => id),
  },
  {
    id: "couple",
    name: "Couple",
    kind: "core",
    categoryIds: ["venue", "decor", "photo-video", "music", "attire", "invitations"],
  },
  {
    id: "family-helper",
    name: "Family helper",
    kind: "core",
    categoryIds: ["catering", "invitations"],
  },
];

export const wedding = defineTemplate({
  eventType: "wedding",
  label: "Wedding",
  categories,
  roles,
  people: {
    manager: "Priya Nair",
    couple: "Ananya and Karan",
    "family-helper": "Sunita Verma",
  },
  categoryGroups: [
    { slug: "food-beverage", categoryIds: ["catering"] },
    { slug: "decor-venue", categoryIds: ["decor", "venue"] },
    { slug: "photo-video", categoryIds: ["photo-video"] },
    { slug: "music", categoryIds: ["music"] },
  ],
  milestones: scaledMilestones(200),
});
