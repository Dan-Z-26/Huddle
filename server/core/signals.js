/** Finds what needs the manager's attention, so advice rests only on real figures. */
import { categoryCost, computeBudget } from "./budgetEngine.js";
import { expenseSummary } from "./expenses.js";
import { wholeMoney } from "./money.js";
import { DAY_MS, longDate } from "./time.js";

const SOON_DAYS = 14;
const LOW_BUFFER_DIVISOR = 4;
const TOP_PRIORITIES = 3;
const LATE_TITLES_SHOWN = 3;

// How much a signal matters. Advice takes the highest first.
const URGENT = 3;
const IMPORTANT = 2;
const WORTH_NOTING = 1;

const signal = (id, severity, action, fact) => ({ id, severity, action, fact });
const nameOf = (state, id) => state.categories.find((category) => category.id === id)?.name ?? id;

function overBudget(budget, money) {
  return budget.remainingMinor < 0
    ? [
        signal(
          "over-budget",
          URGENT,
          "ask",
          `The plan is ${money(-budget.remainingMinor)} over budget.`,
        ),
      ]
    : [];
}

function overspending(state, expenses, money) {
  return expenseSummary(state, expenses)
    .categories.filter(({ overMinor }) => overMinor > 0)
    .map(({ id, name, spentMinor, overMinor }) =>
      signal(
        `overspent-${id}`,
        URGENT,
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
            URGENT,
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
  const signals = [];
  if (late.length) {
    const titles = late
      .slice(0, LATE_TITLES_SHOWN)
      .map(({ title }) => title)
      .join(", ");
    const count = `${late.length} ${late.length === 1 ? "task is" : "tasks are"}`;
    signals.push(signal("tasks-late", URGENT, "timeline", `${count} at risk: ${titles}.`));
  }
  if (soonest) {
    const fact = `"${soonest.title}" is due by ${longDate(soonest.dueDate)}.`;
    signals.push(signal("task-soon", IMPORTANT, "timeline", fact));
  }
  return signals;
}

function quoteSignals(profile, state, quotes) {
  const ofCategory = (id, status) =>
    quotes.filter((quote) => quote.categoryId === id && quote.status === status);
  const signals = [];
  const unchecked = quotes.filter(({ status }) => status === "extracted").length;
  if (unchecked) {
    const needs = unchecked === 1 ? "quote needs checking before it counts" : "quotes need checking before they count";
    signals.push(signal("quotes-unchecked", IMPORTANT, "vendors", `${unchecked} ${needs}.`));
  }
  for (const { id } of state.categories) {
    const count = ofCategory(id, "confirmed").length;
    if (count >= 2 && ofCategory(id, "accepted").length === 0) {
      const fact = `${nameOf(state, id)} has ${count} quotes to compare, and none accepted.`;
      signals.push(signal(`quotes-waiting-${id}`, IMPORTANT, "vendors", fact));
    }
  }
  const unquoted = (profile.priorities ?? [])
    .slice(0, TOP_PRIORITIES)
    .find((id) => quotes.every((quote) => quote.categoryId !== id));
  if (unquoted) {
    const rank = profile.priorities.indexOf(unquoted) + 1;
    const fact = `${nameOf(state, unquoted)}, priority ${rank}, has no vendor quotes yet.`;
    signals.push(signal(`no-quotes-${unquoted}`, IMPORTANT, "vendors", fact));
  }
  return signals;
}

function bufferSignals({ reservedMinor, availableMinor }, money) {
  if (reservedMinor === 0)
    return [
      signal(
        "no-buffer",
        WORTH_NOTING,
        "budget",
        "There is no contingency buffer for sudden expenses.",
      ),
    ];
  return availableMinor * LOW_BUFFER_DIVISOR < reservedMinor
    ? [
        signal(
          "buffer-low",
          IMPORTANT,
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
