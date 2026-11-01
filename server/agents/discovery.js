/** The Discovery agent: one setup question at a time, and every answer into the EventProfile. */
import { missingProfileFields } from "../core/profile.js";
import { generate as realGenerate, generateOrDemo } from "../llm/index.js";
import { demoExtract, directExtract } from "./discoveryDemo.js";
import { buildMessage, SYSTEM } from "./discoveryPrompt.js";
import { groundedOr } from "./grounded.js";
import { applyExtracted, resolveGuests } from "./profileMerge.js";
import { cleanOptions, guestConfirmation, optionsFor, questionFor } from "./questions.js";
import { discoveryOutput, extraction } from "./schemas.js";
import { buildTools } from "./tools.js";

const SKIPPABLE = new Set(["mustHaves", "absoluteMustHave", "constraints", "vendorNeeds"]);
// The whole reply, so a must-have like "No alcohol" isn't taken for a skip.
const NONE =
  /^\s*(?:none|no|nothing|nope|nil|n\/a|skip(?: for now| it| this)?|not really)(?:,?\s*thanks)?\s*[.!]?\s*$/i;
const MAX_ANSWER = 2000;
const MAX_PURPOSE = 500;
const INTAKE_TOOLS = new Set(["parse_guest_count", "missing_profile_fields"]);
const FIRST_RATIONALE = "Let's start with the basics.";
const ALL_ANSWERED =
  "That's everything I need. Check the summary and confirm to create your workspace.";

async function extractWithModel(input, generate, nowIso, { useTools = true } = {}) {
  const { profile, template } = input;
  const demoOutput = () => {
    // A long reply can overflow a field's length cap; read nothing from it rather than fail.
    const read = extraction.safeParse(demoExtract(input));
    return {
      extracted: read.success ? read.data : {},
      rationale: "I read your answer with simple rules.",
    };
  };
  const tools = useTools
    ? buildTools({
        actor: { kind: "manager", eventId: profile.id },
        profile,
        template,
        nowIso,
      }).filter(({ name }) => INTAKE_TOOLS.has(name))
    : [];
  const { data } = await generateOrDemo(generate, {
    agent: "discovery",
    system: SYSTEM,
    messages: [
      { role: "user", content: buildMessage({ ...input, missing: missingProfileFields(profile) }) },
    ],
    schema: discoveryOutput,
    tools,
    // Each tool call is a model call, and someone answering questions shouldn't use up the minute.
    maxToolCalls: 1,
    demo: demoOutput,
  });
  return data;
}

// A single must-have is the absolute one; no must-haves means there is nothing to rank.
function settle(profile) {
  const next = profile;
  if (next.mustHaves.length === 1 && !next.absoluteMustHaveId)
    next.absoluteMustHaveId = next.mustHaves[0].id;
  if (next.mustHaves.length === 0 && next.skippedFields.includes("mustHaves")) {
    next.skippedFields = [...new Set([...next.skippedFields, "absoluteMustHave"])];
  }
  return next;
}

function chooseQuestion({ working, template, nextField, model, rejected, progressed }) {
  // Written for this event when the user described it, so a tapped answer needs no model call.
  const written = groundedOr(working.suggestedQuestions?.[nextField] ?? "", "");
  const planned = written || questionFor(nextField, working, template);
  if (nextField === "guests") {
    const waiting = working.guests.suggested > 0 && working.guests.confirmed === null;
    return waiting ? guestConfirmation(working.guests) : planned;
  }
  if (rejected.length || !progressed) return planned;
  const usable = model?.nextField === nextField && groundedOr(model.nextQuestion, "");
  return usable || planned;
}

// What to tell the user before repeating a question: why the last answer wasn't used.
function feedbackFor({ rejected, progressed }) {
  if (rejected.length) return `${rejected[0].reason}.`;
  return progressed ? "" : "I didn't quite catch that.";
}

const valueOf = (profile, key) =>
  key === "absoluteMustHave" ? profile.absoluteMustHaveId : profile[key];

// A free description of the whole event. Anything unusable here is simply asked for in its turn, so
// nothing is refused out loud.
async function readOpening({ working, template, answer, nowIso }, generate) {
  const text = answer.slice(0, MAX_ANSWER);
  const model = await extractWithModel(
    { profile: working, template, field: "opening", answer: text },
    generate,
    nowIso,
    { useTools: false },
  );
  const { profile, accepted } = applyExtracted(working, model.extracted, {
    template,
    nowIso,
    answer: text,
    field: "opening",
  });
  // Their description is what the event is about, even if the model didn't lift a purpose out.
  if (!profile.purpose) profile.purpose = text.trim().slice(0, MAX_PURPOSE);
  const options = cleanOptions(model.options, template);
  if (Object.keys(options).length) profile.suggestedOptions = options;
  if (model.questions) profile.suggestedQuestions = model.questions;
  return {
    working: profile,
    accepted,
    rejected: [],
    rationale: groundedOr(model.rationale, "", FIRST_RATIONALE),
    model,
  };
}

// An answer to one question: guest counts and skips are read in code, tapped answers need no model.
async function readFieldAnswer({ working, template, field, answer, mode, nowIso }, generate) {
  const text = answer.slice(0, MAX_ANSWER);
  const context = { template, nowIso, answer: text, field };
  if (field === "guests") {
    const { profile, understood } = resolveGuests(working, text);
    return {
      working: profile,
      accepted: understood ? ["guests"] : [],
      rejected: [],
      rationale: understood ? "Noted your guest count." : "I couldn't find a guest number in that.",
      model: null,
    };
  }
  if (SKIPPABLE.has(field) && NONE.test(text))
    return {
      working: { ...working, skippedFields: [...new Set([...working.skippedFields, field])] },
      accepted: [field],
      rejected: [],
      rationale: "Okay, we'll leave that for now.",
      model: null,
    };
  if (mode === "direct") {
    const direct = directExtract({ profile: working, template, field, answer: text });
    const { profile, accepted, rejected } = applyExtracted(working, direct, context);
    return { working: profile, accepted, rejected, rationale: FIRST_RATIONALE, model: null };
  }
  const model = await extractWithModel(
    { profile: working, template, field, answer: text },
    generate,
    nowIso,
  );
  const { profile, accepted, rejected } = applyExtracted(working, model.extracted, context);
  const rationale = groundedOr(model.rationale, "", FIRST_RATIONALE);
  return { working: profile, accepted, rejected, rationale, model };
}

const isOpening = (mode, answer) => mode === "opening" && typeof answer === "string";

function readGiven({ working, template, field, answer, mode, nowIso }, generate) {
  const nothing = { working, accepted: [], rejected: [], rationale: FIRST_RATIONALE, model: null };
  if (typeof answer !== "string") return nothing;
  if (isOpening(mode, answer)) return readOpening({ working, template, answer, nowIso }, generate);
  return field
    ? readFieldAnswer({ working, template, field, answer, mode, nowIso }, generate)
    : nothing;
}

/**
 * Takes the user's answer to the current intake question, updates the EventProfile and returns the
 * next question. Which field is next, guest-count confirmation and all parsing are done in code;
 * the model only reads free text and words the next question. The caller stores the new profile.
 * @param {{profile: object, template: object, answer?: string, mode?: "opening" | "direct",
 *   nowIso?: string}} input The profile so far, the event template, the answer (omit it to get the
 *   first question), how it was given, and the current time. "opening" is a free description of the
 *   whole event; "direct" is a tapped or picked answer, which needs no model.
 * @param {{generate?: Function}} [deps] The model call, replaceable in tests.
 * @returns {Promise<{nextQuestion: string, feedback: string, field: string | null, options: string[],
 *   remaining: number, heard: string[], extracted: object, rejected: object[], complete: boolean,
 *   rationale: string, profile: object}>} The result.
 */
export async function nextStep(
  { profile, template, answer, mode, nowIso = new Date().toISOString() },
  { generate = realGenerate } = {},
) {
  const field = missingProfileFields(profile)[0] ?? null;
  const opening = isOpening(mode, answer);
  const read = await readGiven(
    { working: structuredClone(profile), template, field, answer, mode, nowIso },
    generate,
  );
  const { accepted, rejected, rationale, model } = read;

  const working = settle(read.working);
  const missing = missingProfileFields(working);
  const nextField = missing[0] ?? null;
  const complete = nextField === null;
  const progressed = accepted.length > 0 || answer === undefined || opening;
  return {
    nextQuestion: complete
      ? ALL_ANSWERED
      : chooseQuestion({ working, template, nextField, model, rejected, progressed }),
    feedback: complete ? "" : feedbackFor({ rejected, progressed }),
    field: nextField,
    options: complete ? [] : optionsFor(nextField, working, template),
    remaining: missing.length,
    heard: opening ? accepted : [],
    extracted: Object.fromEntries(accepted.map((key) => [key, valueOf(working, key)])),
    rejected,
    complete,
    rationale,
    profile: working,
  };
}
