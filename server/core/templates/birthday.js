import { capacityDriver, category, defineTemplate, driver, scaledMilestones } from "./shared.js";

const categories = [
  category(
    "venue",
    "Venue",
    ["Home or park", "Booked party space"],
    [
      capacityDriver("venue-hire", "Venue hire by capacity", 9000),
      driver("venue-cleanup", "Setup and cleanup", "fixed", 1000),
    ],
  ),
  category(
    "food-cake",
    "Food & cake",
    ["Snacks and cake", "Full meal and custom cake"],
    [
      driver("food-plate", "Food per guest", "perGuest", 7500),
      driver("cake", "Cake", "fixed", 2500),
    ],
  ),
  category(
    "decor",
    "Décor",
    ["Balloons and banner", "Themed styling"],
    [driver("theme-decor", "Theme décor", "fixed", 10000)],
  ),
  category(
    "photo-video",
    "Photo & video",
    ["A few hours of photos", "Photos and highlight video"],
    [
      driver("photo-hours", "Photographer hours", "perUnit", 8000, { units: 3 }),
      driver("photo-editing", "Editing", "fixed", 2000),
    ],
  ),
  category(
    "entertainment",
    "Entertainment",
    ["Games and playlist", "Booked entertainer"],
    [
      driver("entertainer-hours", "Entertainer hours", "perUnit", 8000, { units: 2 }),
      driver("props", "Props and sound", "fixed", 2000),
    ],
  ),
  category(
    "return-gifts",
    "Return gifts",
    ["Small treat", "Personalised gift"],
    [driver("gift", "Gift per guest", "perGuest", 10000)],
  ),
];

const roles = [
  { id: "manager", name: "Host", kind: "manager", categoryIds: categories.map(({ id }) => id) },
  {
    id: "helper",
    name: "Helper",
    kind: "core",
    categoryIds: ["food-cake", "decor", "return-gifts"],
  },
];

export const birthday = defineTemplate({
  eventType: "birthday",
  label: "Birthday",
  categories,
  roles,
  people: {
    manager: "Neha Joshi",
    helper: "Arjun Joshi",
  },
  categoryGroups: [
    { slug: "food-cake", categoryIds: ["food-cake"] },
    { slug: "decor", categoryIds: ["decor"] },
    { slug: "photo-video", categoryIds: ["photo-video"] },
    { slug: "entertainment", categoryIds: ["entertainment"] },
  ],
  milestones: scaledMilestones(34),
});
