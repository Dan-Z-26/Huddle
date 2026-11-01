/** Who may see and do what. Anything unrecognised is denied. */

/**
 * Checks whether a role, or a person, is the event manager.
 * @param {{kind: string}} role Asker's role.
 * @returns {boolean} True for the manager only.
 */
export const isManager = (role) => role?.kind === "manager";

const hasEntry = (list, value) => Array.isArray(list) && value != null && list.includes(value);
const isMember = (role, group) => hasEntry(role?.groupIds, group?.id);
// Roles never reach into another event, not even the manager's.
const inSameEvent = (role, group) => role?.eventId != null && role.eventId === group?.eventId;
const handlesCategory = (role, categoryId) => hasEntry(role?.categoryIds, categoryId);
const ownsRoom = (role, group) =>
  (group.categoryIds ?? []).some((categoryId) => handlesCategory(role, categoryId));

/**
 * Checks whether a role can view a group, a file, the quotes or the comparison matrix.
 * @param {{kind: string, eventId: string, groupIds: string[]}} role Asker's role.
 * @param {{type: string, group?: object}} resource Resource; files carry their group.
 * @returns {boolean} True when allowed; anything unrecognised is denied.
 */
export function canView(role, resource) {
  const type = resource?.type;
  if (type === "group" || type === "file")
    return inSameEvent(role, resource.group) && (isManager(role) || isMember(role, resource.group));
  if (type === "quotes" || type === "comparison") return isManager(role) || role?.kind === "core";
  return false;
}

/**
 * Checks whether a role can post in a group.
 * @param {{kind: string, eventId: string, groupIds: string[], categoryIds: string[]}} role Asker's role.
 * @param {{id: string, eventId: string, kind: string, categoryIds: string[]}} group Target group.
 * @returns {boolean} True when allowed.
 */
export function canPost(role, group) {
  if (!inSameEvent(role, group)) return false;
  const { kind } = role;
  if (kind === "manager" || kind === "agent") return true;
  if (kind === "vendor") return isMember(role, group);
  if (kind !== "core" || !isMember(role, group) || group.kind === "announcements") return false;
  return group.kind !== "category" || ownsRoom(role, group);
}

/**
 * Checks whether a role can see the total budget or one category's budget.
 * @param {{kind: string, categoryIds: string[]}} role Asker's role.
 * @param {"total" | {categoryId: string}} scope Budget scope.
 * @returns {boolean} True when allowed; agents are always denied.
 */
export function canSeeBudget(role, scope) {
  if (isManager(role)) return scope === "total" || Boolean(scope?.categoryId);
  return role?.kind === "core" && handlesCategory(role, scope?.categoryId);
}

/**
 * Checks whether a role can mark a message as a directive.
 * @param {{kind: string}} role Asker's role.
 * @returns {boolean} True for the manager only.
 */
export function canMarkDirective(role) {
  return isManager(role);
}

/**
 * Checks whether a role can create, rename or remove groups and their members.
 * @param {{kind: string}} role Asker's role.
 * @returns {boolean} True for the manager only.
 */
export function canManageGroups(role) {
  return isManager(role);
}

/**
 * Checks whether a role works on a category's vendors: the manager, and core members who own it.
 * @param {{kind: string, categoryIds?: string[]}} role Asker's role.
 * @param {string} categoryId The category.
 * @returns {boolean} True when allowed.
 */
export const mayWorkOn = (role, categoryId) =>
  isManager(role) || (role?.kind === "core" && handlesCategory(role, categoryId));
