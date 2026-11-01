import { categoryCost, computeBudget } from "./budgetEngine.js";
import { expenseSummary } from "./expenses.js";
import { wholeMoney } from "./money.js";

const DAY_MS = 86400000;
const longDate = (iso) =>
  new Date(iso).toLocaleDateString("en-GB", { dateStyle: "long", timeZone: "UTC" });
const SOON_DAYS = 14;
const LOW_BUFFER_DIVISOR = 4;
const TOP_PRIORITIES = 3;

const signal = (id, severity, action, fact) => ({ id, severity, action, fact });
const nameOf = (state, id) => state.categories.find((category) => category.id === id)?.name ?? id;

function overBudget(budget, money) {
  return budget.remainingMinor < 0
    ? [signal("over-budget", 3, "ask", `The plan is ${money(-budget.remainingMinor)} over budget.`)]
    : [];
}

function overspending(state, expenses, money) {
  return expenseSummary(state, expenses)
    .categories.filter(({ overMinor }) => overMinor > 0)
    .map(({ id, name, spentMinor, overMinor }) =>
      signal(
        `overspent-${id}`,
        3,
        "budget",
        `${name} has spent ${money(spentMinor)}, which is ${money(overMinor)} over its plan.`,
      ),
    );
}

function mustHavesAtRisk(profile, state) {
  return (profile.mustHaves ?? []).flatMap(({ text, categoryId, minTierId }) => {
    const category = state.categories.find(({ id }) => id === categoryId);
    const tier = category?.tiers.find(({ id }) => id === minTierId);
    return tier && categoryCost(category, state.guestCount).committedMinor < tier.minMinor
      ? [
          signal(
            `must-have-${categoryId}`,
            3,
            "ask",
            `${category.name} is below the "${tier.label}" level your must-have "${text}" needs.`,
          ),
        ]
      : [];
  });
}

function taskSignals(tasks, nowIso) {
  const open = tasks.filter(({ status }) => status !== "done");
  const late = open.filter(({ atRisk }) => atRisk);
  const soonest = open.find(({ atRisk, dueDate }) => {
    const days = (Date.parse(dueDate) - Date.parse(nowIso)) / DAY_MS;
    return !atRisk && days <= SOON_DAYS;
  });
  const titles = late
    .slice(0, 3)
    .map(({ title }) => title)
    .join(", ");
  return [
    ...(late.length
      ? [
          signal(
            "tasks-late",
            3,
            "timeline",
            `${late.length} ${late.length === 1 ? "task is" : "tasks are"} at risk: ${titles}.`,
          ),
        ]
      : []),
    ...(soonest
      ? [
          signal(
            "task-soon",
            2,
            "timeline",
            `"${soonest.title}" is due by ${longDate(soonest.dueDate)}.`,
          ),
        ]
      : []),
  ];
}

function quoteSignals(profile, state, quotes) {
  const unchecked = quotes.filter(({ status }) => status === "extracted").length;
  const ofCategory = (id, status) =>
    quotes.filter((quote) => quote.categoryId === id && quote.status === status);
  const waiting = state.categories.flatMap(({ id }) => {
    const count = ofCategory(id, "confirmed").length;
    return count >= 2 && ofCategory(id, "accepted").length === 0
      ? [
          signal(
            `quotes-waiting-${id}`,
            2,
            "vendors",
            `${nameOf(state, id)} has ${count} quotes to compare, and none accepted.`,
          ),
        ]
      : [];
  });
  const unquoted = (profile.priorities ?? [])
    .slice(0, TOP_PRIORITIES)
    .find((id) => quotes.every((quote) => quote.categoryId !== id));
  return [
    ...(unchecked
      ? [
          signal(
            "quotes-unchecked",
            2,
            "vendors",
            `${unchecked} ${unchecked === 1 ? "quote needs" : "quotes need"} checking before ${unchecked === 1 ? "it counts" : "they count"}.`,
          ),
        ]
      : []),
    ...waiting,
    ...(unquoted
      ? [
          signal(
            `no-quotes-${unquoted}`,
            2,
            "vendors",
            `${nameOf(state, unquoted)}, priority ${profile.priorities.indexOf(unquoted) + 1}, has no vendor quotes yet.`,
          ),
        ]
      : []),
  ];
}

function bufferSignals({ reservedMinor, availableMinor }, money) {
  if (reservedMinor === 0)
    return [
      signal("no-buffer", 1, "budget", "There is no contingency buffer for sudden expenses."),
    ];
  return availableMinor * LOW_BUFFER_DIVISOR < reservedMinor
    ? [
        signal(
          "buffer-low",
          2,
          "budget",
          `Only ${money(availableMinor)} is left of the ${money(reservedMinor)} contingency buffer.`,
        ),
      ]
    : [];
}

/**
 * Finds what needs the manager's attention, in code, so advice can only ever rest on real figures.
 * Each signal has a fixed id, a severity from 1 to 3, the page that deals with it and one exact
 * fact. Most urgent first.
 * @param {{profile: object, state: object, expenses?: object[], tasks?: object[], quotes?: object[],
 *   nowIso: string}} input The event as it stands now.
 * @returns {Array<{id: string, severity: number, action: string, fact: string}>} The signals.
 */
export function planningSignals({
  profile,
  state,
  expenses = [],
  tasks = [],
  quotes = [],
  nowIso,
}) {
  const money = (minor) => wholeMoney(minor, state.currency);
  const budget = computeBudget(state);
  return [
    ...overBudget(budget, money),
    ...overspending(state, expenses, money),
    ...mustHavesAtRisk(profile, state),
    ...taskSignals(tasks, nowIso),
    ...quoteSignals(profile, state, quotes),
    ...bufferSignals(budget.contingency, money),
  ].sort((a, b) => b.severity - a.severity);
}
