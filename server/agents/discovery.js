import { z } from "zod";
import { generate as realGenerate, UNTRUSTED_RULE, wrapUntrusted } from "../llm/index.js";
import { missingProfileFields } from "../core/profile.js";
import { demoExtract } from "./discoveryDemo.js";
import { applyExtracted, resolveGuests } from "./profileMerge.js";
import { guestConfirmation, questionFor } from "./questions.js";
import { discoveryOutput } from "./schemas.js";
import { buildTools } from "./tools.js";

const SKIPPABLE = new Set(["mustHaves", "absoluteMustHave", "constraints", "vendorNeeds"]);
const NONE = /^\s*(?:none|no|nothing|nope|nil|n\/a|skip|not really)\b/i;
const MAX_ANSWER = 2000;
const INTAKE_TOOLS = new Set(["parse_guest_count", "missing_profile_fields"]);

const SYSTEM = `You are the Discovery agent of Huddle, a warm, practical event planner who listens. You help an organiser describe their event, one question at a time. A good event fits the organiser, the planner and the guests; it is not the most expensive one.
Work privately in these steps and never show them: understand the answer -> check the profile and constraints so far -> check the priorities and must-haves -> use a tool for any number you need -> use only tool results -> write the output.
Rules:
- Extract only what the user actually said. Never invent values and never do arithmetic.
- Copy dates and money exactly as the user wrote them (date, budgetText, guestText); code parses them.
- Priorities: only the category ids you are given, in exactly the order the user ranked them. Never assume a ranking.
- If the user says none or skip for an optional field, set skipped to true.
- Set nextField to the first field in the missing list that is still unanswered after this answer, and write nextQuestion as one short, friendly question about that field only.
Return ONLY JSON matching the schema, with a one-sentence rationale for the user.
${UNTRUSTED_RULE}`;

function summarise(profile) {
  const { guests, budget, mustHaves, constraints, vendorNeeds, priorities } = profile;
  const filled = ["name", "purpose", "date", "city", "venueType", "attendeeExperience"]
    .filter((key) => profile[key])
    .map((key) => [key, profile[key]]);
  return JSON.stringify({
    ...Object.fromEntries(filled),
    guests: guests.confirmed ?? (guests.max ? `${guests.min}-${guests.max}` : undefined),
    budget: budget.totalMinor ? "set" : undefined,
    priorities,
    mustHaves: mustHaves.map(({ text }) => text),
    constraints,
    vendorNeeds,
  });
}

function buildMessage({ profile, template, field, answer, missing }) {
  const categories = template.categories.map(({ id, name, tiers }) => ({
    id,
    name,
    tiers: tiers.map((tier) => tier.id),
  }));
  return [
    `Event type: ${template.eventType}`,
    `Field being answered: ${field}`,
    `Missing fields in order: ${missing.join(", ")}`,
    `Categories: ${JSON.stringify(categories)}`,
    wrapUntrusted("profile so far", summarise(profile)),
    wrapUntrusted("user answer", answer),
  ].join("\n");
}

async function extractWithModel(input, generate, nowIso) {
  const { profile, template } = input;
  const demoOutput = () => ({
    extracted: demoExtract(input),
    rationale: "I read your answer with simple rules.",
  });
  const tools = buildTools({
    actor: { kind: "manager", eventId: profile.id },
    profile,
    template,
    nowIso,
  }).filter(({ name }) => INTAKE_TOOLS.has(name));
  try {
    const { data } = await generate({
      agent: "discovery",
      system: SYSTEM,
      messages: [
        {
          role: "user",
          content: buildMessage({ ...input, missing: missingProfileFields(profile) }),
        },
      ],
      schema: discoveryOutput,
      tools,
      demo: async () => discoveryOutput.parse(demoOutput()),
    });
    return data;
  } catch (err) {
    if (err.name === "LlmError" || err instanceof z.ZodError)
      return discoveryOutput.parse(demoOutput());
    throw err;
  }
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
  const base = questionFor(nextField, working, template);
  if (nextField === "guests") {
    const waiting = working.guests.suggested > 0 && working.guests.confirmed === null;
    return waiting ? guestConfirmation(working.guests) : base;
  }
  const usable = model?.nextField === nextField && model.nextQuestion?.trim();
  const question = usable ? model.nextQuestion.trim() : base;
  if (rejected.length) return `${rejected[0].reason}. ${base}`;
  return progressed ? question : `I didn't quite catch that. ${base}`;
}

const valueOf = (profile, key) =>
  key === "absoluteMustHave" ? profile.absoluteMustHaveId : profile[key];

/**
 * Takes the user's answer to the current intake question, updates the EventProfile and returns the
 * next question. Which field is next, guest-count confirmation and all parsing are done in code;
 * the model only reads free text and words the next question. The caller stores the new profile.
 * @param {{profile: object, template: object, answer?: string, nowIso?: string}} input The profile
 *   so far, the event template, the answer (omit it to get the first question) and the current time.
 * @param {{generate?: Function}} [deps] The model call, replaceable in tests.
 * @returns {Promise<{nextQuestion: string, field: string | null, extracted: object, rejected: object[],
 *   complete: boolean, rationale: string, profile: object}>} The result.
 */
export async function nextStep(
  { profile, template, answer, nowIso = new Date().toISOString() },
  { generate = realGenerate } = {},
) {
  const field = missingProfileFields(profile)[0] ?? null;
  let working = structuredClone(profile);
  let accepted = [];
  let rejected = [];
  let rationale = "Let's start with the basics.";
  let model = null;

  if (typeof answer === "string" && field) {
    const text = answer.slice(0, MAX_ANSWER);
    if (field === "guests") {
      const result = resolveGuests(working, text);
      working = result.profile;
      accepted = result.understood ? ["guests"] : [];
      rationale = result.understood
        ? "Noted your guest count."
        : "I couldn't find a guest number in that.";
    } else if (SKIPPABLE.has(field) && NONE.test(text)) {
      working.skippedFields = [...new Set([...working.skippedFields, field])];
      accepted = [field];
      rationale = "Okay, we'll leave that for now.";
    } else {
      model = await extractWithModel(
        { profile: working, template, field, answer: text },
        generate,
        nowIso,
      );
      ({
        profile: working,
        accepted,
        rejected,
      } = applyExtracted(working, model.extracted, { template, nowIso }));
      rationale = model.rationale;
    }
  }

  working = settle(working);
  const missing = missingProfileFields(working);
  const nextField = missing[0] ?? null;
  const complete = nextField === null;
  const nextQuestion = complete
    ? "That's everything I need. Check the summary and confirm to create your workspace."
    : chooseQuestion({
        working,
        template,
        nextField,
        model,
        rejected,
        progressed: accepted.length > 0 || answer === undefined,
      });
  const extracted = Object.fromEntries(accepted.map((key) => [key, valueOf(working, key)]));
  return {
    nextQuestion,
    field: nextField,
    extracted,
    rejected,
    complete,
    rationale,
    profile: working,
  };
}
