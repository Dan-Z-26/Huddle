import { randomUUID } from "node:crypto";
import { mentionsMoney } from "../core/amount.js";
import { buildBudgetState, emptyProfile } from "../core/profile.js";
import { getTemplate } from "../core/templates.js";
import { planTimeline } from "../core/timelinePlanner.js";

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
  const message = {
    id: `m-${randomUUID().slice(0, 8)}`,
    groupId,
    authorId,
    authorKind,
    text,
    fileIds: [],
    createdAt: nowIso,
    rationale,
  };
  store.messages.set(message.id, message);
  return message;
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
  for (const key of store.digests.keys())
    if (key.startsWith(`${eventId}:`)) store.digests.delete(key);
  store.budgets.delete(eventId);
  store.events.delete(eventId);
}
