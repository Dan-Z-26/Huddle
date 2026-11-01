import { Router } from "express";
import { describeChange } from "../agents/budget.js";
import { parseMoneyField } from "../core/amount.js";
import { contingencyOf } from "../core/budgetEngine.js";
import { applyChangeEvents } from "../core/changeEvents.js";
import { coverEvents, expenseSummary } from "../core/expenses.js";
import { shareOfBps, wholeMoney } from "../core/money.js";
import { canSeeBudget } from "../core/permissions.js";
import { getTemplate } from "../core/templates.js";
import { HttpError, managerOnly, ownEvent, requireBudget, requireUser, validate } from "../http.js";
import { eventExpenses, removeExpense } from "../store/workspace.js";
import * as schemas from "../validation/schemas.js";
import { storePending } from "./budget.js";
import { logExpense, noticeOfCover } from "./expenseWatch.js";

const BPS_PER_PERCENT = 100;

/** What a person may see: the manager all of it; core members their own categories, no totals. */
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

/** Expense tracking and the contingency buffer. Amounts are parsed here, never taken from a client as numbers. */
export function expenseRoutes({ ai }) {
  const router = Router();

  router.get("/events/:id/expenses", requireUser, validate(schemas.eventParam), (req, res) => {
    const { store } = req.app.locals;
    const event = ownEvent(req);
    res.json(viewFor(store, event, store.roleOf(req.user)));
  });

  // The AI budget too, because an expense can bring in the Budget agent.
  router.post(
    "/events/:id/expenses",
    requireUser,
    ai,
    validate(schemas.createExpense),
    (req, res) => {
      const { store } = req.app.locals;
      const event = ownEvent(req);
      const state = requireBudget(store, event);
      const role = store.roleOf(req.user);
      const { description, amount, categoryId, fromBuffer = false } = req.valid.body;
      if (fromBuffer && !canSeeBudget(role, "total"))
        throw HttpError(403, "FORBIDDEN", "Only the event manager can use the buffer.");
      if (!fromBuffer && !categoryId)
        throw HttpError(400, "BAD_REQUEST", "Please choose a category.");
      if (categoryId && !state.categories.some(({ id }) => id === categoryId))
        throw HttpError(400, "BAD_REQUEST", "Unknown category.");
      if (categoryId && !canSeeBudget(role, { categoryId }))
        throw HttpError(403, "FORBIDDEN", "That category belongs to someone else.");
      const parsed = parseMoneyField(amount, state.currency);
      if (!parsed || parsed.minor <= 0)
        throw HttpError(400, "BAD_REQUEST", "I couldn't read that amount.");
      if (parsed.currency && parsed.currency !== state.currency)
        throw HttpError(400, "BAD_REQUEST", `Please give the amount in ${state.currency}.`);
      const { availableMinor } = contingencyOf(state);
      if (fromBuffer && parsed.minor > availableMinor)
        throw HttpError(
          400,
          "BAD_REQUEST",
          `The buffer has only ${wholeMoney(availableMinor, state.currency)} left.`,
        );
      const expense = logExpense({
        store,
        event,
        user: req.user,
        fields: {
          description,
          amountMinor: parsed.minor,
          categoryId: categoryId ?? null,
          fromBuffer,
        },
      });
      res.status(201).json({ expense });
    },
  );

  router.delete("/expenses/:id", requireUser, validate(schemas.expenseParam), (req, res) => {
    const { store } = req.app.locals;
    const expense = store.expenses.get(req.valid.params.id);
    if (!expense || expense.eventId !== req.user.eventId)
      throw HttpError(404, "NOT_FOUND", "No such expense.");
    if (!canSeeBudget(store.roleOf(req.user), "total") && expense.createdById !== req.user.id)
      throw HttpError(
        403,
        "FORBIDDEN",
        "Only the event manager or whoever added it can remove it.",
      );
    removeExpense(store, expense);
    store.publish({ type: "budget.updated", eventId: expense.eventId });
    store.publish({ type: "attention.updated", eventId: expense.eventId });
    res.status(204).end();
  });

  router.post(
    "/events/:id/buffer/cover",
    requireUser,
    ai,
    validate(schemas.coverFromBuffer),
    (req, res) => {
      const { store } = req.app.locals;
      const event = managerOnly(req);
      const state = requireBudget(store, event);
      const { categoryId } = req.valid.body;
      const expenses = eventExpenses(store, event.id);
      const { events, coveredMinor } = coverEvents(state, expenses, categoryId);
      if (coveredMinor === 0)
        throw HttpError(400, "BAD_REQUEST", "There is nothing the buffer can cover here.");
      const { state: after, rejected } = applyChangeEvents(state, events);
      if (rejected.length > 0)
        throw HttpError(400, "BAD_REQUEST", "That can no longer be covered.");
      store.budgets.set(event.id, after);
      store.publish({ type: "budget.updated", eventId: event.id });
      store.publish({ type: "attention.updated", eventId: event.id });
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
    },
  );

  router.post(
    "/events/:id/buffer",
    requireUser,
    ai,
    validate(schemas.setBuffer),
    async (req, res) => {
      const { store } = req.app.locals;
      const event = managerOnly(req);
      const state = requireBudget(store, event);
      const { percent } = req.valid.body;
      const toMinor = shareOfBps(state.totalMinor, percent * BPS_PER_PERCENT);
      const events = [{ type: "contingency_set", toMinor, confidence: 1 }];
      const described = await describeChange({
        profile: event,
        state,
        events,
        template: getTemplate(event.eventType),
        text: `Set the contingency buffer to ${percent}%`,
      });
      const changeId =
        described.consequences.rejected.length === 0
          ? storePending(store, event, state, events)
          : null;
      res.json({ changeId, answer: "", estimates: [], rationale: "", ...described });
    },
  );

  return router;
}
