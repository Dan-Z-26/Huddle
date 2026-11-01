/** The demo sign-in, and who is signed in. Real authentication is listed as future work. */
import { Router } from "express";
import { canManageGroups, canMarkDirective, canSeeBudget, canView } from "../core/permissions.js";
import { getTemplate } from "../core/templates.js";
import { MINUTE_MS } from "../core/time.js";
import {
  createLimiter,
  forbidden,
  notFound,
  readSessionId,
  requireUser,
  sessionOf,
  startSession,
  validate,
} from "../http.js";
import { DEMO_EVENT_ID } from "../store/seed.js";
import { signIn as signInSchema } from "../validation/schemas.js";
import { publicUser } from "../views.js";
import { attentionView } from "../workflows/attention.js";

const SIGN_INS_PER_MINUTE = 60;

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
    throw forbidden("Sign-in isn't available here.");
  const { store } = req.app.locals;
  return (session && store.users.get(session.userId)?.eventId) ?? DEMO_EVENT_ID;
}

// What a user may do, for the UI to show or hide controls. The server checks again on every call.
const permissionsOf = (role) => ({
  seeTotalBudget: canSeeBudget(role, "total"),
  manageGroups: canManageGroups(role),
  markDirective: canMarkDirective(role),
  viewQuotes: canView(role, { type: "quotes" }),
});

function listPeople(req, res) {
  const { store } = req.app.locals;
  const eventId = signInEvent(req);
  const people = [...store.users.values()].filter(
    (user) => user.eventId === eventId && user.kind !== "agent",
  );
  res.json({
    eventName: store.events.get(eventId).name,
    isDemo: eventId === DEMO_EVENT_ID,
    // A deployed site can greet newcomers with "Start a new event" instead of the demo's people.
    startWithNew: process.env.START_ON === "new" && eventId === DEMO_EVENT_ID,
    people: people.map((user) => ({ ...publicUser(user), roleName: roleNameOf(store, user) })),
  });
}

function signIn(req, res) {
  const { store } = req.app.locals;
  const eventId = signInEvent(req);
  const user = store.users.get(req.valid.body.userId);
  if (!user || user.kind === "agent" || user.eventId !== eventId) throw notFound("No such person.");
  store.sessions.delete(readSessionId(req));
  startSession(res, store, user.id);
  store.startDemoStory?.(eventId);
  res.json({ user: publicUser(user) });
}

function signOut(req, res) {
  req.app.locals.store.sessions.delete(readSessionId(req));
  res.status(204).end();
}

function whoAmI(req, res) {
  const { store } = req.app.locals;
  const { user } = req;
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
}

/**
 * Session routes.
 * @returns {import("express").Router} The routes.
 */
export function sessionRoutes() {
  const router = Router();
  const signIns = createLimiter({ windowMs: MINUTE_MS, max: SIGN_INS_PER_MINUTE });
  router.get("/people", listPeople);
  router.post("/session", signIns, validate(signInSchema), signIn);
  router.post("/session/logout", signOut);
  router.get("/me", requireUser, whoAmI);
  return router;
}
