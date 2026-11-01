/** Expense tracking and the contingency buffer. Amounts are parsed here, never taken as numbers. */
import { Router } from "express";
import { parseMoneyField } from "../core/amount.js";
import { contingencyOf } from "../core/budgetEngine.js";
import { applyChangeEvents } from "../core/changeEvents.js";
import { coverEvents, expenseSummary } from "../core/expenses.js";
import { shareOfBps, wholeMoney } from "../core/money.js";
import { canSeeBudget } from "../core/permissions.js";
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
import { eventExpenses, removeExpense } from "../store/workspace.js";
import * as schemas from "../validation/schemas.js";
import { proposeInCode } from "../workflows/budgetChange.js";
import { logExpense, noticeOfCover } from "../workflows/expenseWatch.js";

const BPS_PER_PERCENT = 100;

// What a person may see: the manager all of it; core members their own categories, no totals.
function viewFor(store, event, role) {
  const state = requireBudget(store, event);
  const all = eventExpenses(store, event.id);
  if (canSeeBudget(role, "total")) return { expenses: all, summary: expenseSummary(state, all) };
  const owns = ({ categoryId }) => canSeeBudget(role, { categoryId });
  const own = all.filter((expense) => !expense.fromBuffer && owns(expense));
  return {
    expenses: own,
    // How much came from the buffer stays with the manager, like the buffer itself.
    summary: {
      categories: expenseSummary(state, own)
        .categories.filter(({ id }) => owns({ categoryId: id }))
        .map(({ coveredMinor: _covered, ...row }) => row),
    },
  };
}

// Whether this person may spend from this place, in code, whatever the page offered them.
function refuseExpenseFrom({ role, state, categoryId, fromBuffer }) {
  if (fromBuffer && !canSeeBudget(role, "total"))
    throw forbidden("Only the event manager can use the buffer.");
  if (!fromBuffer && !categoryId) throw badRequest("Please choose a category.");
  if (categoryId && !state.categories.some(({ id }) => id === categoryId))
    throw badRequest("Unknown category.");
  if (categoryId && !canSeeBudget(role, { categoryId }))
    throw forbidden("That category belongs to someone else.");
}

function readExpenseAmount(amount, state, fromBuffer) {
  const parsed = parseMoneyField(amount, state.currency);
  if (!parsed || parsed.minor <= 0) throw badRequest("I couldn't read that amount.");
  if (parsed.currency && parsed.currency !== state.currency)
    throw badRequest(`Please give the amount in ${state.currency}.`);
  const { availableMinor } = contingencyOf(state);
  if (fromBuffer && parsed.minor > availableMinor)
    throw badRequest(`The buffer has only ${wholeMoney(availableMinor, state.currency)} left.`);
  return parsed.minor;
}

function listExpenses(req, res) {
  const { store } = req.app.locals;
  res.json(viewFor(store, ownEvent(req), store.roleOf(req.user)));
}

function addExpense(req, res) {
  const { store } = req.app.locals;
  const event = ownEvent(req);
  const state = requireBudget(store, event);
  const { description, amount, categoryId, fromBuffer = false } = req.valid.body;
  refuseExpenseFrom({ role: store.roleOf(req.user), state, categoryId, fromBuffer });
  const amountMinor = readExpenseAmount(amount, state, fromBuffer);
  const fields = { description, amountMinor, categoryId: categoryId ?? null, fromBuffer };
  const expense = logExpense({ store, event, user: req.user, fields });
  res.status(201).json({ expense });
}

function deleteExpense(req, res) {
  const { store } = req.app.locals;
  const expense = ownRecord(req, store.expenses, "expense");
  if (!canSeeBudget(store.roleOf(req.user), "total") && expense.createdById !== req.user.id)
    throw forbidden("Only the event manager or whoever added it can remove it.");
  removeExpense(store, expense);
  store.nudge(expense.eventId, "budget.updated", "attention.updated");
  res.status(204).end();
}

function coverOverspend(req, res) {
  const { store } = req.app.locals;
  const event = managerOnly(req);
  const state = requireBudget(store, event);
  const { categoryId } = req.valid.body;
  const expenses = eventExpenses(store, event.id);
  const { events, coveredMinor } = coverEvents(state, expenses, categoryId);
  if (coveredMinor === 0) throw badRequest("There is nothing the buffer can cover here.");
  const { state: after, rejected } = applyChangeEvents(state, events);
  if (rejected.length > 0) throw badRequest("That can no longer be covered.");
  store.budgets.set(event.id, after);
  store.nudge(event.id, "budget.updated", "attention.updated");
  const row = expenseSummary(after, expenses).categories.find(({ id }) => id === categoryId);
  noticeOfCover({
    store,
    event,
    user: req.user,
    categoryId,
    name: row.name,
    stillOver: row.overMinor > 0,
  });
  res.json({ coveredMinor });
}

async function setBuffer(req, res) {
  const { store } = req.app.locals;
  const event = managerOnly(req);
  const state = requireBudget(store, event);
  const { percent } = req.valid.body;
  const toMinor = shareOfBps(state.totalMinor, percent * BPS_PER_PERCENT);
  const events = [{ type: "contingency_set", toMinor, confidence: 1 }];
  const text = `Set the contingency buffer to ${percent}%`;
  res.json(await proposeInCode(store, { event, state, events, text }));
}

/**
 * Expenses and the buffer. Adding an expense uses the AI budget too, as it can bring in the Budget
 * agent.
 * @param {{ai: import("express").RequestHandler}} limits The AI rate limit.
 * @returns {import("express").Router} The routes.
 */
export function expenseRoutes({ ai }) {
  const router = Router();
  router.get("/events/:id/expenses", requireUser, validate(schemas.idParam), listExpenses);
  router.post("/events/:id/expenses", requireUser, ai, validate(schemas.createExpense), addExpense);
  router.delete("/expenses/:id", requireUser, validate(schemas.idParam), deleteExpense);
  router.post(
    "/events/:id/buffer/cover",
    requireUser,
    ai,
    validate(schemas.coverFromBuffer),
    coverOverspend,
  );
  router.post("/events/:id/buffer", requireUser, ai, validate(schemas.setBuffer), setBuffer);
  return router;
}
