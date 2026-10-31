import { Router } from "express";
import { missingProfileFields } from "../core/profile.js";
import { canPost } from "../core/permissions.js";
import { getTemplate, listEventTypes } from "../core/templates.js";
import { advise } from "../agents/advisor.js";
import { generateIdeas } from "../agents/ideas.js";
import { planningSignals } from "../core/signals.js";
import { nextStep } from "../agents/discovery.js";
import {
  createAiLimiter,
  HttpError,
  managerOnly,
  ownEvent,
  requireBudget,
  requireUser,
  startSession,
  validate,
} from "../http.js";
import { DEMO_EVENT_ID } from "../store/seed.js";
import { createEvent, createWorkspace, deleteEvent, eventExpenses } from "../store/workspace.js";
import * as schemas from "../validation/schemas.js";
import { eventQuotes } from "./vendorSupport.js";
import { profileFor, publicUser } from "./views.js";

const MAX_EVENTS = 50;
/** The user's groups, each saying whether they may post there, so the screen can offer a composer. */
export function groupsFor(store, user) {
  const role = store.roleOf(user);
  return store.groupsForUser(user).map((group) => ({ ...group, canPost: canPost(role, group) }));
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
    startSession(res, store, manager.id);
    res.status(201).json({ event: profileFor(event, store.roleOf(manager)) });
  });

  router.get("/events/:id", requireUser, validate(schemas.eventParam), (req, res) => {
    const { store } = req.app.locals;
    const event = ownEvent(req, { vendorsToo: true });
    const template = getTemplate(event.eventType);
    const isVendor = req.user.kind === "vendor";
    const groups = groupsFor(store, req.user);
    // A vendor sees the people in their own group, and nothing of how the team is organised.
    const inGroup = new Set(groups.flatMap(({ memberRoleIds }) => memberRoleIds));
    const members = [...store.users.values()].filter(
      ({ eventId, roleId, kind }) =>
        eventId === event.id && (!isVendor || kind === "agent" || inGroup.has(roleId)),
    );
    res.json({
      event: profileFor(event, store.roleOf(req.user)),
      template: {
        label: template.label,
        categories: template.categories
          .filter(({ id }) => !isVendor || req.user.categoryIds.includes(id))
          .map(({ id, name }) => ({ id, name })),
        roles: isVendor
          ? []
          : template.roles
              .filter(({ kind }) => kind !== "agent")
              .map(({ id, name, kind }) => ({ id, name, kind })),
      },
      groups,
      members: members.map(publicUser),
    });
  });

  router.patch("/events/:id/profile", requireUser, validate(schemas.patchProfile), (req, res) => {
    const event = managerOnly(req);
    Object.assign(event, req.valid.body);
    res.json({ event: profileFor(event, req.app.locals.store.roleOf(req.user)) });
  });

  // A tapped answer and the first question use no model, so they don't use up the AI budget.
  const aiIfTyped = (req, res, next) =>
    req.body?.mode === "direct" || req.body?.answer === undefined ? next() : ai(req, res, next);

  router.post(
    "/events/:id/intake",
    requireUser,
    aiIfTyped,
    validate(schemas.intake),
    async (req, res) => {
      const { store } = req.app.locals;
      const event = managerOnly(req);
      if (event.intakeStatus !== "in_progress")
        throw HttpError(400, "BAD_REQUEST", "Intake is already finished.");
      const template = getTemplate(event.eventType);
      const { answer, mode } = req.valid.body;
      const step = await nextStep({ profile: event, template, answer, mode });
      // The model call takes time: another answer or the confirm may have got in first.
      if (store.events.get(event.id) !== event || event.intakeStatus !== "in_progress")
        throw HttpError(400, "BAD_REQUEST", "Please answer that again.");
      store.events.set(event.id, step.profile);
      res.json({
        nextQuestion: step.nextQuestion,
        feedback: step.feedback,
        field: step.field,
        options: step.options,
        remaining: step.remaining,
        heard: step.heard,
        profile: profileFor(step.profile, store.roleOf(req.user)),
        complete: step.complete,
        rationale: step.rationale,
      });
    },
  );

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
      delete event.suggestedOptions;
      createWorkspace(store, event, new Date().toISOString());
      res.json({
        event: profileFor(event, store.roleOf(req.user)),
        groups: groupsFor(store, req.user),
      });
    },
  );

  router.post(
    "/events/:id/advice",
    requireUser,
    ai,
    validate(schemas.eventParam),
    async (req, res) => {
      const { store } = req.app.locals;
      const event = managerOnly(req);
      const state = requireBudget(store, event);
      const nowIso = new Date().toISOString();
      const input = {
        profile: event,
        state,
        expenses: eventExpenses(store, event.id),
        tasks: store.tasksForEvent(event.id),
        quotes: eventQuotes(store, event.id),
        nowIso,
      };
      // The same signals give the same advice, so opening the page again costs no model call.
      const key = JSON.stringify(planningSignals(input));
      const cached = store.adviceCache.get(event.id);
      if (cached?.key === key) return res.json(cached.advice);
      const advice = await advise(input);
      if (!advice.offline) store.adviceCache.set(event.id, { key, advice });
      return res.json(advice);
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
