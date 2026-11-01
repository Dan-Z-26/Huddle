import { planningSignals } from "../core/signals.js";
import {
  agentPrompt,
  generate as realGenerate,
  generateOrDemo,
  wrapUntrusted,
} from "../llm/index.js";
import { groundedOr } from "./grounded.js";
import { adviceOutput } from "./schemas.js";

const MAX_ITEMS = 4;
const SYSTEM = agentPrompt({
  role:
    "You are Planner, an experienced event planner advising the organiser on what to do next. " +
    "Code has already found what needs attention. A good event fits the organiser; it is not " +
    "the most expensive one, so never upsell.",
  steps: [
    "read the event's purpose, what guests should feel and the must-haves",
    "read the signals",
    "choose what matters most for this event, and in what order",
    "write the output",
  ],
  rules: [
    "items: at most four, most important first. signalId must be one of the signal ids given.",
    "title: a short, concrete next step starting with a verb.",
    "why: one or two sentences on why this matters for this event, tied to its purpose, its " +
      "guests or its must-haves.",
    "Use only figures that appear in the signals. Never calculate or invent a number.",
  ],
});

const STEP = {
  "over-budget": "Close the budget gap",
  overspent: "Deal with the overspend",
  "must-have": "Protect your must-have",
  "tasks-late": "Catch up on what's late",
  "task-soon": "Get ahead of the next deadline",
  "quotes-unchecked": "Check the quotes that came in",
  "quotes-waiting": "Compare the quotes and choose",
  "no-quotes": "Start collecting quotes",
  "no-buffer": "Set aside a buffer",
  "buffer-low": "Top up the buffer",
};
const stepFor = (id) =>
  STEP[Object.keys(STEP).find((key) => id === key || id.startsWith(`${key}-`))];

const plainItems = (signals) =>
  signals.slice(0, MAX_ITEMS).map(({ id, action, fact }) => ({
    signalId: id,
    action,
    title: stepFor(id),
    why: fact,
  }));

/**
 * Advises the manager on what to do next. Code finds what needs attention and every figure; the
 * model only chooses the order and says why each step matters to this event. A step can't be
 * invented, because each must point at a signal. Manager only: it reads budget figures.
 * @param {{profile: object, state: object, expenses?: object[], tasks?: object[], quotes?: object[],
 *   nowIso?: string}} input The event as it stands now.
 * @param {{generate?: Function}} [deps] The model call, replaceable in tests.
 * @returns {Promise<{items: Array<{signalId: string, action: string, title: string, why: string}>,
 *   summary: string, offline: boolean}>} The next steps.
 */
export async function advise(input, { generate = realGenerate } = {}) {
  const { profile, nowIso = new Date().toISOString() } = input;
  const signals = planningSignals({ ...input, nowIso });
  if (signals.length === 0)
    return {
      items: [],
      summary: "Nothing needs you right now. The plan is on track.",
      offline: false,
    };
  const facts = signals.map(({ id, fact }) => `${id}: ${fact}`).join("\n");
  const content = [
    wrapUntrusted(
      "event",
      JSON.stringify({
        purpose: profile.purpose,
        guestsShouldFeel: profile.attendeeExperience,
        mustHaves: profile.mustHaves.map(({ text }) => text),
        constraints: profile.constraints,
      }),
    ),
    wrapUntrusted("signals", facts, 4000),
  ].join("\n");
  const { data, offline } = await generateOrDemo(generate, {
    agent: "budget",
    system: SYSTEM,
    messages: [{ role: "user", content }],
    schema: adviceOutput,
    demo: () => ({ items: [], summary: "", rationale: "" }),
  });
  const allowed = `${facts} ${JSON.stringify(profile.mustHaves)} ${profile.purpose} ${profile.attendeeExperience}`;
  const seen = new Set();
  const items = (data.items ?? []).flatMap(({ signalId, title, why }) => {
    const signal = signals.find(({ id }) => id === signalId);
    if (!signal || seen.has(signalId)) return [];
    seen.add(signalId);
    return [
      {
        signalId,
        action: signal.action,
        title: groundedOr(title, allowed, stepFor(signalId)),
        why: groundedOr(why, allowed, signal.fact),
      },
    ];
  });
  return {
    items: items.length ? items.slice(0, MAX_ITEMS) : plainItems(signals),
    summary: "",
    offline,
  };
}
