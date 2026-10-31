import { birthday } from "./templates/birthday.js";
import { community } from "./templates/community.js";
import { corporateLaunch } from "./templates/corporateLaunch.js";
import { wedding } from "./templates/wedding.js";

const TEMPLATES = new Map(
  [corporateLaunch, wedding, birthday, community].map((template) => [template.eventType, template]),
);

/**
 * Returns a private copy of an event type's template.
 * @param {string} eventType corporate_launch, wedding, birthday or community.
 * @returns {{eventType: string, label: string, categories: object[], roles: object[],
 *   groups: object[], categoryGroupMap: Record<string, string[]>, milestones: object[],
 *   seedUsers: object[]}} The template.
 * @throws {RangeError} When the event type is unknown.
 */
export function getTemplate(eventType) {
  const template = TEMPLATES.get(eventType);
  if (!template) throw new RangeError(`unknown event type: ${eventType}`);
  return structuredClone(template);
}

/**
 * Lists the supported event types.
 * @returns {Array<{eventType: string, label: string}>} Types and display labels.
 */
export function listEventTypes() {
  return [...TEMPLATES.values()].map(({ eventType, label }) => ({ eventType, label }));
}

/**
 * Looks up which groups hear about a change to a category.
 * @param {Record<string, string[]>} categoryGroupMap A template's map.
 * @param {string} categoryId Category.
 * @returns {string[]} Group slugs; falls back to ["core-team"].
 */
export function groupsForCategory(categoryGroupMap, categoryId) {
  const slugs = Object.hasOwn(categoryGroupMap, categoryId) ? categoryGroupMap[categoryId] : [];
  return slugs.length > 0 ? [...slugs] : ["core-team"];
}
