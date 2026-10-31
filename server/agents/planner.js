import { canMarkDirective, canSeeBudget } from "../core/permissions.js";
import { parseDueDate } from "../core/dateText.js";
import { groupsForCategory } from "../core/templates.js";
import {
  agentPrompt,
  generate as realGenerate,
  generateOrDemo,
  wrapUntrusted,
} from "../llm/index.js";
import { advise } from "./advisor.js";
import { interpretChange } from "./budget.js";
import { categoriesMentioned } from "./discoveryDemo.js";
import { groundedOr, isGrounded } from "./grounded.js";
import { generateIdeas } from "./ideas.js";
import { demoIntent } from "./plannerDemo.js";
import { directiveTaskOutput, plannerOutput } from "./schemas.js";
import { digest } from "./timeline.js";
import { buildRfq } from "./vendor.js";

const MAX_TEXT = 1000;
const DEFAULT_DUE_DAYS = 2;
const DAY_MS = 86400000;
const HELP =
  "I can help with budget changes (try 'what if we add 50 guests?'), vendor questions, your timeline and ideas. What would you like?";
const DELEGATE = {
  budget_change: "budget",
  vendor_help: "vendor",
  timeline: "timeline",
  ideas: "ideas",
  advice: "planner",
  vendor_brief: "vendor",
  question: null,
};

const PLANNER_SYSTEM = agentPrompt({
  role:
    "You are Planner, the orchestrator behind @huddle in Huddle, a team workspace for planning " +
    "events. You read one message and decide who should handle it. A good event fits the " +
    "organiser; it is not the most expensive one.",
  steps: ["understand the message", "check the event profile", "choose the intent", "output"],
  rules: [
    "Intents: budget_change (guests, budget, costs, swapping items), vendor_help (vendor " +
      "checklist, RFQ questions, quotes), timeline (tasks, deadlines, what is due or at risk), " +
      "ideas (suggestions, themes), advice (what to do next, what needs attention), vendor_brief " +
      "(hiring a vendor, drafting a brief), question (anything else).",
    "For vendor_help and vendor_brief set categoryId to one of the listed category ids when the message names " +
      "one, otherwise null.",
    "Set suggestDirective to true only when the message is an instruction with a deadline that " +
      "the manager may want to pin.",
    "For a question, put a short answer in reply using only facts from the profile; never state " +
      "a number you were not given.",
    "Never discuss the total budget.",
  ],
});

const TASK_SYSTEM = agentPrompt({
  role: "You are Planner. You turn a manager's directive into one timeline task title, and pick which group owns it.",
  steps: ["read the directive", "write a short task title", "pick the owning group"],
  rules: [
    "The title is a short imperative sentence using only words and numbers from the directive.",
    "ownerGroupSlug must be one of the group slugs listed.",
  ],
});

async function classify({ text, profile, template, generate }) {
  const demo = async () =>
    plannerOutput.parse({
      ...demoIntent(text),
      categoryId: null,
      rationale: "I read your message with simple rules.",
    });
  const categories = template.categories.map(({ id, name }) => ({ id, name }));
  const context = JSON.stringify({
    name: profile.name,
    purpose: profile.purpose,
    city: profile.city,
    date: profile.date,
  });
  const content = [
    `Categories: ${JSON.stringify(categories)}`,
    wrapUntrusted("event profile", context),
    wrapUntrusted("message", text),
  ].join("\n");
  const { data } = await generateOrDemo(generate, {
    agent: "planner",
    system: PLANNER_SYSTEM,
    messages: [{ role: "user", content }],
    schema: plannerOutput,
    demo,
  });
  return { plan: data, context };
}

const bullet = (lines) => lines.map((line) => `- ${line}`).join("\n");

async function vendorReply(input, plan, deps) {
  const { profile, template, text } = input;
  const categoryId = template.categories.some(({ id }) => id === plan.categoryId)
    ? plan.categoryId
    : categoriesMentioned(text, template)[0];
  if (profile.guests.confirmed === null)
    return {
      reply:
        "Let's finish setting up the event first, so I can ask vendors for the right guest count.",
    };
  if (!categoryId)
    return {
      reply: `Which category should I prepare vendor questions for? ${template.categories.map(({ name }) => name).join(", ")}.`,
    };
  const rfq = await buildRfq({ profile, categoryId, template }, deps);
  const name = template.categories.find(({ id }) => id === categoryId).name;
  return {
    reply: `Vendor checklist for ${name}:\n${bullet(rfq.checklist)}\nQuestions to ask every vendor:\n${bullet(rfq.rfqQuestions)}`,
    result: { categoryId, ...rfq },
  };
}

async function budgetReply(input, deps) {
  const result = await interpretChange(input, deps);
  const asked = result.changeEvents.length === 0;
  const reply = [
    result.explanation,
    asked ? result.clarifyingQuestion : result.consequenceText,
    !asked && result.clarifyingQuestion,
  ]
    .filter(Boolean)
    .join("\n");
  return { reply: asked ? reply : `${reply}\nNothing changes until you accept.`, result };
}

async function ideasReply(input, deps) {
  if (!canSeeBudget(input.actor, "total"))
    return { reply: "Ideas are matched to the budget, so please ask the event manager." };
  const result = await generateIdeas(input, deps);
  if (!result.ideas.length)
    return {
      reply:
        "I couldn't come up with ideas that fit yet. Tell me more about what guests should feel.",
      result,
    };
  return {
    reply: `Ideas that fit your event:\n${bullet(result.ideas.map((i) => `${i.title}: ${i.whyItFits} ${i.costShare}`))}`,
    result,
  };
}

async function adviceReply(input, deps) {
  if (!canSeeBudget(input.actor, "total"))
    return { reply: "What to do next depends on the budget, so please ask the event manager." };
  const result = await advise(input, deps);
  return {
    reply: result.items.length
      ? `What I'd do next:\n${bullet(result.items.map(({ title, why }) => `${title}: ${why}`))}`
      : result.summary,
    result,
  };
}

/**
 * Handles an @huddle message: reads what it asks for, hands it to the right agent and returns the
 * reply to post in the same group. The caller posts it and stores any budget change the user accepts.
 * @param {{profile: object, state: object, template: object, actor: object, text: string,
 *   files?: object[], tasks?: object[], quotes?: object[], directives?: object[], members?: object[],
 *   nowIso?: string}} input The event, who asks, and what they said.
 * @param {{generate?: Function}} [deps] The model call, replaceable in tests.
 * @returns {Promise<{reply: string, intent: string, delegateTo: string | null, suggestDirective: boolean,
 *   rationale: string, result?: object}>} The reply, and the delegate's raw result when there is one.
 */
export async function handleMention(input, deps = {}) {
  const generate = deps.generate ?? realGenerate;
  const text = String(input.text ?? "")
    .replace(/@huddle\b/gi, "")
    .trim()
    .slice(0, MAX_TEXT);
  const nowIso = input.nowIso ?? new Date().toISOString();
  if (!text)
    return {
      reply: HELP,
      intent: "question",
      delegateTo: null,
      suggestDirective: false,
      rationale: "You mentioned me without a question.",
    };

  const { plan, context } = await classify({
    text,
    profile: input.profile,
    template: input.template,
    generate,
  });
  const call = { ...input, text, nowIso };
  const handled = {
    budget_change: () => budgetReply(call, { generate }),
    vendor_help: () => vendorReply(call, plan, { generate }),
    timeline: async () => ({ reply: (await digest(call, { generate })).digestText }),
    ideas: () => ideasReply(call, { generate }),
    advice: () => adviceReply(call, { generate }),
    // Saving a brief belongs to the route, which knows who is asking and in which group.
    vendor_brief: async () => ({ reply: "", result: { categoryId: plan.categoryId ?? null } }),
    question: async () => ({
      reply: groundedOr(plan.reply, `${context} ${text}`, HELP),
    }),
  };
  const { reply, result } = await handled[plan.intent]();
  return {
    reply,
    intent: plan.intent,
    delegateTo: DELEGATE[plan.intent],
    suggestDirective: plan.suggestDirective && canMarkDirective(input.actor),
    rationale: groundedOr(plan.rationale, ""),
    ...(result && { result }),
  };
}

/**
 * Turns a manager's directive into a timeline task. The due date is read from the directive in code
 * (or defaults to two days out); the model only words the title and picks the owning group.
 * @param {{directiveText: string, template: object, nowIso?: string}} input The directive and template.
 * @param {{generate?: Function}} [deps] The model call, replaceable in tests.
 * @returns {Promise<{title: string, ownerGroupSlug: string, dueDate: string, rationale: string}>} The task details.
 */
export async function taskFromDirective(
  { directiveText, template, nowIso = new Date().toISOString() },
  { generate = realGenerate } = {},
) {
  const text = directiveText.slice(0, MAX_TEXT);
  const slugs = template.groups.map(({ slug }) => slug);
  const guessed = categoriesMentioned(text, template)[0];
  const fallbackOwner = guessed
    ? groupsForCategory(template.categoryGroupMap, guessed)[0]
    : "core-team";
  const demo = async () => ({
    title:
      text
        .split(/[.!?\n]/)[0]
        .trim()
        .slice(0, 100) || "Follow up",
    ownerGroupSlug: fallbackOwner,
    rationale: "I used your own words for the task.",
  });
  const content = [`Group slugs: ${slugs.join(", ")}`, wrapUntrusted("directive", text)].join("\n");
  const { data } = await generateOrDemo(generate, {
    agent: "planner",
    system: TASK_SYSTEM,
    messages: [{ role: "user", content }],
    schema: directiveTaskOutput,
    demo,
  });
  const title =
    isGrounded(data.title, text) && data.title.trim() ? data.title.trim() : (await demo()).title;
  const today = new Date(nowIso).toISOString().slice(0, 10);
  const parsed = parseDueDate(text, nowIso);
  const dueDate =
    parsed && parsed.slice(0, 10) >= today
      ? parsed
      : new Date(Date.parse(`${today}T00:00:00.000Z`) + DEFAULT_DUE_DAYS * DAY_MS).toISOString();
  return {
    title,
    ownerGroupSlug: slugs.includes(data.ownerGroupSlug) ? data.ownerGroupSlug : fallbackOwner,
    dueDate,
    rationale: groundedOr(data.rationale, ""),
  };
}
