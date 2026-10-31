import { computeBudget } from "../core/budgetEngine.js";
import { expenseSummary } from "../core/expenses.js";
import { wholeMoney } from "../core/money.js";
import { rankOf } from "../core/priorities.js";
import {
  agentPrompt,
  generate as realGenerate,
  generateOrDemo,
  wrapUntrusted,
} from "../llm/index.js";
import { groundedOr } from "./grounded.js";
import { insightOutput } from "./schemas.js";

// Dividing a budget per guest leaves a little over; that isn't money anyone can plan with.
const PETTY_MINOR = 100000;

const SYSTEM = agentPrompt({
  role:
    "You are the Budget analyst of Huddle. Code has already worked out what a change does to an " +
    "event's budget. You explain what those figures mean for this particular event, so the " +
    "organiser can make an informed choice. A good event fits the organiser; it is not the most " +
    "expensive one.",
  steps: [
    "read the event's purpose, what guests should feel and the must-haves",
    "read the exact figures",
    "work out what each option would mean for guests at this event",
    "write the output",
  ],
  rules: [
    "headline: one short sentence stating the main effect of the change.",
    "insight: two or three sentences on what is driving the change and what is really at stake " +
      "for this event, tied to its purpose or guest experience.",
    "optionNotes: for each option, one sentence on what guests would actually notice if the cut " +
      "came from that category. Make each one specific to that category; never repeat a sentence " +
      "pattern across options.",
    "Use only figures that appear in the facts. Never calculate or invent a number.",
    "Stay neutral: never recommend an option, rank options or pressure. The user decides.",
  ],
});

/**
 * Lists the budget as plain facts with exact figures from code. The model answers from this, and
 * anything it says is checked against it.
 * @param {object} state BudgetState.
 * @param {object} profile EventProfile.
 * @param {object[]} [expenses] Money actually spent.
 * @returns {string[]} One fact per line.
 */
export function budgetFacts(state, profile, expenses = []) {
  const budget = computeBudget(state);
  const spending = expenseSummary(state, expenses);
  const money = (minor) => wholeMoney(minor, state.currency);
  const perGuest = state.guestCount ? Math.round(budget.committedMinor / state.guestCount) : 0;
  const position =
    budget.remainingMinor < 0
      ? `Over budget by ${money(-budget.remainingMinor)}`
      : budget.remainingMinor < PETTY_MINOR
        ? "Fully allocated"
        : `Not yet committed: ${money(budget.remainingMinor)}`;
  const lines = [
    `Guests: ${state.guestCount}`,
    `Total budget: ${money(budget.totalMinor)}`,
    `Committed so far: ${money(budget.committedMinor)}`,
    position,
    `Committed cost per guest: ${money(perGuest)}`,
    `Contingency buffer: ${money(budget.contingency.reservedMinor)} set aside, ${money(budget.contingency.spentMinor)} already paid from it, ${money(budget.contingency.availableMinor)} left`,
    `Spent so far: ${money(spending.spentMinor)}`,
  ];
  for (const category of budget.categories) {
    const { drivers } = state.categories.find(({ id }) => id === category.id);
    const rank = rankOf(profile.priorities, category.id);
    const items = drivers.map(({ id, label }) => `${label} [${id}]`).join(", ");
    const range =
      category.lowMinor === category.highMinor
        ? ""
        : ` (estimated range ${money(category.lowMinor)} to ${money(category.highMinor)})`;
    const { spentMinor } = spending.categories.find(({ id }) => id === category.id);
    lines.push(
      `${category.name} [${category.id}]: ${money(category.committedMinor)}${range}, ` +
        `${money(spentMinor)} spent, ${rank ? `priority #${rank}` : "not ranked"}, items: ${items}`,
    );
  }
  return lines;
}

function keyPoints({ state, after, consequences, nameOf, money, events }) {
  const before = computeBudget(state);
  const now = computeBudget(after);
  const points = [];
  const unpriced = events.filter(({ type, price }) => type === "line_item_swap" && !price);
  for (const { add } of unpriced)
    points.push(`${add} has no price yet, so these figures leave its cost out.`);
  if (after.guestCount !== state.guestCount)
    points.push(`Guests go from ${state.guestCount} to ${after.guestCount}.`);
  if (state.guestCount && after.guestCount) {
    const was = money(Math.round(before.committedMinor / state.guestCount));
    const will = money(Math.round(now.committedMinor / after.guestCount));
    if (was !== will) points.push(`Cost per guest goes from ${was} to ${will}.`);
  }
  if (after.totalMinor !== state.totalMinor)
    points.push(`Total budget goes from ${money(state.totalMinor)} to ${money(after.totalMinor)}.`);
  const clean = consequences.options.filter(({ atHigh, atLow }) => {
    const cut = atHigh ?? atLow;
    return cut.coversShortfall && !cut.removedEntirely && cut.mustHaveConflicts.length === 0;
  });
  if (consequences.shortfall.highMinor > 0) {
    points.push(
      clean.length
        ? `Can cover the gap alone without touching a must-have: ${clean.map(({ categoryId }) => nameOf(categoryId)).join(", ")}.`
        : "No single category can cover the gap without touching a must-have or being removed.",
    );
  }
  return points;
}

/**
 * Explains a change: key points from code, plus the model's reading of what it means for this
 * event. Wording that cites a figure nobody supplied is dropped.
 * @param {{state: object, after: object, events?: object[], consequences: object, consequenceText: string,
 *   profile: object, template: object, text: string, offline: boolean}} input The change, and
 *   whether to skip the model because it just failed.
 * @param {{generate?: Function}} [deps] The model call, replaceable in tests.
 * @returns {Promise<{headline: string, insight: string, points: string[],
 *   optionNotes: Record<string, string>, offline: boolean}>} The explanation.
 */
export async function explainChange(input, { generate = realGenerate } = {}) {
  const { state, after, consequences, consequenceText, profile, template, text } = input;
  const money = (minor) => wholeMoney(minor, state.currency);
  const nameOf = (id) => template.categories.find((item) => item.id === id)?.name ?? id;
  const points = keyPoints({
    state,
    after,
    consequences,
    nameOf,
    money,
    events: input.events ?? [],
  });
  const gap = consequences.shortfall.highMinor;
  const plainHeadline = gap
    ? `This puts you ${money(gap)} over budget.`
    : `You stay within budget, with ${money(consequences.surplusMinor)} to spare.`;
  const plain = { headline: plainHeadline, insight: "", points, optionNotes: {} };
  if (input.offline) return { ...plain, offline: true };

  const facts = [...points, consequenceText, ...budgetFacts(after, profile)].join("\n");
  const content = [
    wrapUntrusted(
      "event",
      JSON.stringify({
        purpose: profile.purpose,
        guestsShouldFeel: profile.attendeeExperience,
        mustHaves: profile.mustHaves.map((item) => item.text),
        constraints: profile.constraints,
      }),
    ),
    wrapUntrusted("user request", text),
    wrapUntrusted("facts", facts, 8000),
  ].join("\n");
  const { data, offline } = await generateOrDemo(generate, {
    agent: "budget",
    system: SYSTEM,
    messages: [{ role: "user", content }],
    schema: insightOutput,
    demo: async () => ({ headline: plainHeadline, insight: "", optionNotes: [], rationale: "" }),
  });
  const allowed = `${facts} ${text} ${JSON.stringify(profile.mustHaves)}`;
  const optionNotes = {};
  for (const { categoryId, note } of data.optionNotes ?? []) {
    const safe = groundedOr(note, allowed);
    if (safe && consequences.options.some((option) => option.categoryId === categoryId))
      optionNotes[categoryId] = safe;
  }
  return {
    headline: groundedOr(data.headline, allowed, plainHeadline),
    insight: groundedOr(data.insight, allowed),
    points,
    optionNotes,
    offline,
  };
}
