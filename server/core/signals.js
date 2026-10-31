import { categoryCost, computeBudget } from "./budgetEngine.js";
import { expenseSummary } from "./expenses.js";
import { wholeMoney } from "./money.js";

const DAY_MS = 86400000;
const longDate = (iso) =>
  new Date(iso).toLocaleDateString("en-GB", { dateStyle: "long", timeZone: "UTC" });
const SOON_DAYS = 14;
const LOW_BUFFER_DIVISOR = 4;
const TOP_PRIORITIES = 3;

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
  const signals = [];
  const add = (id, severity, action, fact) => signals.push({ id, severity, action, fact });
  const nameOf = (id) => state.categories.find((category) => category.id === id)?.name ?? id;

  if (budget.remainingMinor < 0)
    add("over-budget", 3, "ask", `The plan is ${money(-budget.remainingMinor)} over budget.`);
  for (const row of expenseSummary(state, expenses).categories)
    if (row.overMinor > 0)
      add(
        `overspent-${row.id}`,
        3,
        "budget",
        `${row.name} has spent ${money(row.spentMinor)}, which is ${money(row.overMinor)} over its plan.`,
      );
  for (const { text, categoryId, minTierId } of profile.mustHaves ?? []) {
    const category = state.categories.find(({ id }) => id === categoryId);
    const tier = category?.tiers.find(({ id }) => id === minTierId);
    if (tier && categoryCost(category, state.guestCount).committedMinor < tier.minMinor)
      add(
        `must-have-${categoryId}`,
        3,
        "ask",
        `${category.name} is below the "${tier.label}" level your must-have "${text}" needs.`,
      );
  }

  const open = tasks.filter(({ status }) => status !== "done");
  const late = open.filter(({ atRisk }) => atRisk);
  if (late.length)
    add(
      "tasks-late",
      3,
      "timeline",
      `${late.length} ${late.length === 1 ? "task is" : "tasks are"} at risk: ${late
        .slice(0, 3)
        .map(({ title }) => title)
        .join(", ")}.`,
    );
  const soonest = open.find(({ atRisk, dueDate }) => {
    const days = (Date.parse(dueDate) - Date.parse(nowIso)) / DAY_MS;
    return !atRisk && days <= SOON_DAYS;
  });
  if (soonest)
    add("task-soon", 2, "timeline", `"${soonest.title}" is due by ${longDate(soonest.dueDate)}.`);

  const unchecked = quotes.filter(({ status }) => status === "extracted").length;
  if (unchecked)
    add(
      "quotes-unchecked",
      2,
      "vendors",
      `${unchecked} ${unchecked === 1 ? "quote needs" : "quotes need"} checking before ${unchecked === 1 ? "it counts" : "they count"}.`,
    );
  const ofCategory = (id, status) =>
    quotes.filter((quote) => quote.categoryId === id && quote.status === status);
  for (const { id } of state.categories) {
    const waiting = ofCategory(id, "confirmed").length;
    if (waiting >= 2 && ofCategory(id, "accepted").length === 0)
      add(
        `quotes-waiting-${id}`,
        2,
        "vendors",
        `${nameOf(id)} has ${waiting} quotes to compare, and none accepted.`,
      );
  }
  const unquoted = (profile.priorities ?? [])
    .slice(0, TOP_PRIORITIES)
    .find((id) => quotes.every((quote) => quote.categoryId !== id));
  if (unquoted)
    add(
      `no-quotes-${unquoted}`,
      2,
      "vendors",
      `${nameOf(unquoted)}, priority ${profile.priorities.indexOf(unquoted) + 1}, has no vendor quotes yet.`,
    );

  const { reservedMinor, availableMinor } = budget.contingency;
  if (reservedMinor === 0)
    add("no-buffer", 1, "budget", "There is no contingency buffer for sudden expenses.");
  else if (availableMinor * LOW_BUFFER_DIVISOR < reservedMinor)
    add(
      "buffer-low",
      2,
      "budget",
      `Only ${money(availableMinor)} is left of the ${money(reservedMinor)} contingency buffer.`,
    );
  return signals.sort((a, b) => b.severity - a.severity);
}
