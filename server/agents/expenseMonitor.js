import { mentionsMoney } from "../core/amount.js";
import {
  agentPrompt,
  generate as realGenerate,
  generateOrDemo,
  wrapUntrusted,
} from "../llm/index.js";
import { groundedOr } from "./grounded.js";
import { expenseAlertOutput } from "./schemas.js";

const MAX_DESCRIPTION = 80;
const OVER_CHOICES =
  "The event manager decides: cover it from the buffer, move money from another category, or go back to the vendor.";
const NEAR_NEXT = "Nothing needs deciding yet. It is worth checking before the next payment.";
const RATIONALE =
  "Huddle checks every expense against the plan. The exact figures are on the Budget page.";
// These go into a shared room, so a figure or the ranking must never get through.
const sharedSafe = (text) =>
  !mentionsMoney(text) &&
  !/\d|\bpriorit|\btotal budget\b|\b(?:half|double|twice|third|quarter|percent|two|three|four|five|ten)\b/i.test(
    text,
  );

const SYSTEM = agentPrompt({
  role:
    "You are Huddle's Budget agent, watching what the team spends. Code has found that a " +
    "category crossed a line in its plan. You tell the team that shares its room what that means.",
  steps: [
    "read the facts",
    "work out what this could touch for this event",
    "say who decides and what the choices are",
  ],
  rules: [
    "Two or three short sentences, calm and practical, for a team chat.",
    "Use only the facts given. Never write an amount, a percentage or any other number.",
    "Never mention the total budget or how categories are ranked.",
    "Name the choices neutrally and don't pick one. Never pressure or blame anyone.",
  ],
});

/**
 * The facts a room may be told about a category crossing a line in its plan. They hold no figures
 * and no must-haves, because a room can include people who don't own the category.
 * @param {{alert: {status: string, name: string, categoryId: string}, description?: string,
 *   actorName?: string}} input What happened and who logged the expense.
 * @returns {string[]} Plain-text facts.
 */
export function alertFacts({ alert, description, actorName }) {
  const over = alert.status === "over";
  const said = String(description ?? "").slice(0, MAX_DESCRIPTION);
  return [
    over ? `${alert.name} has gone over its plan.` : `${alert.name} has used most of its plan.`,
    actorName && said && sharedSafe(said) ? `${actorName} just logged "${said}".` : null,
    over ? OVER_CHOICES : NEAR_NEXT,
  ].filter(Boolean);
}

/**
 * Words the message the Budget agent posts when spending crosses a line. Code decides that it
 * happened and who hears; the model only explains it.
 * @param {{facts: string[]}} input The facts from `alertFacts`.
 * @param {{generate?: Function}} [deps] The model call, replaceable in tests.
 * @returns {Promise<{wording: string, rationale: string}>} The message. If the model used a figure
 *   or left the facts, the plain facts are used instead.
 */
export async function wordAlert({ facts }, { generate = realGenerate } = {}) {
  const plain = facts.join(" ");
  const demo = () => ({ wording: plain, rationale: RATIONALE });
  const { data } = await generateOrDemo(generate, {
    agent: "notices",
    system: SYSTEM,
    messages: [{ role: "user", content: wrapUntrusted("facts", facts.join("\n")) }],
    schema: expenseAlertOutput,
    demo,
  });
  const wording = groundedOr(data.wording, plain, plain);
  const rationale = groundedOr(data.rationale, plain, RATIONALE);
  return {
    wording: sharedSafe(wording) ? wording : plain,
    rationale: sharedSafe(rationale) ? rationale : RATIONALE,
  };
}
