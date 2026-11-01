/** The timeline: reading it, moving the event date, ticking off tasks, and the daily digest. */
import { Router } from "express";
import { parseEventDate } from "../core/dateText.js";
import { canView } from "../core/permissions.js";
import { dayOf } from "../core/time.js";
import { flagAtRisk } from "../core/timelinePlanner.js";
import {
  badRequest,
  forbidden,
  managerOnly,
  ownEvent,
  ownRecord,
  requireBudget,
  requireUser,
  validate,
} from "../http.js";
import * as schemas from "../validation/schemas.js";
import { moveEventDate, postDigest, timelineView } from "../workflows/timeline.js";

function getTimeline(req, res) {
  const event = ownEvent(req);
  res.json({ tasks: timelineView(req.app.locals.store, event.id) });
}

function reschedule(req, res) {
  const { store } = req.app.locals;
  const event = managerOnly(req);
  requireBudget(store, event);
  const date = parseEventDate(req.valid.body.date);
  const nowIso = new Date().toISOString();
  if (!date) throw badRequest("Please give the full date, including the year.");
  if (dayOf(date) < dayOf(nowIso)) throw badRequest("That date has already passed.");
  moveEventDate(store, event, date, nowIso);
  res.json({ event: { id: event.id, date }, tasks: timelineView(store, event.id) });
}

// Anyone who can see the task's owner group can tick it off.
function setTaskStatus(req, res) {
  const { store } = req.app.locals;
  const task = ownRecord(req, store.tasks, "task");
  const group = store.groups.get(task.ownerGroupId);
  const mayUpdate =
    req.user.kind !== "vendor" &&
    group &&
    canView(store.roleOf(req.user), { type: "group", group });
  if (!mayUpdate) throw forbidden("Only people in the owner group can update this task.");
  const [updated] = flagAtRisk(
    [{ ...task, status: req.valid.body.status }],
    new Date().toISOString(),
  );
  store.tasks.set(updated.id, updated);
  store.nudge(task.eventId, "timeline.updated", "attention.updated");
  res.json({ tasks: timelineView(store, task.eventId) });
}

async function postTodaysDigest(req, res) {
  const { store } = req.app.locals;
  const event = managerOnly(req);
  requireBudget(store, event);
  res.json({ message: await postDigest(store, event) });
}

/**
 * Timeline routes.
 * @param {{ai: import("express").RequestHandler}} limits The AI rate limit.
 * @returns {import("express").Router} The routes.
 */
export function timelineRoutes({ ai }) {
  const router = Router();
  router.get("/events/:id/timeline", requireUser, validate(schemas.idParam), getTimeline);
  router.post("/events/:id/reschedule", requireUser, ai, validate(schemas.reschedule), reschedule);
  router.patch("/tasks/:id", requireUser, validate(schemas.taskStatus), setTaskStatus);
  router.post("/events/:id/digest", requireUser, ai, validate(schemas.idParam), postTodaysDigest);
  return router;
}
