// How each intake field is presented. The questions themselves come from the server.
export const FIELD_META = {
  name: {
    title: "Event name",
    hint: "A working title is fine; you can change it later.",
  },
  purpose: {
    title: "Purpose",
    long: true,
    hint: "Tell me who it is for, in your own words.",
  },
  date: {
    title: "Date",
    hint: "Include the year, for example 12 March 2027.",
    placeholder: "12 March 2027",
  },
  city: { title: "City", placeholder: "Pune" },
  venueType: {
    title: "Venue",
    hint: "A hotel ballroom, an outdoor lawn, an office or a community hall.",
    placeholder: "Hotel ballroom",
  },
  guests: {
    title: "Guests",
    hint: "A range is fine. I'll confirm one number to plan for.",
    placeholder: "Around 200",
  },
  budget: { title: "Budget", hint: "Write it the way you say it.", placeholder: "16 lakh" },
  priorities: {
    title: "Priorities",
    hint: "Choose the categories in order, most important first. Your ranking decides the budget split.",
    picker: true,
  },
  attendeeExperience: {
    title: "Guest experience",
    long: true,
    placeholder: "Welcomed, and part of something special",
  },
  mustHaves: {
    title: "Must-haves",
    long: true,
    skippable: true,
    placeholder: "Live music, a vegetarian menu",
  },
  absoluteMustHave: {
    title: "The one must-have",
    chipsFromMustHaves: true,
    placeholder: "Or type it",
  },
  constraints: {
    title: "Constraints",
    long: true,
    skippable: true,
    placeholder: "Wheelchair access, finish by 10 pm",
  },
  vendorNeeds: {
    title: "Vendor needs",
    long: true,
    skippable: true,
    placeholder: "A vegetarian menu from the caterer",
  },
};

export const FIELD_ORDER = Object.keys(FIELD_META);
