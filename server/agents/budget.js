import { computeBudget } from "../core/budgetEngine.js";
import { computeConsequences } from "../core/consequences.js";
import { canSeeBudget } from "../core/permissions.js";
import { generate as realGenerate, UNTRUSTED_RULE, wrapUntrusted } from "../llm/index.js";
import { demoBudget } from "./budgetDemo.js";
import { toChangeEvents } from "./changeProposals.js";
import { consequenceText } from "./consequenceText.js";
import { isGrounded } from "./grounded.js";
import { budgetOutput } from "./schemas.js";
import { buildTools } from "./tools.js";

const BUDGET_TOOLS = new Set(["compute_consequences", "apply_change_events"]);
const MAX_TEXT = 1000;

const SYSTEM = `You are the Budget agent of Huddle. You turn an organiser's plain-language change into proposals, and the tools calculate. A good event fits the organiser; it is not the most expensive one.
Work privately in these steps and never show them: understand the request -> check the event profile, priorities and must-haves -> propose the change(s) -> call compute_consequences to see their effect -> use only tool results -> write the output.
Rules:
- Never do arithmetic and never invent figures. Copy money exactly as the user wrote it into amountText or priceText (for example "18 lakh").
- Only when the user does not know a price, give an estimate range in whole rupees (lowRupees, highRupees). It is shown as an estimate and never counts as committed.
- Use only the category ids, item ids and labels you are given. Set confidence honestly; below 0.7 the user is asked instead.
- If the request is unclear, return no proposals and put one short question in clarifyingQuestion.
- explanation: one or two neutral sentences using only values the tools returned. Never recommend an option, pressure or upsell; the user decides.
Return ONLY JSON matching the schema, with a one-sentence rationale for the user.
${UNTRUSTED_RULE}`;

function stateSummary(state, profile) {
  const categories = state.categories.map(({ id, name, locked, drivers }) => ({
    id,
    name,
    locked,
    items: drivers.map((driver) => ({
      id: driver.id,
      label: driver.label,
      kind: driver.kind,
      source: driver.source,
    })),
  }));
  return JSON.stringify({
    guestCount: state.guestCount,
    priorities: profile.priorities,
    mustHaves: profile.mustHaves,
    categories,
  });
}

function estimatesOf(events) {
  return events.flatMap((event) => {
    const price = event.item ?? event.price;
    if (price?.source !== "estimate") return [];
    const label = event.item?.label ?? event.add;
    return [{ category: event.category, label, ...price.estimate }];
  });
}

async function askModel(input, generate, nowIso) {
  const { profile, state, actor, template, text } = input;
  const demo = async () => budgetOutput.parse(demoBudget({ text, template }));
  const tools = buildTools({ actor, profile, template, state, nowIso }).filter(({ name }) =>
    BUDGET_TOOLS.has(name),
  );
  const content = [
    wrapUntrusted("budget state", stateSummary(state, profile)),
    wrapUntrusted("user request", text),
  ].join("\n");
  try {
    const { data } = await generate({
      agent: "budget",
      system: SYSTEM,
      messages: [{ role: "user", content }],
      schema: budgetOutput,
      tools,
      demo,
    });
    return data;
  } catch (err) {
    if (err.name === "LlmError") return demo();
    throw err;
  }
}

const refusal = {
  allowed: false,
  changeEvents: [],
  estimates: [],
  clarifyingQuestion: null,
  consequences: null,
  consequenceText: "",
  explanation: "Only the event manager can change the budget.",
  rationale: "Budget changes are limited to the event manager.",
};

/**
 * Turns a plain-language budget change into validated change events and states what they do. The
 * model reads the request; code parses every amount, applies the events and writes the
 * consequences. It never recommends. The caller stores the events if the user accepts them.
 * @param {{profile: object, state: object, actor: object, text: string, template: object,
 *   nowIso?: string}} input The event, its budget, who asks, and what they said.
 * @param {{generate?: Function}} [deps] The model call, replaceable in tests.
 * @returns {Promise<{allowed: boolean, changeEvents: object[], estimates: object[],
 *   clarifyingQuestion: string | null, consequences: object | null, consequenceText: string,
 *   explanation: string, rationale: string}>} The proposed change and its consequences.
 */
export async function interpretChange(input, { generate = realGenerate } = {}) {
  const { profile, state, actor, template, nowIso = new Date().toISOString() } = input;
  if (!canSeeBudget(actor, "total")) return { ...refusal };
  const text = String(input.text ?? "").slice(0, MAX_TEXT);
  const data = await askModel({ ...input, text }, generate, nowIso);
  const categoryIds = state.categories.map(({ id }) => id);
  const { events, questions } = toChangeEvents(data.proposals, { categoryIds });

  const result = {
    allowed: true,
    changeEvents: events,
    estimates: estimatesOf(events),
    rationale: data.rationale,
  };
  if (events.length === 0) {
    const asked =
      data.clarifyingQuestion ??
      (questions[0] && `${questions[0].reason}. Could you say it another way?`);
    return {
      ...result,
      clarifyingQuestion: asked ?? "What would you like to change?",
      consequences: null,
      consequenceText: "",
      explanation: "",
    };
  }
  const { after, ...rest } = computeConsequences(state, events, profile);
  const lines = consequenceText(rest, { profile, template, currency: state.currency });
  const problem = rest.rejected[0]?.reason ?? questions[0]?.reason;
  const allowedText = `${lines} ${text} ${state.guestCount} ${after.guestCount}`;
  return {
    ...result,
    clarifyingQuestion: problem ? `${problem}. Could you check that?` : null,
    consequences: { ...rest, budgetAfter: computeBudget(after) },
    consequenceText: lines,
    explanation: isGrounded(data.explanation, allowedText) ? data.explanation : "",
  };
}
