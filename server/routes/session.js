import { Router } from "express";
import { attentionFor } from "../core/directives.js";
import { expenseSummary, spendingWatch } from "../core/expenses.js";
import { quotesToReview } from "../core/hiring.js";
import { canManageGroups, canMarkDirective, canSeeBudget, canView } from "../core/permissions.js";
import { getTemplate } from "../core/templates.js";
import {
  createAiLimiter,
  HttpError,
  readSessionId,
  requireUser,
  sessionOf,
  startSession,
  validate,
} from "../http.js";
import { DEMO_EVENT_ID } from "../store/seed.js";
import { eventExpenses } from "../store/workspace.js";
import { noMoneyForVendor, publicUser } from "./views.js";
import { signIn } from "../validation/schemas.js";

// A person's role in words. A vendor isn't one of the template's roles.
function roleNameOf(store, user) {
  const template = getTemplate(store.events.get(user.eventId).eventType);
  if (user.kind === "vendor") {
    const category = template.categories.find(({ id }) => id === user.categoryIds[0]);
    return `Vendor, ${category?.name ?? "booked"}`;
  }
  return template.roles.find(({ id }) => id === user.roleId)?.name ?? "";
}

// The demo sign-in lists the people of the event you are in, or the demo event. Whoever came in
// through a vendor's invite link is a real outsider, so the list is closed to them.
function signInEvent(req) {
  const session = sessionOf(req);
  if (process.env.DEMO_SIGNIN === "off" || session?.invited)
    throw HttpError(403, "FORBIDDEN", "Sign-in isn't available here.");
  const { store } = req.app.locals;
  return (session && store.users.get(session.userId)?.eventId) ?? DEMO_EVENT_ID;
}

/**
 * What a user may do, for the UI to show or hide controls. The server checks again on every call.
 * @param {object} role The user's role object from `store.roleOf`.
 * @returns {{seeTotalBudget: boolean, manageGroups: boolean, markDirective: boolean,
 *   viewQuotes: boolean}} Permissions.
 */
export const permissionsOf = (role) => ({
  seeTotalBudget: canSeeBudget(role, "total"),
  manageGroups: canManageGroups(role),
  markDirective: canMarkDirective(role),
  viewQuotes: canView(role, { type: "quotes" }),
});

// What is waiting for this person: directives they haven't acknowledged, and their open tasks.
// Spending near or over plan, limited to what this person may see of the budget.
function spendingView(store, user) {
  const state = store.budgets.get(user.eventId);
  const role = store.roleOf(user);
  if (!state || user.kind === "vendor") return null;
  const summary = expenseSummary(state, eventExpenses(store, user.eventId));
  const isManager = canSeeBudget(role, "total");
  const shown = isManager
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
    .map(({ categoryId }) => ({
      categoryId,
      name: template.categories.find(({ id }) => id === categoryId)?.name ?? categoryId,
    }));
}

// Quotes waiting for the manager to compare, by category.
function quotesWaiting(store, eventId) {
  const template = getTemplate(store.events.get(eventId).eventType);
  return quotesToReview(
    [...store.quotes.values()].filter((quote) => quote.eventId === eventId),
  ).map(({ categoryId, count }) => ({
    categoryId,
    count,
    name: template.categories.find(({ id }) => id === categoryId)?.name ?? categoryId,
  }));
}

function attentionView(store, user) {
  const { directives, tasks } = attentionFor(
    user.id,
    store.directivesForEvent(user.eventId),
    store.tasksForEvent(user.eventId),
  );
  const role = store.roleOf(user);
  // Someone removed from a group no longer sees what was pinned there.
  const isVendor = user.kind === "vendor";
  const visible = directives.filter(
    (directive) =>
      canView(role, { type: "group", group: store.groups.get(directive.groupId) }) &&
      (!isVendor || store.messages.get(directive.messageId)?.createdAt >= user.joinedAt),
  );
  return {
    spending: spendingView(store, user),
    briefs: user.kind === "manager" ? briefsWaiting(store, user.eventId) : [],
    quotes: user.kind === "manager" ? quotesWaiting(store, user.eventId) : [],
    directives: visible.map((directive) => ({
      id: directive.id,
      groupId: directive.groupId,
      groupName: store.groups.get(directive.groupId)?.name,
      text: (isVendor ? noMoneyForVendor : String)(
        store.messages.get(directive.messageId)?.text ?? "",
      ).slice(0, 140),
    })),
    // A vendor's work is their deliverables; the team's timeline isn't shared with them.
    tasks: (user.kind === "vendor" ? [] : tasks).map(({ id, title, dueDate, ownerGroupId }) => ({
      id,
      title,
      dueDate,
      ownerGroupId,
    })),
  };
}

/** The demo sign-in, and who is signed in. Real authentication is future work. */
export function sessionRoutes() {
  const router = Router();
  const signIns = createAiLimiter({ windowMs: 60_000, max: 60 });

  router.get("/people", (req, res) => {
    const { store } = req.app.locals;
    const eventId = signInEvent(req);
    const people = [...store.users.values()].filter(
      (user) => user.eventId === eventId && user.kind !== "agent",
    );
    res.json({
      eventName: store.events.get(eventId).name,
      isDemo: eventId === DEMO_EVENT_ID,
      people: people.map((user) => ({ ...publicUser(user), roleName: roleNameOf(store, user) })),
    });
  });

  router.post("/session", signIns, validate(signIn), (req, res, next) => {
    const { store } = req.app.locals;
    const eventId = signInEvent(req);
    const user = store.users.get(req.valid.body.userId);
    if (!user || user.kind === "agent" || user.eventId !== eventId)
      return next(HttpError(404, "NOT_FOUND", "No such person."));
    store.sessions.delete(readSessionId(req));
    startSession(res, store, user.id);
    store.startDemoStory?.(eventId);
    res.json({ user: publicUser(user) });
  });

  router.post("/session/logout", (req, res) => {
    req.app.locals.store.sessions.delete(readSessionId(req));
    res.status(204).end();
  });

  router.get("/me", requireUser, (req, res) => {
    const { store, user } = { store: req.app.locals.store, user: req.user };
    res.json({
      user: {
        ...publicUser(user),
        eventId: user.eventId,
        roleName: roleNameOf(store, user),
        ...(user.kind === "core" ? { categoryIds: user.categoryIds } : {}),
      },
      invited: req.session.invited,
      permissions: permissionsOf(store.roleOf(user)),
      attention: attentionView(store, user),
    });
  });

  return router;
}
