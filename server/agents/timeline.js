import { ackStatus } from "../core/directives.js";
import { flagAtRisk } from "../core/timelinePlanner.js";
import {
  agentPrompt,
  generate as realGenerate,
  generateOrDemo,
  wrapUntrusted,
} from "../llm/index.js";
import { groundedOr, isGrounded } from "./grounded.js";
import { digestOutput, reminderOutput, taskWordsOutput } from "./schemas.js";

/** "12 Mar" style date for short lists. */
const shortDate = (iso) =>
  new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });

const DAY_MS = 86400000;
const WEEK_DAYS = 7;

const frame = (job, rule) =>
  agentPrompt({
    role: `You are the Timeline agent of Huddle, a calm, practical event planner. ${job}`,
    steps: [
      "understand the request",
      "check the event profile",
      "use only the facts you are given",
      "write the output",
    ],
    rules: [rule, "Never invent a date, count or name."],
  });

async function ask({ system, content, schema, demo, generate }) {
  const { data } = await generateOrDemo(generate, {
    agent: "timeline",
    system,
    messages: [{ role: "user", content }],
    schema,
    demo,
  });
  return data;
}

/**
 * Rewords milestone task titles to fit this event. Dates, owners and status stay as they are.
 * @param {{profile: object, tasks: object[]}} input The profile and the planned tasks.
 * @param {{generate?: Function}} [deps] The model call, replaceable in tests.
 * @returns {Promise<{tasks: object[], rationale: string}>} The tasks with new titles where the
 *   model's wording was safe (known id, no invented numbers).
 */
export async function wordTasks({ profile, tasks }, { generate = realGenerate } = {}) {
  const demo = async () => ({
    tasks: tasks.map(({ id, title }) => ({ id, title })),
    rationale: "Task titles are unchanged.",
  });
  const content = wrapUntrusted(
    "tasks",
    JSON.stringify({
      event: profile.name,
      purpose: profile.purpose,
      tasks: tasks.map(({ id, title }) => ({ id, title })),
    }),
  );
  const system = frame(
    "You reword task titles so they fit this event while keeping their meaning.",
    "Return every task id once with a short, plain title.",
  );
  const data = await ask({ system, content, schema: taskWordsOutput, demo, generate });
  const allowed = `${tasks.map(({ title }) => title).join(" ")} ${profile.name}`;
  const wording = new Map(data.tasks.map(({ id, title }) => [id, title.trim()]));
  return {
    tasks: tasks.map((task) => {
      const title = wording.get(task.id);
      return title && isGrounded(title, allowed) ? { ...task, title } : { ...task };
    }),
    rationale: groundedOr(data.rationale, ""),
  };
}

function digestFacts({ tasks, directives, members, nowIso }) {
  const today = Math.floor(Date.parse(nowIso) / DAY_MS);
  const fresh = flagAtRisk(tasks, nowIso);
  const open = fresh.filter((task) => task.status === "todo");
  const soon = open.filter((task) => {
    const day = Math.floor(Date.parse(task.dueDate) / DAY_MS);
    return day >= today && day < today + WEEK_DAYS;
  });
  const lines = [];
  if (soon.length)
    lines.push(
      `Due this week: ${soon.map((t) => `${t.title} (${shortDate(t.dueDate)})`).join("; ")}.`,
    );
  const risky = open.filter((task) => task.atRisk);
  if (risky.length)
    lines.push(
      `At risk: ${risky.map((t) => `${t.title} (due ${shortDate(t.dueDate)})`).join("; ")}.`,
    );
  const waiting = new Map();
  for (const directive of directives) {
    for (const id of ackStatus(directive, members).pending)
      waiting.set(id, (waiting.get(id) ?? 0) + 1);
  }
  const names = members
    .filter(({ id }) => waiting.has(id))
    .map(({ id, name }) => `${name} (${waiting.get(id)})`);
  if (names.length) lines.push(`Waiting for a "Got it": ${names.join(", ")}.`);
  return lines.length
    ? lines
    : ["Nothing is due this week, nothing is at risk and everyone has acknowledged."];
}

/**
 * Writes the daily digest: what is due, what is at risk and who hasn't acknowledged. The facts
 * come from code; the model adds a short friendly opening, kept only if it invents no number.
 * @param {{profile: object, tasks: object[], directives?: object[], members?: object[],
 *   nowIso?: string}} input The plan and who is on it.
 * @param {{generate?: Function}} [deps] The model call, replaceable in tests.
 * @returns {Promise<{digestText: string, rationale: string}>} The digest.
 */
export async function digest(
  { profile, tasks, directives = [], members = [], nowIso = new Date().toISOString() },
  { generate = realGenerate } = {},
) {
  const facts = digestFacts({ tasks, directives, members, nowIso });
  const demo = async () => ({
    digestText: "Here is today's summary.",
    rationale: "A routine summary.",
  });
  const system = frame(
    "You write one or two friendly sentences to open the daily digest. The facts are added after your text.",
    "Do not repeat the facts and do not use any numbers.",
  );
  const content = wrapUntrusted("digest facts", `${profile.name}\n${facts.join("\n")}`);
  const data = await ask({ system, content, schema: digestOutput, demo, generate });
  const intro = groundedOr(data.digestText, facts.join(" "), "Here is today's summary.");
  return { digestText: [intro, ...facts].join("\n"), rationale: groundedOr(data.rationale, "") };
}

/**
 * Writes the reminder posted when a directive has gone unacknowledged. Every pending person is
 * mentioned by code, whatever the model wrote.
 * @param {{directiveText: string, pendingNames: string[]}} input The directive and who hasn't tapped "Got it".
 * @param {{generate?: Function}} [deps] The model call, replaceable in tests.
 * @returns {Promise<{reminderText: string, rationale: string}>} The reminder.
 */
export async function reminder({ directiveText, pendingNames }, { generate = realGenerate } = {}) {
  const mentions = pendingNames.map((name) => `@${name}`);
  const demo = async () => ({
    reminderText: "A quick reminder to tap Got it on this.",
    rationale: "A routine reminder.",
  });
  const system = frame(
    "You write a short, friendly reminder asking people to tap Got it on a directive.",
    "One or two sentences. Do not use numbers.",
  );
  const content = [
    `People: ${mentions.join(", ")}`,
    wrapUntrusted("directive", directiveText),
  ].join("\n");
  const data = await ask({ system, content, schema: reminderOutput, demo, generate });
  const body = groundedOr(
    data.reminderText,
    directiveText,
    "A quick reminder to tap Got it on this.",
  );
  const missing = mentions.filter((mention) => !body.includes(mention));
  const text = [...missing, body].join(" ");
  return {
    reminderText: `${text}\n"${directiveText.slice(0, 200)}"`,
    rationale: groundedOr(data.rationale, ""),
  };
}
