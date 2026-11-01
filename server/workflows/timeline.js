/** The shared timeline: what it shows, moving the event date, and the daily digest. */
import { digest } from "../agents/timeline.js";
import { getTemplate } from "../core/templates.js";
import { dayOf, longDate } from "../core/time.js";
import { flagAtRisk, replanTimeline } from "../core/timelinePlanner.js";
import { agentIdFor, ANNOUNCEMENTS, groupIdFor } from "../store/ids.js";
import { postAgentMessage } from "../store/workspace.js";
import { postSpoken } from "./agentPost.js";
import { vendorsOf } from "./booking.js";
import { categoryGroup } from "./vendors.js";

/**
 * Stores updated tasks.
 * @param {object} store The store.
 * @param {object[]} tasks The tasks.
 */
export function saveTasks(store, tasks) {
  for (const task of tasks) store.tasks.set(task.id, task);
}

/**
 * Tasks in date order, each with its owner group's name, which everyone on the event may see.
 * @param {object} store The store.
 * @param {string} eventId The event.
 * @returns {object[]} The tasks.
 */
export function timelineView(store, eventId) {
  // Risk depends on today's date, so it is worked out on reading; a stored flag goes stale overnight.
  return flagAtRisk(store.tasksForEvent(eventId), new Date().toISOString())
    .map((task) => ({
      ...task,
      ownerGroupName: store.groups.get(task.ownerGroupId)?.name ?? null,
    }))
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate));
}

/**
 * Moves the event date, replans the timeline, and tells Announcements and any booked vendors.
 * @param {object} store The store.
 * @param {object} event The event.
 * @param {string} date The new date, already validated.
 * @param {string} nowIso The current time.
 */
export function moveEventDate(store, event, date, nowIso) {
  event.date = date;
  saveTasks(store, replanTimeline(store.tasksForEvent(event.id), date, nowIso));
  const moved = `The event date has moved to ${longDate(date)}, and the timeline has been replanned.`;
  const tell = (groupId, situation) =>
    postSpoken(store, {
      groupId,
      eventId: event.id,
      agent: "timeline",
      authorKind: "system",
      situation,
      facts: [moved],
      nowIso,
    });
  const announcements = groupIdFor(event.id, ANNOUNCEMENTS);
  if (store.groups.has(announcements))
    tell(announcements, "The event manager has just moved the date of the event.");
  // Booked vendors aren't in Announcements, and the date matters to them most of all.
  const template = getTemplate(event.eventType);
  for (const { categoryIds } of vendorsOf(store, event.id))
    tell(
      categoryGroup(store, event, template, categoryIds[0]).id,
      "The event date has moved. A vendor booked for this event reads this room.",
    );
  store.nudge(event.id, "timeline.updated");
}

function writeDigest(store, event, nowIso) {
  return digest({
    profile: event,
    tasks: store.tasksForEvent(event.id),
    directives: store.directivesForEvent(event.id),
    members: [...store.users.values()].filter(
      ({ eventId, kind }) => eventId === event.id && kind !== "agent",
    ),
    nowIso,
  }).then(({ digestText, rationale }) =>
    postAgentMessage(store, {
      groupId: groupIdFor(event.id, ANNOUNCEMENTS),
      authorId: agentIdFor("timeline", event.id),
      text: digestText,
      rationale,
      digest: true,
      nowIso,
    }),
  );
}

/**
 * Posts today's digest in Announcements, once a day per event. The promise is stored at once, so
 * two quick requests share one digest.
 * @param {object} store The store.
 * @param {object} event The event, with its workspace created.
 * @param {string} nowIso The current time.
 * @returns {Promise<object>} The posted message.
 */
export function postDigest(store, event, nowIso = new Date().toISOString()) {
  const key = `${event.id}:${dayOf(nowIso)}`;
  if (!store.digests.has(key))
    store.digests.set(
      key,
      writeDigest(store, event, nowIso).catch((err) => {
        store.digests.delete(key);
        throw err;
      }),
    );
  return store.digests.get(key);
}
