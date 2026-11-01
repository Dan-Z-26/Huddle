import { randomUUID } from "node:crypto";
import { Router } from "express";
import { taskFromDirective as wordTask } from "../agents/planner.js";
import { mentionsMoney } from "../core/amount.js";
import { canMarkDirective, canView } from "../core/permissions.js";
import { getTemplate } from "../core/templates.js";
import { taskFromDirective } from "../core/timelinePlanner.js";
import { HttpError, requireUser, validate } from "../http.js";
import { pinDirective, quoteParam } from "../validation/schemas.js";
import { directiveView, groupPeople } from "./views.js";

const GENERIC_TITLE = "Follow up on the manager's directive (details in the group)";

/**
 * Records that someone has acknowledged a directive, and tells everyone connected.
 * @param {object} store The store.
 * @param {object} directive The directive.
 * @param {string} userId Who acknowledged it; the caller has checked they were addressed.
 * @returns {object} The directive with its status.
 */
export function ackDirective(store, directive, userId) {
  const group = store.groups.get(directive.groupId);
  if (!directive.acks.some((ack) => ack.userId === userId))
    directive.acks.push({ userId, at: new Date().toISOString() });
  const view = directiveView(store, directive);
  store.publish({
    type: "directive.updated",
    eventId: group.eventId,
    groupId: group.id,
    directive: view,
  });
  store.publish({ type: "attention.updated", eventId: group.eventId });
  return view;
}

/** Directives: the manager pins a message, the people it names tap "Got it". */
export function directiveRoutes({ ai }) {
  const router = Router();

  router.post(
    "/messages/:id/directive",
    requireUser,
    ai,
    validate(pinDirective),
    async (req, res) => {
      const { store } = req.app.locals;
      const message = store.messages.get(req.valid.params.id);
      const group = message && store.groups.get(message.groupId);
      if (!group || group.eventId !== req.user.eventId)
        throw HttpError(404, "NOT_FOUND", "No such message.");
      if (!canMarkDirective(store.roleOf(req.user)))
        throw HttpError(403, "FORBIDDEN", "Only the event manager can pin a directive.");
      if (message.authorKind !== "human")
        throw HttpError(400, "BAD_REQUEST", "Only a message a person wrote can be pinned.");
      if ([...store.directives.values()].some(({ messageId }) => messageId === message.id))
        throw HttpError(400, "BAD_REQUEST", "This message is already pinned.");

      // The people in this group, other than the manager, who can be asked to confirm.
      const people = groupPeople(store, group).filter(({ kind }) => kind !== "manager");
      const wanted = req.valid.body.addressedUserIds;
      const addressed = wanted ? people.filter(({ id }) => wanted.includes(id)) : people;
      if (addressed.length === 0)
        throw HttpError(400, "BAD_REQUEST", "Choose at least one person in this group.");

      const nowIso = new Date().toISOString();
      const event = store.events.get(group.eventId);
      const directive = {
        id: `d-${randomUUID().slice(0, 8)}`,
        messageId: message.id,
        groupId: group.id,
        addressedUserIds: addressed.map(({ id }) => id),
        acks: [],
        createdAt: nowIso,
        remindedAt: null,
        taskId: null,
      };
      // The Planner turns it into a timeline task: the title and owner are worded by the model, the
      // due date is read from the text in code.
      const wording = await wordTask({
        directiveText: message.text,
        template: getTemplate(event.eventType),
        nowIso,
      });
      const owner = store.groups.get(`g-${event.id}-${wording.ownerGroupSlug}`) ?? group;
      // The timeline is visible to everyone, so an amount typed into a directive stays out of it.
      const title = mentionsMoney(wording.title) ? GENERIC_TITLE : wording.title;
      const task = {
        ...taskFromDirective(directive, {
          title,
          ownerGroupId: owner.id,
          dueDate: wording.dueDate,
        }),
        eventId: event.id,
      };
      directive.taskId = task.id;
      store.tasks.set(task.id, task);
      store.directives.set(directive.id, directive);

      const view = directiveView(store, directive);
      store.publish({
        type: "directive.updated",
        eventId: event.id,
        groupId: group.id,
        directive: view,
      });
      store.publish({ type: "timeline.updated", eventId: event.id });
      store.publish({ type: "attention.updated", eventId: event.id });
      store.reactInDemo?.("directive", { event, directive });
      res.status(201).json({ directive: view, task });
    },
  );

  router.post("/directives/:id/ack", requireUser, validate(quoteParam), (req, res) => {
    const { store } = req.app.locals;
    const directive = store.directives.get(req.valid.params.id);
    const group = directive && store.groups.get(directive.groupId);
    if (!group || group.eventId !== req.user.eventId)
      throw HttpError(404, "NOT_FOUND", "No such directive.");
    if (!canView(store.roleOf(req.user), { type: "group", group }))
      throw HttpError(403, "FORBIDDEN", "You are not in this group.");
    if (!directive.addressedUserIds.includes(req.user.id))
      throw HttpError(403, "FORBIDDEN", "This directive wasn't addressed to you.");
    const view = ackDirective(store, directive, req.user.id);
    res.json({ directive: view, status: view.status });
  });

  return router;
}
