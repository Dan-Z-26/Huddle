import { mentionsMoney } from "../core/amount.js";
import { ackStatus } from "../core/directives.js";
import { canSeeBudget } from "../core/permissions.js";

const HIDDEN = "(contains an amount; visible to the event manager)";
const noMoney = (text) => (mentionsMoney(text) ? HIDDEN : text);

/** What a client may know about a person. */
export const publicUser = ({ id, name, roleId, kind }) => ({ id, name, roleId, kind });

/**
 * The profile as a user may see it. Only the manager gets the total budget and the ranking: a
 * category's opening amount follows from its rank, so rank plus amount would reveal the total.
 * Others also lose other categories' needs and any amount typed into shared text.
 * @param {object} event The EventProfile.
 * @param {object} role The asker's role object.
 * @returns {object} The profile to show.
 */
export function profileFor(event, role) {
  if (canSeeBudget(role, "total")) return event;
  const rest = { ...event };
  delete rest.budget;
  delete rest.priorities;
  const owns = (categoryId) => role.categoryIds.includes(categoryId);
  return {
    ...rest,
    name: noMoney(event.name),
    purpose: noMoney(event.purpose),
    city: noMoney(event.city),
    venueType: noMoney(event.venueType),
    attendeeExperience: noMoney(event.attendeeExperience),
    mustHaves: event.mustHaves
      .filter(({ categoryId }) => !categoryId || owns(categoryId))
      .map((item) => (item.categoryId ? item : { ...item, text: noMoney(item.text) })),
    constraints: Object.fromEntries(
      Object.entries(event.constraints).map(([key, items]) => [key, items.map(noMoney)]),
    ),
    vendorNeeds: Object.fromEntries(
      Object.entries(event.vendorNeeds).filter(([categoryId]) => owns(categoryId)),
    ),
  };
}

/**
 * The people who are in a group: its human members. AI members are not counted.
 * @param {object} store The store.
 * @param {{eventId: string, memberRoleIds: string[]}} group The group.
 * @returns {object[]} Users.
 */
export function groupPeople(store, group) {
  return [...store.users.values()].filter(
    (user) =>
      user.eventId === group.eventId &&
      user.kind !== "agent" &&
      group.memberRoleIds.includes(user.roleId),
  );
}

/**
 * A directive with who has and hasn't acknowledged it. It is only ever sent to members of the
 * group it was posted in.
 * @param {object} store The store.
 * @param {object} directive The directive.
 * @returns {object} The directive and its acknowledgement status.
 */
export function directiveView(store, directive) {
  const group = store.groups.get(directive.groupId);
  return { ...directive, status: ackStatus(directive, groupPeople(store, group)) };
}

/**
 * A message with its attachments' names and, if it was pinned, its directive.
 * @param {object} store The store.
 * @param {object} message The message.
 * @returns {object} The message to send to a group member.
 */
export function messageView(store, message) {
  const directive = [...store.directives.values()].find(
    ({ messageId }) => messageId === message.id,
  );
  const files = (message.fileIds ?? [])
    .map((id) => store.files.get(id))
    .filter(Boolean)
    .map(({ id, originalName, mime, size }) => ({ id, name: originalName, mime, size }));
  return { ...message, files, directive: directive ? directiveView(store, directive) : null };
}
