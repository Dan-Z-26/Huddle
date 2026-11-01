/** Events: starting one, reading it as the asker may see it, editing it, advice and ideas. */
import { Router } from "express";
import { advise } from "../agents/advisor.js";
import { generateIdeas } from "../agents/ideas.js";
import { planningSignals } from "../core/signals.js";
import { getTemplate, listEventTypes } from "../core/templates.js";
import { HOUR_MS } from "../core/time.js";
import {
  badRequest,
  createLimiter,
  managerOnly,
  ownEvent,
  requireBudget,
  requireUser,
  startSession,
  validate,
} from "../http.js";
import { DEMO_EVENT_ID } from "../store/seed.js";
import { createEvent, deleteEvent, eventExpenses } from "../store/workspace.js";
import * as schemas from "../validation/schemas.js";
import { groupsFor, profileFor, publicUser } from "../views.js";
import { eventQuotes } from "../workflows/vendors.js";

const MAX_EVENTS = 50;
const NEW_EVENTS_PER_HOUR = 20;

// Replaces one rather than refusing, so nobody can block the demo for everyone. Unfinished ones go
// first, so a burst of new events can't push out an event somebody has set up.
function makeRoomForEvent(store) {
  if (store.events.size < MAX_EVENTS) return;
  const others = [...store.events.values()].filter(({ id }) => id !== DEMO_EVENT_ID);
  const spare = others.find(({ intakeStatus }) => intakeStatus === "in_progress") ?? others[0];
  deleteEvent(store, spare.id);
}

function listTypes(_req, res) {
  res.json({ eventTypes: listEventTypes() });
}

function startEvent(req, res) {
  const { store } = req.app.locals;
  makeRoomForEvent(store);
  const { event, users } = createEvent(store, { eventType: req.valid.body.eventType });
  const manager = users.find(({ kind }) => kind === "manager");
  startSession(res, store, manager.id);
  res.status(201).json({ event: profileFor(event, store.roleOf(manager)) });
}

// A vendor sees only their own category, and nothing of how the team is organised.
function templateView(template, user) {
  const isVendor = user.kind === "vendor";
  return {
    label: template.label,
    categories: template.categories
      .filter(({ id }) => !isVendor || user.categoryIds.includes(id))
      .map(({ id, name }) => ({ id, name })),
    roles: isVendor
      ? []
      : template.roles
          .filter(({ kind }) => kind !== "agent")
          .map(({ id, name, kind }) => ({ id, name, kind })),
  };
}

// A vendor sees the AI members and the people in their own group.
function membersFor(store, event, user, groups) {
  const inGroup = new Set(groups.flatMap(({ memberRoleIds }) => memberRoleIds));
  return [...store.users.values()]
    .filter(
      ({ eventId, roleId, kind }) =>
        eventId === event.id && (user.kind !== "vendor" || kind === "agent" || inGroup.has(roleId)),
    )
    .map(publicUser);
}

function getEvent(req, res) {
  const { store } = req.app.locals;
  const event = ownEvent(req, { vendorsToo: true });
  const groups = groupsFor(store, req.user);
  res.json({
    event: profileFor(event, store.roleOf(req.user)),
    template: templateView(getTemplate(event.eventType), req.user),
    groups,
    members: membersFor(store, event, req.user, groups),
  });
}

function patchProfile(req, res) {
  const event = managerOnly(req);
  Object.assign(event, req.valid.body);
  res.json({ event: profileFor(event, req.app.locals.store.roleOf(req.user)) });
}

async function getAdvice(req, res) {
  const { store } = req.app.locals;
  const event = managerOnly(req);
  const input = {
    profile: event,
    state: requireBudget(store, event),
    expenses: eventExpenses(store, event.id),
    tasks: store.tasksForEvent(event.id),
    quotes: eventQuotes(store, event.id),
    nowIso: new Date().toISOString(),
  };
  // The same signals give the same advice, so opening the page again costs no model call.
  const key = JSON.stringify(planningSignals(input));
  const cached = store.adviceCache.get(event.id);
  if (cached?.key === key) {
    res.json(cached.advice);
    return;
  }
  const advice = await advise(input);
  if (!advice.offline) store.adviceCache.set(event.id, { key, advice });
  res.json(advice);
}

async function getIdeas(req, res) {
  const event = managerOnly(req);
  const state = req.app.locals.store.budgets.get(event.id);
  if (!state) throw badRequest("Finish setting up the event first.");
  const { ideas, rationale, offline } = await generateIdeas({
    profile: event,
    state,
    template: getTemplate(event.eventType),
  });
  res.json({ ideas, rationale, offline });
}

/**
 * Event routes: the user's own event only, and managers only where it changes things.
 * @param {{ai: import("express").RequestHandler}} limits The AI rate limit.
 * @returns {import("express").Router} The routes.
 */
export function eventRoutes({ ai }) {
  const router = Router();
  const newEvents = createLimiter({ windowMs: HOUR_MS, max: NEW_EVENTS_PER_HOUR });
  router.get("/event-types", listTypes);
  router.post("/events", newEvents, validate(schemas.createEvent), startEvent);
  router.get("/events/:id", requireUser, validate(schemas.idParam), getEvent);
  router.patch("/events/:id/profile", requireUser, validate(schemas.patchProfile), patchProfile);
  router.post("/events/:id/advice", requireUser, ai, validate(schemas.idParam), getAdvice);
  router.post("/events/:id/ideas", requireUser, ai, validate(schemas.idParam), getIdeas);
  return router;
}
