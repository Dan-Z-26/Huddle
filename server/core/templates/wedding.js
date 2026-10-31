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
    2000,
  ),
  category(
    "catering",
    "Catering",
    ["Single-cuisine buffet", "Multi-cuisine spread"],
    [
      driver("catering-plate", "Catering per plate", "perGuest", 9000),
      driver("kitchen-setup", "Kitchen setup", "fixed", 1000),
    ],
    3800,
  ),
  category(
    "decor",
    "Décor",
    ["Mandap only", "Full venue styling"],
    [
      driver("mandap", "Mandap and stage", "fixed", 7000),
      driver("florals", "Flowers and lighting", "fixed", 3000),
    ],
    1500,
  ),
  category(
    "photo-video",
    "Photo & video",
    ["Photos only", "Photos and film"],
    [
      driver("shoot-days", "Shoot days", "perUnit", 8000, { units: 2 }),
      driver("album", "Album and editing", "fixed", 2000),
    ],
    1000,
  ),
  category(
    "music",
    "Music",
    ["DJ set", "Live band"],
    [
      driver("music-hours", "Performance hours", "perUnit", 8000, { units: 5 }),
      driver("sound", "Sound system", "fixed", 2000),
    ],
    700,
  ),
  category(
    "attire",
    "Attire",
    ["Ready to wear", "Custom outfits"],
    [
      driver("outfits", "Outfits", "perUnit", 8000, { units: 4 }),
      driver("alterations", "Alterations and styling", "fixed", 2000),
    ],
    700,
  ),
  category(
    "invitations",
    "Invitations",
    ["Digital invitations", "Printed invitation suite"],
    [
      driver("invites", "Invitation per guest", "perGuest", 8000),
      driver("invite-design", "Invitation design", "fixed", 2000),
    ],
    300,
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
    { slug: "food-beverage", name: "Food & beverage", categoryIds: ["catering"] },
    { slug: "decor-venue", name: "Décor & venue", categoryIds: ["decor", "venue"] },
    { slug: "photo-video", name: "Photo & video", categoryIds: ["photo-video"] },
    { slug: "music", name: "Music", categoryIds: ["music"] },
  ],
  milestones: scaledMilestones(200),
  intakeOptions: {
    purpose: [
      "Celebrate with family and friends",
      "An intimate ceremony",
      "A big traditional wedding",
      "A destination wedding",
    ],
    venueType: ["Banquet hall", "Hotel", "Lawn or garden", "Temple or place of worship", "At home"],
    guests: ["50", "100", "200", "300", "500"],
    budget: ["₹5 lakh", "₹10 lakh", "₹20 lakh", "₹35 lakh", "₹50 lakh"],
    attendeeExperience: [
      "Warmly welcomed",
      "Part of the family",
      "Well fed and happy",
      "Moved by the ceremony",
    ],
    mustHaves: [
      { text: "A traditional ceremony", categoryId: "venue" },
      { text: "A sit-down dinner", categoryId: "catering" },
      { text: "A floral mandap or stage", categoryId: "decor" },
      { text: "A wedding film", categoryId: "photo-video" },
      { text: "Live music", categoryId: "music" },
      { text: "Printed invitations", categoryId: "invitations" },
    ],
    constraints: [
      "Vegetarian menu",
      "Jain food",
      "Wheelchair access",
      "Rooms for out-of-town family",
      "Fixed muhurat time",
    ],
  },
});
