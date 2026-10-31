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
    2500,
  ),
  category(
    "food-cake",
    "Food & cake",
    ["Snacks and cake", "Full meal and custom cake"],
    [
      driver("food-plate", "Food per guest", "perGuest", 7500),
      driver("cake", "Cake", "fixed", 2500),
    ],
    4000,
  ),
  category(
    "decor",
    "Décor",
    ["Balloons and banner", "Themed styling"],
    [driver("theme-decor", "Theme décor", "fixed", 10000)],
    1200,
  ),
  category(
    "photo-video",
    "Photo & video",
    ["A few hours of photos", "Photos and highlight video"],
    [
      driver("photo-hours", "Photographer hours", "perUnit", 8000, { units: 3 }),
      driver("photo-editing", "Editing", "fixed", 2000),
    ],
    800,
  ),
  category(
    "entertainment",
    "Entertainment",
    ["Games and playlist", "Booked entertainer"],
    [
      driver("entertainer-hours", "Entertainer hours", "perUnit", 8000, { units: 2 }),
      driver("props", "Props and sound", "fixed", 2000),
    ],
    1000,
  ),
  category(
    "return-gifts",
    "Return gifts",
    ["Small treat", "Personalised gift"],
    [driver("gift", "Gift per guest", "perGuest", 10000)],
    500,
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
    { slug: "food-cake", name: "Food & cake", categoryIds: ["food-cake"] },
    { slug: "decor", name: "Décor", categoryIds: ["decor"] },
    { slug: "photo-video", name: "Photo & video", categoryIds: ["photo-video"] },
    { slug: "entertainment", name: "Entertainment", categoryIds: ["entertainment"] },
  ],
  milestones: scaledMilestones(34),
  intakeOptions: {
    purpose: ["A milestone birthday", "A surprise party", "A kids' party", "A quiet family dinner"],
    venueType: ["At home", "Restaurant", "Banquet hall", "Garden or park", "Play area"],
    guests: ["15", "30", "50", "100", "150"],
    budget: ["₹25,000", "₹50,000", "₹1 lakh", "₹2 lakh", "₹5 lakh"],
    attendeeExperience: [
      "Happy and relaxed",
      "Full of good memories",
      "Surprised and delighted",
      "Close to the birthday person",
    ],
    mustHaves: [
      { text: "A special cake", categoryId: "food-cake" },
      { text: "Themed decorations", categoryId: "decor" },
      { text: "A photographer", categoryId: "photo-video" },
      { text: "Games or a performer", categoryId: "entertainment" },
      { text: "Return gifts", categoryId: "return-gifts" },
    ],
    constraints: [
      "Vegetarian food",
      "Eggless cake",
      "Nut allergies",
      "Safe for small children",
      "Finish by bedtime",
    ],
  },
});
