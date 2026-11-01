/** Lists the budget as facts, and has the model explain what a change means for this event. */
import { computeBudget } from "../core/budgetEngine.js";
import { expenseSummary } from "../core/expenses.js";
import { wholeMoney } from "../core/money.js";
import { rankOf } from "../core/priorities.js";
import { categoryName } from "../core/templates.js";
import {
  agentPrompt,
  generate as realGenerate,
  generateOrDemo,
  wrapUntrusted,
} from "../llm/index.js";
import { insightOutput } from "./budgetSchemas.js";
import { groundedOr } from "./grounded.js";

// Dividing a budget per guest leaves a little over; that isn't money anyone can plan with.
const PETTY_MINOR = 100000;
const MAX_FACTS = 8000;

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

function positionLine(remainingMinor, money) {
  if (remainingMinor < 0) return `Over budget by ${money(-remainingMinor)}`;
  return remainingMinor < PETTY_MINOR
    ? "Fully allocated"
    : `Not yet committed: ${money(remainingMinor)}`;
}

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
  const position = positionLine(budget.remainingMinor, money);
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
    const priority = rank ? `priority #${rank}` : "not ranked";
    lines.push(
      `${category.name} [${category.id}]: ${money(category.committedMinor)}${range}, ` +
        `${money(spentMinor)} spent, ${priority}, items: ${items}`,
    );
  }
  return lines;
}

function perGuestPoint(state, after, money) {
  if (!state.guestCount || !after.guestCount) return [];
  const was = money(Math.round(computeBudget(state).committedMinor / state.guestCount));
  const will = money(Math.round(computeBudget(after).committedMinor / after.guestCount));
  return was === will ? [] : [`Cost per guest goes from ${was} to ${will}.`];
}

function gapPoint({ options, shortfall }, nameOf) {
  if (shortfall.highMinor === 0) return [];
  const clean = options.filter(({ atHigh, atLow }) => {
    const cut = atHigh ?? atLow;
    return cut.coversShortfall && !cut.removedEntirely && cut.mustHaveConflicts.length === 0;
  });
  const names = clean.map(({ categoryId }) => nameOf(categoryId)).join(", ");
  return [
    clean.length
      ? `Can cover the gap alone without touching a must-have: ${names}.`
      : "No single category can cover the gap without touching a must-have or being removed.",
  ];
}

function keyPoints({ state, after, consequences, nameOf, money, events }) {
  const unpriced = events
    .filter(({ type, price }) => type === "line_item_swap" && !price)
    .map(({ add }) => `${add} has no price yet, so these figures leave its cost out.`);
  const guests =
    after.guestCount === state.guestCount
      ? []
      : [`Guests go from ${state.guestCount} to ${after.guestCount}.`];
  const total =
    after.totalMinor === state.totalMinor
      ? []
      : [`Total budget goes from ${money(state.totalMinor)} to ${money(after.totalMinor)}.`];
  return [
    ...unpriced,
    ...guests,
    ...perGuestPoint(state, after, money),
    ...total,
    ...gapPoint(consequences, nameOf),
  ];
}

function askAnalyst({ profile, text, facts, headline, generate }) {
  const event = JSON.stringify({
    purpose: profile.purpose,
    guestsShouldFeel: profile.attendeeExperience,
    mustHaves: profile.mustHaves.map((item) => item.text),
    constraints: profile.constraints,
  });
  const content = [
    wrapUntrusted("event", event),
    wrapUntrusted("user request", text),
    wrapUntrusted("facts", facts, MAX_FACTS),
  ].join("\n");
  return generateOrDemo(generate, {
    agent: "budget",
    system: SYSTEM,
    messages: [{ role: "user", content }],
    schema: insightOutput,
    demo: () => ({ headline, insight: "", optionNotes: [], rationale: "" }),
  });
}

// A note is kept only if it cites nothing new and belongs to a real option.
function safeOptionNotes(notes = [], options, allowed) {
  const safe = {};
  for (const { categoryId, note } of notes) {
    const text = groundedOr(note, allowed);
    if (text && options.some((option) => option.categoryId === categoryId)) safe[categoryId] = text;
  }
  return safe;
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
  const { state, after, consequences, consequenceText, profile, text } = input;
  const money = (minor) => wholeMoney(minor, state.currency);
  const points = keyPoints({
    state,
    after,
    consequences,
    nameOf: (id) => categoryName(input.template, id),
    money,
    events: input.events ?? [],
  });
  const gap = consequences.shortfall.highMinor;
  const headline = gap
    ? `This puts you ${money(gap)} over budget.`
    : `You stay within budget, with ${money(consequences.surplusMinor)} to spare.`;
  if (input.offline) return { headline, insight: "", points, optionNotes: {}, offline: true };

  const facts = [...points, consequenceText, ...budgetFacts(after, profile)].join("\n");
  const { data, offline } = await askAnalyst({ profile, text, facts, headline, generate });
  const allowed = `${facts} ${text} ${JSON.stringify(profile.mustHaves)}`;
  return {
    headline: groundedOr(data.headline, allowed, headline),
    insight: groundedOr(data.insight, allowed),
    points,
    optionNotes: safeOptionNotes(data.optionNotes, consequences.options, allowed),
    offline,
  };
}
