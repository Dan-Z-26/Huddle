import { wholeMoney } from "../core/money.js";
import { groupsForCategory } from "../core/templates.js";
import {
  agentPrompt,
  generate as realGenerate,
  generateOrDemo,
  wrapUntrusted,
} from "../llm/index.js";
import { groundedOr } from "./grounded.js";
import { noticeOutput } from "./schemas.js";

const SYSTEM = agentPrompt({
  role:
    "You are Huddle's notice writer. You turn a few facts about a change into one short, " +
    "friendly, neutral message for a team group.",
  steps: [
    "read the facts",
    "decide what the group needs to know",
    "write the message using only those facts",
  ],
  rules: [
    "One or two sentences. Use only the facts and numbers given.",
    "Never mention a total budget, never recommend, never pressure.",
  ],
});

/**
 * Decides which groups hear about a change. Code only: each changed category is looked up in the
 * template's category-to-group map.
 * @param {{deltas: Array<{categoryId: string}>, categoryGroupMap: Record<string, string[]>}} input
 *   The categories whose cost changed, and the template's map.
 * @returns {Array<{slug: string, categoryIds: string[]}>} Each group to notify, with the changed
 *   categories it covers.
 */
export function noticeTargets({ deltas, categoryGroupMap }) {
  const targets = new Map();
  for (const { categoryId } of deltas) {
    for (const slug of groupsForCategory(categoryGroupMap, categoryId)) {
      targets.set(slug, [...(targets.get(slug) ?? []), categoryId]);
    }
  }
  return [...targets].map(([slug, categoryIds]) => ({ slug, categoryIds }));
}

/**
 * Whether a group may be told the amounts for these categories: every core member of the group
 * must own all of them. Fails closed for an unknown group.
 */
function mayShowCosts({ template, groupSlug, categoryIds, memberRoleIds }) {
  const members =
    memberRoleIds ?? template.groups.find(({ slug }) => slug === groupSlug)?.memberRoleIds;
  if (!members) return false;
  return template.roles
    .filter(({ id, kind }) => kind === "core" && members.includes(id))
    .every((role) => categoryIds.every((id) => role.categoryIds.includes(id)));
}

/**
 * Lists the facts one group may be told: the guest count if it changed, and the cost change of
 * the categories that group covers. The total budget and other categories' costs are never
 * included, and amounts are left out when some core member of the group doesn't own the category.
 * @param {{guests: {before: number, after: number} | null, deltas: object[], categoryIds: string[],
 *   groupSlug: string, template: object, currency: string, hideCosts?: boolean}} input The change,
 *   the group and its categories; `hideCosts` is set when a vendor is in the group, and
 *   `memberRoleIds` gives who is in it now, which the manager may have changed.
 * @returns {string[]} Plain-text facts.
 */
export function noticeFacts({
  guests,
  deltas,
  categoryIds,
  groupSlug,
  template,
  currency,
  hideCosts = false,
  memberRoleIds,
}) {
  const facts = [];
  if (guests && guests.before !== guests.after)
    facts.push(`Guest count is now ${guests.after} (it was ${guests.before}).`);
  // With a vendor in the room, even "this cost changed" says more than they need to know.
  if (hideCosts) return facts;
  const showCosts = mayShowCosts({ template, groupSlug, categoryIds, memberRoleIds });
  for (const delta of deltas.filter(({ categoryId }) => categoryIds.includes(categoryId))) {
    const name =
      template.categories.find(({ id }) => id === delta.categoryId)?.name ?? delta.categoryId;
    facts.push(
      showCosts
        ? `${name} cost changes from ${wholeMoney(delta.beforeMinor, currency)} to ${wholeMoney(delta.afterMinor, currency)}.`
        : `${name} cost has changed.`,
    );
  }
  return facts;
}

/**
 * Words a change notice for one group from the facts that group may see.
 * @param {{facts: string[], groupName: string}} input The facts and the group's name.
 * @param {{generate?: Function}} [deps] The model call, replaceable in tests.
 * @returns {Promise<{wording: string, rationale: string}>} The message; if the model's text uses a
 *   number that isn't in the facts, the plain facts are used instead.
 */
export async function word({ facts, groupName }, { generate = realGenerate } = {}) {
  const plain = `Update: ${facts.join(" ")}`;
  const demo = async () => ({
    wording: plain.slice(0, 400),
    rationale: "These are the changes that affect this group.",
  });
  const content = [
    wrapUntrusted("group", groupName),
    wrapUntrusted("facts", facts.join("\n")),
  ].join("\n");
  const { data } = await generateOrDemo(generate, {
    agent: "notices",
    system: SYSTEM,
    messages: [{ role: "user", content }],
    schema: noticeOutput,
    demo,
  });
  return {
    wording: groundedOr(data.wording, facts.join(" "), plain),
    rationale: groundedOr(data.rationale, ""),
  };
}
