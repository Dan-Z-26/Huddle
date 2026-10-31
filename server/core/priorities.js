/**
 * Cleans a user's ranking so it holds only known category ids, each once, in the user's order.
 * @param {string[]} ranking Category ids, highest priority first.
 * @param {string[]} categoryIds Ids that exist on this event.
 * @returns {string[]} The cleaned ranking.
 */
export function normalisePriorities(ranking, categoryIds) {
  if (!Array.isArray(ranking)) return [];
  return [...new Set(ranking)].filter((id) => categoryIds.includes(id));
}

/**
 * Looks up a category's 1-based rank in the user's priorities.
 * @param {string[]} priorities Category ids, highest priority first.
 * @param {string} categoryId Category to find.
 * @returns {number | null} The rank, or null when the category is unranked.
 */
export function rankOf(priorities, categoryId) {
  const index = priorities.indexOf(categoryId);
  return index === -1 ? null : index + 1;
}
