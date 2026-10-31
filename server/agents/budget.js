import { computeBudget } from "../core/budgetEngine.js";
import { computeConsequences } from "../core/consequences.js";
import { canSeeBudget } from "../core/permissions.js";
import {
  agentPrompt,
  generate as realGenerate,
  generateOrDemo,
  wrapUntrusted,
} from "../llm/index.js";
import { budgetFacts, explainChange } from "./budgetInsight.js";
import { CLARIFY, demoBudget } from "./budgetDemo.js";
import { toChangeEvents } from "./changeProposals.js";
import { consequenceText } from "./consequenceText.js";
import { groundedOr } from "./grounded.js";
import { budgetOutput } from "./schemas.js";
import { buildTools } from "./tools.js";

const BUDGET_TOOLS = new Set(["compute_consequences", "apply_change_events"]);
const MAX_TEXT = 1000;

const SYSTEM = agentPrompt({
  role:
    "You are the Budget agent of Huddle. You turn an organiser's plain-language change into " +
    "proposals, and the tools calculate. A good event fits the organiser; it is not the most " +
    "expensive one.",
  steps: [
    "understand the request",
    "check the event profile, priorities and must-haves",
    "propose the change(s)",
    "call compute_consequences once if you proposed a change",
    "use only tool results",
    "write the output",
  ],
  rules: [
    "Never do arithmetic and never invent figures. Copy money exactly as the user wrote it into " +
      'amountText or priceText (for example "18 lakh").',
    "When a new item has no price from the user, always give an estimate range in whole rupees " +
      "(lowRupees, highRupees). It is shown as an estimate and never counts as committed.",
    "Use only the category ids, item ids and labels you are given. Set confidence honestly; " +
      "below 0.7 the user is asked instead.",
    "The user may ask for a change, explore an idea or ask a plain question. Understand what " +
      "they mean, in any wording, using the budget figures you are given.",
    "A question about the current plan (how much, per guest, what is left, can we afford): make " +
      "no proposals; put a direct answer in answer, quoting exact figures from the budget facts.",
    "An idea with a cost, such as adding a live band: propose it as line_item_add or " +
      "line_item_swap, with the user's price or an estimate range, so its effect can be shown.",
    "Moving money between categories: category_shift. Raising or lowering a category: " +
      "category_adjust, with percent (half is 50) or amountText as the user said it. Setting a " +
      "category to a figure: category_amount. For line_item_swap and line_item_remove, use an " +
      "item label or id from the facts.",
    "Your final JSON must repeat every proposal, even if you tried it with a tool.",
    "Examples. 'what if 50 more people come': guest_count delta 50. 'can we afford a live band?': " +
      "line_item_add in music with an estimate range. 'cut food by 20% and put it into decor': one " +
      "category_shift or one category_adjust per category, never both for the same money.",
    "A what-if or an idea is always a proposal, never an answer. Use answer only for facts " +
      "already in the budget.",
    "If the request is truly unclear, return no proposals and put one short question in " +
      "clarifyingQuestion, naming the real categories it could be about.",
    "explanation: one or two neutral sentences using only values the tools returned. Never " +
      "recommend an option, pressure or upsell; the user decides.",
  ],
});

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
  const facts = budgetFacts(state, profile);
  const demo = async () => budgetOutput.parse(demoBudget({ text, template, facts }));
  const tools = buildTools({ actor, profile, template, state, nowIso }).filter(({ name }) =>
    BUDGET_TOOLS.has(name),
  );
  const content = [
    wrapUntrusted(
      "budget facts",
      [...facts, `Must-haves: ${profile.mustHaves.map((item) => item.text).join("; ")}`].join("\n"),
      8000,
    ),
    wrapUntrusted("user request", text),
  ].join("\n");
  const { data, offline, toolCalls } = await generateOrDemo(generate, {
    agent: "budget",
    system: SYSTEM,
    messages: [{ role: "user", content }],
    schema: budgetOutput,
    tools,
    maxToolCalls: 1,
    demo,
  });
  // A model can try a change with the tool, then leave it out of its final answer.
  const tried = toolCalls.find(({ name }) => name === "compute_consequences")?.args?.proposals;
  const dropped = data.proposals.length === 0 && !data.answer && Array.isArray(tried);
  return { data: dropped ? { ...data, proposals: tried } : data, offline };
}

const refusal = {
  allowed: false,
  changeEvents: [],
  estimates: [],
  clarifyingQuestion: null,
  answer: "",
  insight: null,
  offline: false,
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
 * @returns {Promise<{allowed: boolean, changeEvents: object[], estimates: object[], answer: string,
 *   clarifyingQuestion: string | null, consequences: object | null, consequenceText: string,
 *   insight: object | null, explanation: string, rationale: string, offline: boolean}>} The answer
 *   to a question, or the proposed change, its consequences and what they mean for this event;
 *   `offline` says no model was reached.
 */
export async function interpretChange(input, { generate = realGenerate } = {}) {
  const { profile, state, actor, template, nowIso = new Date().toISOString() } = input;
  if (!canSeeBudget(actor, "total")) return { ...refusal };
  const text = String(input.text ?? "").slice(0, MAX_TEXT);
  const { data, offline } = await askModel({ ...input, text }, generate, nowIso);
  const categoryIds = state.categories.map(({ id }) => id);
  const { events, questions } = toChangeEvents(data.proposals, { categoryIds, state });

  const result = {
    allowed: true,
    changeEvents: events,
    estimates: estimatesOf(events),
    rationale: groundedOr(data.rationale, ""),
    offline,
    insight: null,
    answer: "",
  };
  if (events.length === 0) {
    const facts = budgetFacts(state, profile).join(" ");
    const answer = questions.length === 0 ? groundedOr(data.answer, `${facts} ${text}`) : "";
    if (answer)
      return {
        ...result,
        answer,
        clarifyingQuestion: null,
        consequences: null,
        consequenceText: "",
        explanation: "",
      };
    const asked =
      groundedOr(data.clarifyingQuestion, `${text} ${CLARIFY}`) ||
      (questions[0] && `${questions[0].reason}. Could you say it another way?`);
    return {
      ...result,
      clarifyingQuestion: asked ?? "What would you like to change?",
      consequences: null,
      consequenceText: "",
      explanation: "",
    };
  }
  const described = await describeChange(
    {
      profile,
      state,
      events,
      template,
      text,
      offline,
      question: questions[0]?.reason,
      explanation: data.explanation,
    },
    { generate },
  );
  return { ...result, ...described };
}

/**
 * States what a set of change events does: consequences from code, written out neutrally, plus
 * the model's reading of what it means for this event. Used for typed requests and for accepting
 * a vendor quote alike. Nothing is applied.
 * @param {{profile: object, state: object, events: object[], template: object, text: string,
 *   offline?: boolean, question?: string, explanation?: string}} input The budget and the events;
 *   `question` is something still unclear about the request.
 * @param {{generate?: Function}} [deps] The model call, replaceable in tests.
 * @returns {Promise<{insight: object, offline: boolean, clarifyingQuestion: string | null,
 *   consequences: object, consequenceText: string, explanation: string}>} The change described.
 */
export async function describeChange(input, { generate = realGenerate } = {}) {
  const { profile, state, events, template, text, offline = false } = input;
  const { after, ...rest } = computeConsequences(state, events, profile);
  const lines = consequenceText(rest, { profile, template, currency: state.currency });
  const problem = rest.rejected[0]?.reason ?? input.question;
  const allowedText = `${lines} ${text} ${state.guestCount} ${after.guestCount}`;
  const insight = await explainChange(
    {
      state,
      after,
      events,
      consequences: rest,
      consequenceText: lines,
      profile,
      template,
      text,
      offline,
    },
    { generate },
  );
  return {
    insight,
    offline: insight.offline,
    clarifyingQuestion: problem ? `${problem}. Could you check that?` : null,
    consequences: {
      ...rest,
      budgetAfter: { ...computeBudget(after), guestCount: after.guestCount },
    },
    consequenceText: lines,
    explanation: groundedOr(input.explanation, allowedText),
  };
}
