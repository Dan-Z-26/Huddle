import { wordAlert, alertFacts } from "../agents/expenseMonitor.js";
import { expenseAlerts, expenseSummary } from "../core/expenses.js";
import { groupsForCategory } from "../core/templates.js";
import { getTemplate } from "../core/templates.js";
import { HttpError } from "../http.js";
import { addExpense, eventExpenses, postAgentMessage } from "../store/workspace.js";
import { postSpoken } from "./agentPost.js";
import { groupPeople } from "../views.js";

const MAX_EXPENSES_PER_EVENT = 500;

// A category's rooms and Core team. A room with a vendor in it hears nothing about the plan.
function roomsFor(store, event, categoryId) {
  const { categoryGroupMap } = getTemplate(event.eventType);
  const slugs = new Set([...groupsForCategory(categoryGroupMap, categoryId), "core-team"]);
  return [...slugs]
    .map((slug) => store.groups.get(`g-${event.id}-${slug}`))
    .filter((group) => group && !groupPeople(store, group).some(({ kind }) => kind === "vendor"));
}

async function tellTeam({ store, event, alert, expense, user }) {
  try {
    const facts = alertFacts({
      alert,
      description: expense.description,
      actorName: user.name,
    });
    const { wording, rationale } = await wordAlert({ facts });
    const nowIso = new Date().toISOString();
    for (const group of roomsFor(store, event, alert.categoryId))
      postAgentMessage(store, {
        groupId: group.id,
        authorId: `agent-budget@${event.id}`,
        text: wording,
        rationale,
        nowIso,
      });
    store.reactInDemo?.("overspend", { event, categoryId: alert.categoryId, status: alert.status });
  } catch (err) {
    console.error(`Expense alert failed with ${err.name}`);
  }
}

/**
 * Records an expense and has the Budget agent tell the team if it pushed a category across a line
 * in its plan. The reply doesn't wait for the model: the message arrives over the live stream.
 * @param {{store: object, event: object, user: object, fields: {description: string,
 *   amountMinor: number, categoryId: string | null, fromBuffer: boolean}}} input The validated
 *   expense, with the permission checks already done.
 * @returns {object} The stored expense.
 * @throws When the event already holds as many expenses as it may.
 */
export function logExpense({ store, event, user, fields }) {
  if (eventExpenses(store, event.id).length >= MAX_EXPENSES_PER_EVENT)
    throw HttpError(400, "BAD_REQUEST", "That is as many expenses as the demo allows.");
  const state = store.budgets.get(event.id);
  const before = expenseSummary(state, eventExpenses(store, event.id));
  const expense = addExpense(
    store,
    { eventId: event.id, ...fields, createdById: user.id },
    new Date().toISOString(),
  );
  store.publish({ type: "budget.updated", eventId: event.id });
  store.publish({ type: "attention.updated", eventId: event.id });
  const after = expenseSummary(store.budgets.get(event.id), eventExpenses(store, event.id));
  for (const alert of expenseAlerts(before, after)) {
    const work = tellTeam({ store, event, alert, expense, user }).finally(() =>
      store.background.delete(work),
    );
    store.background.add(work);
  }
  return expense;
}

/**
 * Tells a category's rooms that the manager covered its overspend. Plain code wording, no figures.
 * @param {{store: object, event: object, user: object, categoryId: string, name: string,
 *   stillOver: boolean}} input Who covered what, and whether some of it is still over.
 */
export function noticeOfCover({ store, event, user, categoryId, name, stillOver }) {
  const text = stillOver
    ? `${user.name} covered part of the ${name} overspend from the buffer. Some of it is still over plan.`
    : `${user.name} covered the ${name} overspend from the buffer, so it is back within plan.`;
  const nowIso = new Date().toISOString();
  for (const group of roomsFor(store, event, categoryId))
    postSpoken(store, {
      groupId: group.id,
      eventId: event.id,
      agent: "budget",
      authorKind: "system",
      situation: "The event manager has just dealt with an overspend you warned the team about.",
      facts: [text],
      fallback: text,
      nowIso,
    });
}
