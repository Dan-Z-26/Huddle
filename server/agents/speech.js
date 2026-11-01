/** Words what an AI member says in a room, from facts code supplies. */
import { mentionsMoney } from "../core/amount.js";
import {
  agentPrompt,
  generate as realGenerate,
  generateOrDemo,
  wrapUntrusted,
} from "../llm/index.js";
import { groundedOr } from "./grounded.js";
import { linesOutput, speechOutput } from "./schemas.js";

const SYSTEM = agentPrompt({
  role:
    "You speak for one of Huddle's AI team members in a team chat for an event. You are warm, " +
    "brief and practical, like an experienced event planner who knows this team.",
  steps: [
    "read the situation and the facts",
    "decide what the people in this room need to know",
    "write it in your own words, for this event and these people",
  ],
  rules: [
    "One to three short sentences. Don't copy the facts word for word, and don't sound like a template.",
    "Use only the facts. Never add a number, date, name or promise that isn't in them.",
    "Keep any step someone has to take, and where to take it, exactly as useful as in the facts.",
    "Never write an amount of money or mention the total budget.",
  ],
});

const LINES_SYSTEM = agentPrompt({
  role: "You are Planner in Huddle. You rewrite your opening lines for each of an event's rooms.",
  steps: ["read the event", "read each line", "rewrite each one for this event"],
  rules: [
    "Return exactly as many lines as you were given, in the same order.",
    "Keep what each line tells people, including any mention of @huddle. One or two short sentences.",
    "Use only the facts given. Never write a number or an amount of money.",
  ],
});

/**
 * Words what an AI member says in a room. Code decides that it happens, who hears it and every fact
 * in it; the model only says it, so it reads as written for this event and not as a template.
 * @param {{agent: string, situation: string, facts: string[], fallback: string}} input Which member
 *   speaks, what just happened, the facts it may use, and what to say when the model can't.
 * @param {{generate?: Function}} [deps] The model call, replaceable in tests.
 * @returns {Promise<{wording: string, rationale: string}>} The words. Anything that strays from the
 *   facts or holds an amount becomes the fallback.
 */
export async function speak(
  { agent, situation, facts, fallback },
  { generate = realGenerate } = {},
) {
  const allowed = [...facts, fallback].join(" ");
  const { data } = await generateOrDemo(generate, {
    agent: "notices",
    system: SYSTEM,
    messages: [
      {
        role: "user",
        content: [
          `You are the ${agent} agent. Situation: ${situation}`,
          wrapUntrusted("facts", facts.join("\n")),
        ].join("\n"),
      },
    ],
    schema: speechOutput,
    demo: () => ({ wording: fallback, rationale: "" }),
  });
  const wording = groundedOr(data.wording, allowed, fallback);
  return {
    wording: mentionsMoney(wording) ? fallback : wording,
    rationale: groundedOr(data.rationale, allowed, ""),
  };
}

/**
 * Rewrites several of Planner's lines for one event in a single model call.
 * @param {{lines: string[], context: string}} input The lines and what is known about the event.
 * @param {{generate?: Function}} [deps] The model call, replaceable in tests.
 * @returns {Promise<string[]>} The same number of lines; any that strayed stay as they were.
 */
export async function rewordLines({ lines, context }, { generate = realGenerate } = {}) {
  const { data } = await generateOrDemo(generate, {
    agent: "notices",
    system: LINES_SYSTEM,
    messages: [
      {
        role: "user",
        content: [wrapUntrusted("event", context), wrapUntrusted("lines", lines.join("\n"))].join(
          "\n",
        ),
      },
    ],
    schema: linesOutput,
    demo: () => ({ lines }),
  });
  if (data.lines?.length !== lines.length) return lines;
  return lines.map((line, index) => {
    const worded = groundedOr(data.lines[index], `${context} ${line}`, line);
    return mentionsMoney(worded) ? line : worded;
  });
}
