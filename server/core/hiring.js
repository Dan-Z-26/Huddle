const DAY_MS = 86400000;

export const PIPELINE = [
  ["needed", "Needed"],
  ["brief-approved", "Brief approved"],
  ["quotes-received", "Quotes received"],
  ["shortlisted", "Shortlisted"],
  ["booked", "Booked"],
  ["confirmed", "Confirmed"],
  ["delivered", "Delivered"],
];

// After booking, these are timeline tasks: one place to tick them, and overdue ones get reminders.
const BOOKED_STEPS = [
  ["contract", "Sign the contract", (name) => `Sign the contract with ${name}`, 30],
  ["deposit", "Pay the deposit", (name) => `Pay the deposit to ${name}`, 21],
  ["deliverables", "Collect deliverables", (name) => `Collect deliverables from ${name}`, 14],
  ["headcount", "Final headcount", (name) => `Give ${name} the final headcount`, 7],
  ["arrival", "Arrival time", (name) => `Confirm ${name}'s arrival time`, 2],
];
const CHECKLIST_BOOKED = BOOKED_STEPS.filter(([key]) => key !== "deliverables");

const usable = ({ status }) => status === "confirmed" || status === "accepted";
const taskId = (eventId, categoryId, key) => `${eventId}-task-hire-${categoryId}-${key}`;

function dueBefore(eventDateIso, daysBefore, nowIso) {
  const due = Date.parse(eventDateIso) - daysBefore * DAY_MS;
  const today = Date.parse(nowIso.slice(0, 10));
  return new Date(Math.max(due, today)).toISOString();
}

function hireTask({ eventId, categoryId, groupId, eventDateIso, nowIso }, key, title, daysBefore) {
  return {
    id: taskId(eventId, categoryId, key),
    eventId,
    title,
    ownerGroupId: groupId,
    ownerUserId: null,
    dueDate: dueBefore(eventDateIso, daysBefore, nowIso),
    status: "todo",
    atRisk: false,
    source: "vendor",
    daysBefore,
  };
}

/**
 * The task created when a brief is approved: seeing the shortlisted vendors in person.
 * @param {{eventId: string, categoryId: string, groupId: string, eventDateIso: string,
 *   nowIso: string}} context Where it belongs.
 * @param {string} categoryName The category's name.
 * @returns {object} The task.
 */
export const siteVisitTask = (context, categoryName) =>
  hireTask(context, "visit", `Visit the shortlisted ${categoryName} vendors`, 45);

/**
 * The timeline tasks that start when a vendor is booked.
 * @param {{eventId: string, categoryId: string, groupId: string, eventDateIso: string,
 *   nowIso: string}} context Where they belong.
 * @param {string} vendorName The vendor.
 * @returns {object[]} The tasks.
 */
export const bookedTasks = (context, vendorName) =>
  BOOKED_STEPS.map(([key, , title, days]) => hireTask(context, key, title(vendorName), days));

/**
 * The categories with confirmed quotes the manager hasn't decided on yet. A category drops off once
 * one of its quotes is accepted.
 * @param {object[]} quotes The event's quotes.
 * @returns {Array<{categoryId: string, count: number}>} How many are waiting, per category.
 */
export function quotesToReview(quotes) {
  const decided = new Set(
    quotes.filter(({ status }) => status === "accepted").map(({ categoryId }) => categoryId),
  );
  const counts = new Map();
  for (const { categoryId, status } of quotes)
    if (status === "confirmed" && !decided.has(categoryId))
      counts.set(categoryId, (counts.get(categoryId) ?? 0) + 1);
  return [...counts].map(([categoryId, count]) => ({ categoryId, count }));
}

/**
 * Where a category's hiring stands, worked out from what has actually happened.
 * @param {{brief?: object, quotes?: object[], tasks?: object[], deliverables?: object[]}} state The
 *   category's brief, quotes, tasks and the booked vendor's deliverables.
 * @returns {string} A stage id from PIPELINE.
 */
export function pipelineStage({ brief, quotes = [], tasks = [], deliverables = [] }) {
  if (quotes.some(({ status }) => status === "accepted")) {
    if (deliverables.length && deliverables.every(({ done }) => done)) return "delivered";
    const contract = tasks.find(({ id }) => id.endsWith("-contract"));
    return contract?.status === "done" ? "confirmed" : "booked";
  }
  const count = quotes.filter(usable).length;
  if (count >= 2) return "shortlisted";
  if (count === 1) return "quotes-received";
  return brief?.status === "approved" ? "brief-approved" : "needed";
}

/**
 * The manager's checklist for a category. The first steps tick themselves from what has happened;
 * the rest are timeline tasks, ticked in one place.
 * @param {{brief?: object, quotes?: object[], tasks?: object[]}} state The category's state.
 * @returns {Array<{key: string, label: string, done: boolean, taskId: string | null}>} The steps.
 */
export function managerChecklist({ brief, quotes = [], tasks = [] }) {
  const taskStep = (key, label) => {
    const task = tasks.find(({ id }) => id.endsWith(`-${key}`));
    return { key, label, done: task?.status === "done", taskId: task?.id ?? null };
  };
  const auto = (key, label, done) => ({ key, label, done, taskId: null });
  return [
    auto("brief", "Brief sent", brief?.status === "pending" || brief?.status === "approved"),
    auto("quotes", "Quotes received", quotes.some(usable)),
    auto("shortlist", "Shortlist", quotes.filter(usable).length >= 2),
    taskStep("visit", "Site visit"),
    ...CHECKLIST_BOOKED.map(([key, label]) => taskStep(key, label)),
  ];
}

/**
 * What to watch out for in a quote: hidden costs and missing information, from its own figures.
 * @param {object} quote The quote.
 * @param {{guestCount: number, totalMinor: number, planMinor: number,
 *   money: (minor: number) => string}} context The plan to compare with.
 * @returns {string[]} Plain warnings; empty when there is nothing to flag.
 */
export function quoteWarnings(quote, { guestCount, totalMinor, planMinor, money }) {
  const warnings = [];
  if (quote.taxStated === false)
    warnings.push("Taxes aren't stated, so the real cost could be higher.");
  if (quote.minGuests > guestCount) {
    const extra = quote.perGuestMinor * (quote.minGuests - guestCount);
    warnings.push(
      `Minimum ${quote.minGuests} guests: at ${guestCount} you would still pay ${money(extra)} more, before tax.`,
    );
  }
  if (quote.exclusions?.length) warnings.push(`Not included: ${quote.exclusions.join(", ")}.`);
  if (totalMinor > planMinor)
    warnings.push(`About ${money(totalMinor - planMinor)} over this category's plan.`);
  return warnings;
}

/**
 * Plain reasons behind a quote's score, so nobody has to trust a number.
 * @param {{totalMinor: number, mustHaveFit: number}} row A scored row.
 * @param {{cheapestMinor: number, mustHaveCount: number, taxStated?: boolean}} context The lowest
 *   total among the quotes, how many must-haves this category has, and whether this quote states tax.
 * @returns {string[]} The reasons.
 */
export function scoreReasons(
  { totalMinor, mustHaveFit },
  { cheapestMinor, mustHaveCount, taxStated },
) {
  const lowest = taxStated === false ? "Lowest total as stated, without tax." : "Lowest total.";
  return [
    totalMinor === cheapestMinor ? lowest : null,
    mustHaveCount
      ? `Meets ${mustHaveFit}% of your must-haves.`
      : "This category has no must-haves, so the score rests on cost.",
  ].filter(Boolean);
}
