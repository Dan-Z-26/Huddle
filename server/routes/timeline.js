import { Router } from "express";
import { digest } from "../agents/timeline.js";
import { parseEventDate } from "../core/dateText.js";
import { canView } from "../core/permissions.js";
import { getTemplate } from "../core/templates.js";
import { flagAtRisk, replanTimeline } from "../core/timelinePlanner.js";
import { HttpError, managerOnly, ownEvent, requireBudget, requireUser, validate } from "../http.js";
import { postAgentMessage } from "../store/workspace.js";
import * as schemas from "../validation/schemas.js";
import { postSpoken } from "./agentPost.js";
import { vendorsOf } from "./hiringSupport.js";
import { categoryGroup } from "./vendorSupport.js";

const longDate = (iso) =>
  new Date(iso).toLocaleDateString("en-GB", { dateStyle: "long", timeZone: "UTC" });

const movedText = (date) =>
  `The event date has moved to ${longDate(date)}, and the timeline has been replanned.`;

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
 * Posts today's digest in Announcements, once a day per event. The promise is stored at once, so
 * two quick requests share one digest.
 * @param {object} store The store.
 * @param {object} event The event, with its workspace created.
 * @param {string} nowIso The current time.
 * @returns {Promise<object>} The posted message.
 */
export function postDigest(store, event, nowIso = new Date().toISOString()) {
  const key = `${event.id}:${nowIso.slice(0, 10)}`;
  if (!store.digests.has(key)) {
    const made = digest({
      profile: event,
      tasks: store.tasksForEvent(event.id),
      directives: store.directivesForEvent(event.id),
      members: [...store.users.values()].filter(
        ({ eventId, kind }) => eventId === event.id && kind !== "agent",
      ),
      nowIso,
    }).then(({ digestText, rationale }) =>
      postAgentMessage(store, {
        groupId: `g-${event.id}-announcements`,
        authorId: `agent-timeline@${event.id}`,
        text: digestText,
        rationale,
        digest: true,
        nowIso,
      }),
    );
    store.digests.set(
      key,
      made.catch((err) => {
        store.digests.delete(key);
        throw err;
      }),
    );
  }
  return store.digests.get(key);
}

/** Timeline, replanning, task status and the daily digest. */
export function timelineRoutes({ ai }) {
  const router = Router();

  router.get("/events/:id/timeline", requireUser, validate(schemas.eventParam), (req, res) => {
    const event = ownEvent(req);
    res.json({ tasks: timelineView(req.app.locals.store, event.id) });
  });

  router.post(
    "/events/:id/reschedule",
    requireUser,
    ai,
    validate(schemas.reschedule),
    (req, res) => {
      const { store } = req.app.locals;
      const event = managerOnly(req);
      requireBudget(store, event);
      const date = parseEventDate(req.valid.body.date);
      const nowIso = new Date().toISOString();
      if (!date)
        throw HttpError(400, "BAD_REQUEST", "Please give the full date, including the year.");
      if (date.slice(0, 10) < nowIso.slice(0, 10))
        throw HttpError(400, "BAD_REQUEST", "That date has already passed.");
      event.date = date;
      saveTasks(store, replanTimeline(store.tasksForEvent(event.id), date, nowIso));
      if (store.groups.has(`g-${event.id}-announcements`)) {
        postSpoken(store, {
          groupId: `g-${event.id}-announcements`,
          eventId: event.id,
          agent: "timeline",
          authorKind: "system",
          situation: "The event manager has just moved the date of the event.",
          facts: [movedText(date)],
          fallback: movedText(date),
          nowIso,
        });
      }
      // Booked vendors aren't in Announcements, and the date matters to them most of all.
      const template = getTemplate(event.eventType);
      for (const { categoryIds } of vendorsOf(store, event.id)) {
        postSpoken(store, {
          groupId: categoryGroup(store, event, template, categoryIds[0]).id,
          eventId: event.id,
          agent: "timeline",
          authorKind: "system",
          situation: "The event date has moved. A vendor booked for this event reads this room.",
          facts: [movedText(date)],
          fallback: movedText(date),
          nowIso,
        });
      }
      store.publish({ type: "timeline.updated", eventId: event.id });
      res.json({ event: { id: event.id, date }, tasks: timelineView(store, event.id) });
    },
  );

  // Anyone who can see the task's owner group can tick it off.
  router.patch("/tasks/:id", requireUser, validate(schemas.taskStatus), (req, res) => {
    const { store } = req.app.locals;
    const task = store.tasks.get(req.valid.params.id);
    if (!task || task.eventId !== req.user.eventId)
      throw HttpError(404, "NOT_FOUND", "No such task.");
    const group = store.groups.get(task.ownerGroupId);
    if (
      req.user.kind === "vendor" ||
      !group ||
      !canView(store.roleOf(req.user), { type: "group", group })
    )
      throw HttpError(403, "FORBIDDEN", "Only people in the owner group can update this task.");
    const [updated] = flagAtRisk(
      [{ ...task, status: req.valid.body.status }],
      new Date().toISOString(),
    );
    store.tasks.set(updated.id, updated);
    store.publish({ type: "timeline.updated", eventId: task.eventId });
    store.publish({ type: "attention.updated", eventId: task.eventId });
    res.json({ tasks: timelineView(store, task.eventId) });
  });

  router.post(
    "/events/:id/digest",
    requireUser,
    ai,
    validate(schemas.eventParam),
    async (req, res) => {
      const { store } = req.app.locals;
      const event = managerOnly(req);
      requireBudget(store, event);
      res.json({ message: await postDigest(store, event) });
    },
  );

  return router;
}
