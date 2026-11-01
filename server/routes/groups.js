import { rm } from "node:fs/promises";
import { join } from "node:path";
import { Router } from "express";
import { canManageGroups } from "../core/permissions.js";
import { getTemplate } from "../core/templates.js";
import { HttpError, managerOnly, requireUser, validate } from "../http.js";
import { createGroup, patchGroup, quoteParam } from "../validation/schemas.js";
import { deleteGroup } from "../store/workspace.js";

const MAX_GROUPS = 20;
const slugOf = (name) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

// The manager and the AI members are always in every group; only the other roles are chosen.
function membersFor(template, chosen) {
  const known = new Set(template.roles.map(({ id }) => id));
  if (chosen.some((id) => !known.has(id))) throw HttpError(400, "BAD_REQUEST", "Unknown role.");
  const fixed = template.roles
    .filter(({ kind }) => kind === "manager" || kind === "agent")
    .map(({ id }) => id);
  return [...new Set([...fixed, ...chosen])];
}

/** The manager adds, renames and removes groups, and chooses who is in them. */
export function groupRoutes() {
  const router = Router();

  router.post("/events/:id/groups", requireUser, validate(createGroup), (req, res) => {
    const { store } = req.app.locals;
    const event = managerOnly(req);
    const slug = slugOf(req.valid.body.name);
    if (slug.length < 2)
      throw HttpError(400, "BAD_REQUEST", "Please use letters or numbers in the name.");
    const id = `g-${event.id}-${slug}`;
    if (store.groups.has(id)) throw HttpError(400, "BAD_REQUEST", "A group with that name exists.");
    const mine = [...store.groups.values()].filter(({ eventId }) => eventId === event.id);
    if (mine.length >= MAX_GROUPS)
      throw HttpError(400, "BAD_REQUEST", "That is as many groups as the demo allows.");
    const group = {
      id,
      eventId: event.id,
      slug,
      name: req.valid.body.name,
      // Not tied to a category, so anyone the manager puts in it can post.
      kind: "custom",
      memberRoleIds: membersFor(getTemplate(event.eventType), req.valid.body.memberRoleIds),
      categoryIds: [],
    };
    store.groups.set(id, group);
    store.publish({ type: "groups.updated", eventId: event.id });
    res.status(201).json({ group });
  });

  router.patch("/groups/:id", requireUser, validate(patchGroup), (req, res) => {
    const { store } = req.app.locals;
    const group = store.groups.get(req.valid.params.id);
    if (!group || group.eventId !== req.user.eventId)
      throw HttpError(404, "NOT_FOUND", "No such group.");
    if (!canManageGroups(store.roleOf(req.user)))
      throw HttpError(403, "FORBIDDEN", "Only the event manager can change groups.");
    const { name, memberRoleIds } = req.valid.body;
    // Announcements is where everyone is told things, so it keeps its members.
    if (memberRoleIds && group.kind === "announcements")
      throw HttpError(400, "BAD_REQUEST", "Everyone is always in Announcements.");
    if (name) {
      const slug = slugOf(name);
      if (slug.length < 2)
        throw HttpError(400, "BAD_REQUEST", "Please use letters or numbers in the name.");
      // Only the name changes: the id and slug stay, so notices still find the group.
      group.name = name;
    }
    if (memberRoleIds) {
      const template = getTemplate(store.events.get(group.eventId).eventType);
      // The form lists the team's roles; a booked vendor stays in until they are replaced.
      const vendors = group.memberRoleIds.filter((id) => id.startsWith("vendor-"));
      group.memberRoleIds = [...membersFor(template, memberRoleIds), ...vendors];
    }
    store.publish({ type: "groups.updated", eventId: group.eventId });
    res.json({ group });
  });

  router.delete("/groups/:id", requireUser, validate(quoteParam), async (req, res) => {
    const { store, uploadsDir } = req.app.locals;
    const group = store.groups.get(req.valid.params.id);
    if (!group || group.eventId !== req.user.eventId)
      throw HttpError(404, "NOT_FOUND", "No such group.");
    if (!canManageGroups(store.roleOf(req.user)))
      throw HttpError(403, "FORBIDDEN", "Only the event manager can change groups.");
    if (group.kind === "announcements" || group.slug === "core-team")
      throw HttpError(400, "BAD_REQUEST", "That group is needed and can't be removed.");
    const files = deleteGroup(store, group);
    await Promise.all(
      files.map(({ storedName }) => rm(join(uploadsDir, storedName), { force: true })),
    );
    store.publish({ type: "groups.updated", eventId: group.eventId });
    store.publish({ type: "timeline.updated", eventId: group.eventId });
    res.status(204).end();
  });

  return router;
}
