import { randomUUID } from "node:crypto";
import { mentionsMoney } from "../core/amount.js";
import { buildBudgetState, emptyProfile } from "../core/profile.js";
import { getTemplate } from "../core/templates.js";
import { planTimeline } from "../core/timelinePlanner.js";
import { messageView } from "../routes/views.js";

/**
 * Creates an event and its seeded people (the manager, the core roles and the four AI members).
 * Groups are created later, when intake is confirmed.
 * @param {object} store The store.
 * @param {{eventType: string, id?: string, profile?: object}} input Event type, and optionally a
 *   fixed id and a ready profile (used by the demo seed).
 * @returns {{event: object, users: object[]}} The new EventProfile and its users.
 */
export function createEvent(store, { eventType, id = randomUUID().slice(0, 8), profile }) {
  const template = getTemplate(eventType);
  const event = profile ?? emptyProfile(eventType, id);
  store.events.set(event.id, event);
  const users = template.seedUsers.map((seed) => ({
    ...seed,
    id: `${seed.id}@${event.id}`,
    eventId: event.id,
  }));
  for (const user of users) store.users.set(user.id, user);
  return { event, users };
}

/**
 * Builds the workspace once intake is complete: groups from the template, the budget, the
 * backward-planned timeline, and a welcome post from the Planner in #announcements.
 * @param {object} store The store.
 * @param {object} event A profile with a confirmed guest count and a date.
 * @param {string} nowIso The current time.
 * @returns {{groups: object[], tasks: object[]}} What was created.
 */
export function createWorkspace(store, event, nowIso) {
  const template = getTemplate(event.eventType);
  const groups = template.groups.map((group) => ({
    id: `g-${event.id}-${group.slug}`,
    eventId: event.id,
    slug: group.slug,
    name: group.name,
    kind: group.kind,
    memberRoleIds: group.memberRoleIds,
    categoryIds: group.categoryIds,
  }));
  for (const group of groups) store.groups.set(group.id, group);

  const groupIdBySlug = Object.fromEntries(groups.map(({ slug, id }) => [slug, id]));
  const tasks = planTimeline(event.date, template.milestones, nowIso, groupIdBySlug).map(
    (task) => ({
      ...task,
      id: `${event.id}-${task.id}`,
      eventId: event.id,
    }),
  );
  for (const task of tasks) store.tasks.set(task.id, task);

  store.budgets.set(event.id, buildBudgetState(event, template));
  event.intakeStatus = "confirmed";

  const announcements = groups.find(({ kind }) => kind === "announcements");
  postAgentMessage(store, {
    groupId: announcements.id,
    authorId: `agent-planner@${event.id}`,
    text: `Welcome to ${mentionsMoney(event.name) ? "your event" : event.name}. I've set up your groups, budget and timeline. Ask me anything with @huddle.`,
    rationale: "Created from your answers and the event-type template.",
    nowIso,
  });
  return { groups, tasks };
}

const MAX_MESSAGES_PER_GROUP = 300;

/**
 * Stores a message and tells everyone in the group who is connected. Each group keeps its latest
 * messages only, so a busy room can't fill memory.
 * @param {object} store The store.
 * @param {object} message A complete message.
 * @returns {object} The stored message.
 */
export function addMessage(store, message) {
  store.messages.set(message.id, message);
  const inGroup = [...store.messages.values()].filter(({ groupId }) => groupId === message.groupId);
  for (const old of inGroup.slice(0, Math.max(0, inGroup.length - MAX_MESSAGES_PER_GROUP)))
    store.messages.delete(old.id);
  const group = store.groups.get(message.groupId);
  if (group) {
    store.publish({
      type: message.authorKind === "system" ? "notice.created" : "message.created",
      eventId: group.eventId,
      groupId: group.id,
      message: messageView(store, message),
    });
  }
  return message;
}

/**
 * Stores a message from an AI member, or a system notice with `authorKind: "system"`.
 * @param {object} store The store.
 * @param {{groupId: string, authorId: string, authorKind?: string, text: string,
 *   rationale?: string | null, nowIso: string}} message The message.
 * @returns {object} The stored message.
 */
export function postAgentMessage(
  store,
  { groupId, authorId, authorKind = "agent", text, rationale = null, nowIso },
) {
  return addMessage(store, {
    id: `m-${randomUUID().slice(0, 8)}`,
    groupId,
    authorId,
    authorKind,
    text,
    fileIds: [],
    createdAt: nowIso,
    rationale,
  });
}

/**
 * Removes an event and everything that belongs to it.
 * @param {object} store The store.
 * @param {string} eventId The event.
 */
export function deleteEvent(store, eventId) {
  const groupIds = new Set(
    [...store.groups.values()].filter((group) => group.eventId === eventId).map(({ id }) => id),
  );
  const inGroup = ({ groupId }) => groupIds.has(groupId);
  const inEvent = (item) => item.eventId === eventId;
  for (const [map, belongs] of [
    [store.users, inEvent],
    [store.tasks, inEvent],
    [store.quotes, inEvent],
    [store.pendingChanges, inEvent],
    [store.groups, inEvent],
    [store.messages, inGroup],
    [store.directives, inGroup],
    [store.files, inGroup],
  ]) {
    for (const [key, item] of map) if (belongs(item)) map.delete(key);
  }
  for (const keyed of [store.digests, store.rfqPosted])
    for (const key of keyed.keys()) if (key.startsWith(`${eventId}:`)) keyed.delete(key);
  store.budgets.delete(eventId);
  store.events.delete(eventId);
}

/**
 * Removes a group with its messages, directives and files. Tasks it owned move to #core-team.
 * @param {object} store The store.
 * @param {object} group The group.
 * @returns {object[]} The removed file records, so the caller can delete them from disk.
 */
export function deleteGroup(store, group) {
  const home = store.groups.get(`g-${group.eventId}-core-team`);
  for (const task of store.tasks.values()) {
    if (task.ownerGroupId === group.id) task.ownerGroupId = home?.id ?? null;
  }
  const files = [...store.files.values()].filter(({ groupId }) => groupId === group.id);
  for (const [map, key, item] of [
    ...[...store.messages].map(([k, v]) => [store.messages, k, v]),
    ...[...store.directives].map(([k, v]) => [store.directives, k, v]),
    ...[...store.files].map(([k, v]) => [store.files, k, v]),
  ]) {
    if (item.groupId === group.id) map.delete(key);
  }
  store.groups.delete(group.id);
  return files;
}
