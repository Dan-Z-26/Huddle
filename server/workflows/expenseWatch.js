/** Recording an expense, and the Budget agent's warnings when spending crosses a line in the plan. */
import { alertFacts, wordAlert } from "../agents/expenseMonitor.js";
import { expenseAlerts, expenseSummary } from "../core/expenses.js";
import { getTemplate, groupsForCategory } from "../core/templates.js";
import { badRequest } from "../http.js";
import { agentIdFor, CORE_TEAM, groupIdFor } from "../store/ids.js";
import { addExpense, eventExpenses, postAgentMessage } from "../store/workspace.js";
import { hasVendor } from "../views.js";
import { postSpoken } from "./agentPost.js";

const MAX_EXPENSES_PER_EVENT = 500;

// A category's rooms and Core team. A room with a vendor in it hears nothing about the plan.
function roomsFor(store, event, categoryId) {
  const { categoryGroupMap } = getTemplate(event.eventType);
  const slugs = new Set([...groupsForCategory(categoryGroupMap, categoryId), CORE_TEAM]);
  return [...slugs]
    .map((slug) => store.groups.get(groupIdFor(event.id, slug)))
    .filter((group) => group && !hasVendor(store, group));
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
        authorId: agentIdFor("budget", event.id),
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
 * @throws {Error} 400 when the event already holds as many expenses as it may.
 */
export function logExpense({ store, event, user, fields }) {
  if (eventExpenses(store, event.id).length >= MAX_EXPENSES_PER_EVENT)
    throw badRequest("That is as many expenses as the demo allows.");
  const state = store.budgets.get(event.id);
  const before = expenseSummary(state, eventExpenses(store, event.id));
  const expense = addExpense(
    store,
    { eventId: event.id, ...fields, createdById: user.id },
    new Date().toISOString(),
  );
  store.nudge(event.id, "budget.updated", "attention.updated");
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
      nowIso,
    });
}
