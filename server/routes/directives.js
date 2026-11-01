/** Directives: the manager pins a message, and the people it names tap "Got it". */
import { Router } from "express";
import { canMarkDirective, canView } from "../core/permissions.js";
import { badRequest, forbidden, notFound, requireUser, validate } from "../http.js";
import { idParam, pinDirective } from "../validation/schemas.js";
import { groupPeople } from "../views.js";
import { ackDirective, pinAsDirective } from "../workflows/directives.js";

// The people in this group, other than the manager, who can be asked to confirm.
function addressedIn(store, group, wanted) {
  const people = groupPeople(store, group).filter(({ kind }) => kind !== "manager");
  const addressed = wanted ? people.filter(({ id }) => wanted.includes(id)) : people;
  if (addressed.length === 0) throw badRequest("Choose at least one person in this group.");
  return addressed;
}

async function pinMessage(req, res) {
  const { store } = req.app.locals;
  const message = store.messages.get(req.valid.params.id);
  const group = message && store.groups.get(message.groupId);
  if (!group || group.eventId !== req.user.eventId) throw notFound("No such message.");
  if (!canMarkDirective(store.roleOf(req.user)))
    throw forbidden("Only the event manager can pin a directive.");
  if (message.authorKind !== "human")
    throw badRequest("Only a message a person wrote can be pinned.");
  if ([...store.directives.values()].some(({ messageId }) => messageId === message.id))
    throw badRequest("This message is already pinned.");
  const addressed = addressedIn(store, group, req.valid.body.addressedUserIds);
  const event = store.events.get(group.eventId);
  res.status(201).json(await pinAsDirective(store, { event, group, message, addressed }));
}

function acknowledge(req, res) {
  const { store } = req.app.locals;
  const directive = store.directives.get(req.valid.params.id);
  const group = directive && store.groups.get(directive.groupId);
  if (!group || group.eventId !== req.user.eventId) throw notFound("No such directive.");
  if (!canView(store.roleOf(req.user), { type: "group", group }))
    throw forbidden("You are not in this group.");
  if (!directive.addressedUserIds.includes(req.user.id))
    throw forbidden("This directive wasn't addressed to you.");
  const view = ackDirective(store, directive, req.user.id);
  res.json({ directive: view, status: view.status });
}

/**
 * Directive routes.
 * @param {{ai: import("express").RequestHandler}} limits The AI rate limit.
 * @returns {import("express").Router} The routes.
 */
export function directiveRoutes({ ai }) {
  const router = Router();
  router.post("/messages/:id/directive", requireUser, ai, validate(pinDirective), pinMessage);
  router.post("/directives/:id/ack", requireUser, validate(idParam), acknowledge);
  return router;
}
