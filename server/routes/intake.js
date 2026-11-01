/** Event setup: one question at a time, then creating the workspace. */
import { Router } from "express";
import { nextStep } from "../agents/discovery.js";
import { speak } from "../agents/speech.js";
import { mentionsMoney } from "../core/amount.js";
import { missingProfileFields } from "../core/profile.js";
import { getTemplate } from "../core/templates.js";
import { badRequest, managerOnly, requireUser, validate } from "../http.js";
import { createWorkspace, welcomeFor } from "../store/workspace.js";
import * as schemas from "../validation/schemas.js";
import { groupsFor, profileFor } from "../views.js";

const IN_SETUP = "in_progress";
const ALREADY_FINISHED = "Intake is already finished.";

async function answerQuestion(req, res) {
  const { store } = req.app.locals;
  const event = managerOnly(req);
  if (event.intakeStatus !== IN_SETUP) throw badRequest(ALREADY_FINISHED);
  const { answer, mode } = req.valid.body;
  const step = await nextStep({
    profile: event,
    template: getTemplate(event.eventType),
    answer,
    mode,
  });
  // The model call takes time: another answer or the confirm may have got in first.
  if (store.events.get(event.id) !== event || event.intakeStatus !== IN_SETUP)
    throw badRequest("Please answer that again.");
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
}

async function confirmSetup(req, res) {
  const { store } = req.app.locals;
  const event = managerOnly(req);
  if (event.intakeStatus !== IN_SETUP) throw badRequest(ALREADY_FINISHED);
  if (missingProfileFields(event).length > 0)
    throw badRequest("There are still questions to answer.");
  delete event.suggestedOptions;
  delete event.suggestedQuestions;
  const plain = welcomeFor(event);
  const { wording } = await speak({
    agent: "Planner",
    situation: `The team's workspace for this ${event.eventType} event has just been created. Greet everyone.`,
    facts: [plain, `It is about: ${mentionsMoney(event.purpose) ? "" : (event.purpose ?? "")}`],
    fallback: plain,
  });
  // Someone may have finished it while the model was writing.
  if (event.intakeStatus !== IN_SETUP) throw badRequest(ALREADY_FINISHED);
  createWorkspace(store, event, new Date().toISOString(), { welcome: wording });
  res.json({
    event: profileFor(event, store.roleOf(req.user)),
    groups: groupsFor(store, req.user),
  });
}

/**
 * Setup routes. A tapped answer and the first question use no model, so they don't use up the AI
 * budget.
 * @param {{ai: import("express").RequestHandler}} limits The AI rate limit.
 * @returns {import("express").Router} The routes.
 */
export function intakeRoutes({ ai }) {
  const router = Router();
  const aiIfTyped = (req, res, next) =>
    req.body?.mode === "direct" || req.body?.answer === undefined ? next() : ai(req, res, next);
  router.post(
    "/events/:id/intake",
    requireUser,
    aiIfTyped,
    validate(schemas.intake),
    answerQuestion,
  );
  router.post(
    "/events/:id/intake/confirm",
    requireUser,
    ai,
    validate(schemas.idParam),
    confirmSetup,
  );
  return router;
}
