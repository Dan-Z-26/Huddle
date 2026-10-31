import { Router } from "express";
import { attentionFor } from "../core/directives.js";
import { canManageGroups, canMarkDirective, canSeeBudget, canView } from "../core/permissions.js";
import { getTemplate } from "../core/templates.js";
import { HttpError, readUserId, requireUser, setUserCookie, validate } from "../http.js";
import { DEMO_EVENT_ID } from "../store/seed.js";
import { publicUser } from "./views.js";
import { viewAs } from "../validation/schemas.js";

function roleNames(store, eventId) {
  const { roles } = getTemplate(store.events.get(eventId).eventType);
  return new Map(roles.map(({ id, name }) => [id, name]));
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
function attentionView(store, user) {
  const { directives, tasks } = attentionFor(
    user.id,
    store.directivesForEvent(user.eventId),
    store.tasksForEvent(user.eventId),
  );
  return {
    directives: directives.map((directive) => ({
      id: directive.id,
      groupId: directive.groupId,
      groupName: store.groups.get(directive.groupId)?.name,
      text: (store.messages.get(directive.messageId)?.text ?? "").slice(0, 140),
    })),
    tasks: tasks.map(({ id, title, dueDate, ownerGroupId }) => ({
      id,
      title,
      dueDate,
      ownerGroupId,
    })),
  };
}

/** Routes for choosing who to view the app as. */
export function sessionRoutes() {
  const router = Router();

  router.get("/users", (req, res) => {
    const { store } = req.app.locals;
    const eventId = store.users.get(readUserId(req))?.eventId ?? DEMO_EVENT_ID;
    const users = [...store.users.values()].filter(
      (user) => user.eventId === eventId && user.kind !== "agent",
    );
    const names = roleNames(store, eventId);
    res.json({
      users: users.map((user) => ({ ...publicUser(user), roleName: names.get(user.roleId) })),
    });
  });

  router.post("/view-as", validate(viewAs), (req, res, next) => {
    const user = req.app.locals.store.users.get(req.valid.body.userId);
    if (!user || user.kind === "agent") return next(HttpError(404, "NOT_FOUND", "No such user."));
    setUserCookie(res, user.id);
    res.json({ user: publicUser(user) });
  });

  router.get("/me", requireUser, (req, res) => {
    const { store, user } = { store: req.app.locals.store, user: req.user };
    res.json({
      user: {
        ...publicUser(user),
        eventId: user.eventId,
        ...(user.kind === "core" ? { categoryIds: user.categoryIds } : {}),
      },
      permissions: permissionsOf(store.roleOf(user)),
      attention: attentionView(store, user),
    });
  });

  return router;
}
