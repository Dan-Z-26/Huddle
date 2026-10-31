// How each setup field is answered. The questions and buttons themselves come from the server.
// kind: "text" types, "choice" taps one, "multi" taps several, "date" uses the calendar, "rank"
// taps in order. `typed` says what the text box is for when buttons also exist.
export const FIELD_META = {
  name: {
    title: "Event name",
    kind: "choice",
    typed: "Or type your own",
    hint: "A working title is fine.",
  },
  purpose: {
    title: "Purpose",
    kind: "choice",
    typed: "Or tell me in your own words",
    long: true,
  },
  date: { title: "Date", kind: "date" },
  city: { title: "City", kind: "choice", typed: "Which city?" },
  venueType: { title: "Venue", kind: "choice", typed: "What kind of venue?" },
  guests: {
    title: "Guests",
    kind: "choice",
    typed: "A number or a range, like 200 to 250",
    hint: "A rough number is fine. You can change it later.",
  },
  budget: {
    title: "Budget",
    kind: "choice",
    typed: "Your total, like 16 lakh",
    hint: "Amounts are in rupees unless you say otherwise.",
  },
  priorities: {
    title: "Priorities",
    kind: "rank",
    hint: "Tap them in order, most important first. Your order shapes the budget split. Anything you leave out gets a smaller share.",
  },
  attendeeExperience: {
    title: "Guest experience",
    kind: "choice",
    typed: "Or say it your way",
    long: true,
  },
  mustHaves: {
    title: "Must-haves",
    kind: "multi",
    skippable: true,
    typed: "Add your own, separated by commas",
    hint: "Tap all that apply.",
  },
  absoluteMustHave: { title: "The one must-have", kind: "choice", skippable: true },
  constraints: {
    title: "Constraints",
    kind: "multi",
    skippable: true,
    typed: "Add your own, separated by commas",
    hint: "Tap all that apply.",
  },
  vendorNeeds: {
    title: "Vendor needs",
    kind: "text",
    long: true,
    skippable: true,
    hint: "You can also decide this when you speak to them.",
  },
};

export const FIELD_ORDER = Object.keys(FIELD_META);
