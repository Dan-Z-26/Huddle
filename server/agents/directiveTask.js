import { parseDueDate } from "../core/dateText.js";
import { groupsForCategory } from "../core/templates.js";
import {
  agentPrompt,
  generate as realGenerate,
  generateOrDemo,
  wrapUntrusted,
} from "../llm/index.js";
import { categoriesMentioned } from "./discoveryDemo.js";
import { groundedOr, isGrounded } from "./grounded.js";
import { directiveTaskOutput } from "./schemas.js";

const MAX_TEXT = 1000;
const DEFAULT_DUE_DAYS = 2;
const DAY_MS = 86400000;

const TASK_SYSTEM = agentPrompt({
  role: "You are Planner. You turn a manager's directive into one timeline task title, and pick which group owns it.",
  steps: ["read the directive", "write a short task title", "pick the owning group"],
  rules: [
    "The title is a short imperative sentence using only words and numbers from the directive.",
    "ownerGroupSlug must be one of the group slugs listed.",
  ],
});

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
  const demo = () => ({
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
    isGrounded(data.title, text) && data.title.trim() ? data.title.trim() : demo().title;
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
