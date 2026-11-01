/**
 * Budget routes: reading the budget as the asker may see it, proposing a change in plain language,
 * and applying one the manager has reviewed.
 */
import { Router } from "express";
import { interpretChange } from "../agents/budget.js";
import { computeBudget, tierForCost } from "../core/budgetEngine.js";
import { canSeeBudget } from "../core/permissions.js";
import { rankOf } from "../core/priorities.js";
import { getTemplate } from "../core/templates.js";
import { managerOnly, notFound, ownEvent, requireBudget, requireUser, validate } from "../http.js";
import { eventExpenses } from "../store/workspace.js";
import * as schemas from "../validation/schemas.js";
import { applyChange, storePending } from "../workflows/budgetChange.js";
import { timelineView } from "../workflows/timeline.js";

// The budget as a user may see it: core members get only the categories they own, and no totals.
function budgetFor(event, state, role) {
  const computed = computeBudget(state);
  const seesTotal = canSeeBudget(role, "total");
  const categories = computed.categories
    .filter(({ id }) => canSeeBudget(role, { categoryId: id }))
    .map((category) => {
      const { tiers, locked, typicalBps } = state.categories.find(({ id }) => id === category.id);
      const tier = tierForCost(tiers, category.committedMinor);
      return {
        ...category,
        locked,
        // Only the manager: rank plus a category's amount would reveal the total.
        ...(seesTotal ? { rank: rankOf(event.priorities, category.id), typicalBps } : {}),
        // With nothing allocated, every tier "fits", so naming one would mislead.
        tierLabel: category.committedMinor > 0 ? (tier?.label ?? null) : null,
      };
    });
  const scope = { guestCount: state.guestCount, currency: state.currency, categories };
  return seesTotal ? { ...computed, ...scope } : scope;
}

function getBudget(req, res) {
  const { store } = req.app.locals;
  const event = ownEvent(req);
  const state = requireBudget(store, event);
  res.json(budgetFor(event, state, store.roleOf(req.user)));
}

async function proposeChange(req, res) {
  const { store } = req.app.locals;
  const event = managerOnly(req);
  const state = requireBudget(store, event);
  const result = await interpretChange({
    profile: event,
    state,
    actor: store.roleOf(req.user),
    text: req.valid.body.text,
    template: getTemplate(event.eventType),
    expenses: eventExpenses(store, event.id),
  });
  // Only a change that applies cleanly can be accepted later.
  const applies =
    result.changeEvents.length > 0 &&
    result.consequences?.rejected.length === 0 &&
    !result.clarifyingQuestion;
  const changeId = applies
    ? storePending(store, { event, state, events: result.changeEvents })
    : null;
  res.json({
    changeId,
    answer: result.answer,
    insight: result.insight,
    offline: result.offline,
    consequences: result.consequences,
    consequenceText: result.consequenceText,
    estimates: result.estimates,
    explanation: result.explanation,
    clarifyingQuestion: result.clarifyingQuestion,
    rationale: result.rationale,
  });
}

async function acceptChange(req, res) {
  const { store } = req.app.locals;
  const event = managerOnly(req);
  const before = requireBudget(store, event);
  const pending = store.pendingChanges.get(req.valid.params.changeId);
  if (!pending || pending.eventId !== event.id)
    throw notFound("That change is no longer available.");
  const choice = req.valid.body;
  const { after, noticesPosted } = await applyChange(store, { event, before, pending, choice });
  res.json({
    budget: budgetFor(event, after, store.roleOf(req.user)),
    tasks: timelineView(store, event.id),
    noticesPosted,
  });
}

/**
 * Budget and consequences.
 * @param {{ai: import("express").RequestHandler}} limits The AI rate limit.
 * @returns {import("express").Router} The routes.
 */
export function budgetRoutes({ ai }) {
  const router = Router();
  router.get("/events/:id/budget", requireUser, validate(schemas.idParam), getBudget);
  router.post(
    "/events/:id/changes",
    requireUser,
    ai,
    validate(schemas.proposeChange),
    proposeChange,
  );
  router.post(
    "/events/:id/changes/:changeId/accept",
    requireUser,
    ai,
    validate(schemas.acceptChange),
    acceptChange,
  );
  return router;
}
