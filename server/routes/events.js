import { Router } from "express";
import { mentionsMoney } from "../core/amount.js";
import { missingProfileFields } from "../core/profile.js";
import { canSeeBudget } from "../core/permissions.js";
import { getTemplate, listEventTypes } from "../core/templates.js";
import { generateIdeas } from "../agents/ideas.js";
import { nextStep } from "../agents/discovery.js";
import {
  createAiLimiter,
  HttpError,
  managerOnly,
  ownEvent,
  publicUser,
  requireUser,
  setUserCookie,
  validate,
} from "../http.js";
import { DEMO_EVENT_ID } from "../store/seed.js";
import { createEvent, createWorkspace, deleteEvent } from "../store/workspace.js";
import * as schemas from "../validation/schemas.js";

const MAX_EVENTS = 50;
const HIDDEN = "(contains an amount; visible to the event manager)";
const noMoney = (text) => (mentionsMoney(text) ? HIDDEN : text);

/**
 * The profile as a user may see it. Only the manager gets the total budget and the ranking: a
 * category's opening amount follows from its rank, so rank plus amount would reveal the total.
 * Others also lose other categories' needs and any amount typed into shared text.
 */
function profileFor(event, role) {
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

/** Event-scoped routes: the user's own event only, and managers only where it changes things. */
export function eventRoutes({ ai }) {
  const router = Router();
  const newEvents = createAiLimiter({ windowMs: 3_600_000, max: 20 });

  router.get("/event-types", (_req, res) => res.json({ eventTypes: listEventTypes() }));

  router.post("/events", newEvents, validate(schemas.createEvent), (req, res) => {
    const { store } = req.app.locals;
    if (store.events.size >= MAX_EVENTS) {
      // Replace the oldest event rather than refuse, so nobody can block the demo for everyone.
      const oldest = [...store.events.keys()].find((id) => id !== DEMO_EVENT_ID);
      deleteEvent(store, oldest);
    }
    const { event, users } = createEvent(store, { eventType: req.valid.body.eventType });
    const manager = users.find(({ kind }) => kind === "manager");
    setUserCookie(res, manager.id);
    res.status(201).json({ event: profileFor(event, store.roleOf(manager)) });
  });

  router.get("/events/:id", requireUser, validate(schemas.eventParam), (req, res) => {
    const { store } = req.app.locals;
    const event = ownEvent(req);
    const template = getTemplate(event.eventType);
    const members = [...store.users.values()].filter(({ eventId }) => eventId === event.id);
    res.json({
      event: profileFor(event, store.roleOf(req.user)),
      template: {
        label: template.label,
        categories: template.categories.map(({ id, name }) => ({ id, name })),
      },
      groups: store.groupsForUser(req.user),
      members: members.map(publicUser),
    });
  });

  router.patch("/events/:id/profile", requireUser, validate(schemas.patchProfile), (req, res) => {
    const event = managerOnly(req);
    Object.assign(event, req.valid.body);
    res.json({ event: profileFor(event, req.app.locals.store.roleOf(req.user)) });
  });

  router.post("/events/:id/intake", requireUser, ai, validate(schemas.intake), async (req, res) => {
    const { store } = req.app.locals;
    const event = managerOnly(req);
    if (event.intakeStatus !== "in_progress")
      throw HttpError(400, "BAD_REQUEST", "Intake is already finished.");
    const template = getTemplate(event.eventType);
    const step = await nextStep({ profile: event, template, answer: req.valid.body.answer });
    // The model call takes time: another answer or the confirm may have got in first.
    if (store.events.get(event.id) !== event || event.intakeStatus !== "in_progress")
      throw HttpError(400, "BAD_REQUEST", "Please answer that again.");
    store.events.set(event.id, step.profile);
    res.json({
      nextQuestion: step.nextQuestion,
      feedback: step.feedback,
      field: step.field,
      profile: profileFor(step.profile, store.roleOf(req.user)),
      complete: step.complete,
      rationale: step.rationale,
    });
  });

  router.post(
    "/events/:id/intake/confirm",
    requireUser,
    validate(schemas.eventParam),
    (req, res) => {
      const { store } = req.app.locals;
      const event = managerOnly(req);
      if (event.intakeStatus !== "in_progress")
        throw HttpError(400, "BAD_REQUEST", "Intake is already finished.");
      if (missingProfileFields(event).length > 0)
        throw HttpError(400, "BAD_REQUEST", "There are still questions to answer.");
      createWorkspace(store, event, new Date().toISOString());
      res.json({
        event: profileFor(event, store.roleOf(req.user)),
        groups: store.groupsForUser(req.user),
      });
    },
  );

  router.post(
    "/events/:id/ideas",
    requireUser,
    ai,
    validate(schemas.eventParam),
    async (req, res) => {
      const event = managerOnly(req);
      const state = req.app.locals.store.budgets.get(event.id);
      if (!state) throw HttpError(400, "BAD_REQUEST", "Finish setting up the event first.");
      const { ideas, rationale, offline } = await generateIdeas({
        profile: event,
        state,
        template: getTemplate(event.eventType),
      });
      res.json({ ideas, rationale, offline });
    },
  );

  return router;
}
