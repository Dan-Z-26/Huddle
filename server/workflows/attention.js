/** "Needs my attention": what is waiting for one person, limited to what they may see. */
import { attentionFor } from "../core/directives.js";
import { expenseSummary, spendingWatch } from "../core/expenses.js";
import { quotesToReview } from "../core/hiring.js";
import { canSeeBudget, canView } from "../core/permissions.js";
import { categoryName, getTemplate } from "../core/templates.js";
import { eventExpenses } from "../store/workspace.js";
import { noMoneyForVendor } from "../views.js";

const MAX_PREVIEW = 140;

// Spending near or over plan, limited to what this person may see of the budget.
function spendingView(store, user) {
  const state = store.budgets.get(user.eventId);
  if (!state || user.kind === "vendor") return null;
  const role = store.roleOf(user);
  const summary = expenseSummary(state, eventExpenses(store, user.eventId));
  const shown = canSeeBudget(role, "total")
    ? summary
    : {
        categories: summary.categories.filter(({ id }) => canSeeBudget(role, { categoryId: id })),
      };
  return { currency: state.currency, ...spendingWatch(shown) };
}

// Briefs a lead has sent, which only the manager can approve.
function briefsWaiting(store, eventId) {
  const template = getTemplate(store.events.get(eventId).eventType);
  return [...store.briefs.values()]
    .filter((brief) => brief.eventId === eventId && brief.status === "pending")
    .map(({ categoryId }) => ({ categoryId, name: categoryName(template, categoryId) }));
}

// Quotes waiting for the manager to compare, by category.
function quotesWaiting(store, eventId) {
  const template = getTemplate(store.events.get(eventId).eventType);
  const quotes = [...store.quotes.values()].filter((quote) => quote.eventId === eventId);
  return quotesToReview(quotes).map(({ categoryId, count }) => ({
    categoryId,
    count,
    name: categoryName(template, categoryId),
  }));
}

// Someone removed from a group no longer sees what was pinned there, and a vendor sees only what
// was pinned after they joined.
function directivesFor(store, user, directives) {
  const role = store.roleOf(user);
  const isVendor = user.kind === "vendor";
  const textOf = ({ messageId }) => store.messages.get(messageId)?.text ?? "";
  return directives
    .filter(
      (directive) =>
        canView(role, { type: "group", group: store.groups.get(directive.groupId) }) &&
        (!isVendor || store.messages.get(directive.messageId)?.createdAt >= user.joinedAt),
    )
    .map((directive) => ({
      id: directive.id,
      groupId: directive.groupId,
      groupName: store.groups.get(directive.groupId)?.name,
      text: (isVendor ? noMoneyForVendor : String)(textOf(directive)).slice(0, MAX_PREVIEW),
    }));
}

/**
 * What is waiting for this person: directives they haven't acknowledged, their open tasks, spending
 * near its plan, and for the manager, briefs and quotes to decide on.
 * @param {object} store The store.
 * @param {object} user The person.
 * @returns {object} The attention list.
 */
export function attentionView(store, user) {
  const { directives, tasks } = attentionFor(
    user.id,
    store.directivesForEvent(user.eventId),
    store.tasksForEvent(user.eventId),
  );
  const isManager = user.kind === "manager";
  return {
    spending: spendingView(store, user),
    briefs: isManager ? briefsWaiting(store, user.eventId) : [],
    quotes: isManager ? quotesWaiting(store, user.eventId) : [],
    directives: directivesFor(store, user, directives),
    // A vendor's work is their deliverables; the team's timeline isn't shared with them.
    tasks: (user.kind === "vendor" ? [] : tasks).map(({ id, title, dueDate, ownerGroupId }) => ({
      id,
      title,
      dueDate,
      ownerGroupId,
    })),
  };
}
