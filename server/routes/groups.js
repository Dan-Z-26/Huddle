/** The manager adds, renames and removes groups, and chooses who is in them. */
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { Router } from "express";
import { canManageGroups } from "../core/permissions.js";
import { getTemplate } from "../core/templates.js";
import { badRequest, forbidden, managerOnly, ownRecord, requireUser, validate } from "../http.js";
import { CORE_TEAM, groupIdFor } from "../store/ids.js";
import { deleteGroup } from "../store/workspace.js";
import { createGroup as createGroupSchema, idParam, patchGroup } from "../validation/schemas.js";

const MAX_GROUPS = 20;
const MIN_SLUG = 2;

// A name must leave something to build the group's slug from.
function slugOf(name) {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  if (slug.length < MIN_SLUG) throw badRequest("Please use letters or numbers in the name.");
  return slug;
}

// The manager and the AI members are always in every group; only the other roles are chosen.
function membersFor(template, chosen) {
  const known = new Set(template.roles.map(({ id }) => id));
  if (chosen.some((id) => !known.has(id))) throw badRequest("Unknown role.");
  const fixed = template.roles
    .filter(({ kind }) => kind === "manager" || kind === "agent")
    .map(({ id }) => id);
  return [...new Set([...fixed, ...chosen])];
}

function managedGroup(req) {
  const { store } = req.app.locals;
  const group = ownRecord(req, store.groups, "group");
  if (!canManageGroups(store.roleOf(req.user)))
    throw forbidden("Only the event manager can change groups.");
  return group;
}

function addGroup(req, res) {
  const { store } = req.app.locals;
  const event = managerOnly(req);
  const { name, memberRoleIds } = req.valid.body;
  const slug = slugOf(name);
  const id = groupIdFor(event.id, slug);
  if (store.groups.has(id)) throw badRequest("A group with that name exists.");
  const mine = [...store.groups.values()].filter(({ eventId }) => eventId === event.id);
  if (mine.length >= MAX_GROUPS) throw badRequest("That is as many groups as the demo allows.");
  const group = {
    id,
    eventId: event.id,
    slug,
    name,
    // Not tied to a category, so anyone the manager puts in it can post.
    kind: "custom",
    memberRoleIds: membersFor(getTemplate(event.eventType), memberRoleIds),
    categoryIds: [],
  };
  store.groups.set(id, group);
  store.nudge(event.id, "groups.updated");
  res.status(201).json({ group });
}

function changeGroup(req, res) {
  const { store } = req.app.locals;
  const group = managedGroup(req);
  const { name, memberRoleIds } = req.valid.body;
  // Announcements is where everyone is told things, so it keeps its members.
  if (memberRoleIds && group.kind === "announcements")
    throw badRequest("Everyone is always in Announcements.");
  if (name) {
    slugOf(name);
    // Only the name changes: the id and slug stay, so notices still find the group.
    group.name = name;
  }
  if (memberRoleIds) {
    const template = getTemplate(store.events.get(group.eventId).eventType);
    // The form lists the team's roles; a booked vendor stays in until they are replaced.
    const vendors = group.memberRoleIds.filter((id) => id.startsWith("vendor-"));
    group.memberRoleIds = [...membersFor(template, memberRoleIds), ...vendors];
  }
  store.nudge(group.eventId, "groups.updated");
  res.json({ group });
}

async function removeGroup(req, res) {
  const { store, uploadsDir } = req.app.locals;
  const group = managedGroup(req);
  if (group.kind === "announcements" || group.slug === CORE_TEAM)
    throw badRequest("That group is needed and can't be removed.");
  const files = deleteGroup(store, group);
  await Promise.all(
    files.map(({ storedName }) => rm(join(uploadsDir, storedName), { force: true })),
  );
  store.nudge(group.eventId, "groups.updated", "timeline.updated");
  res.status(204).end();
}

/**
 * Group routes.
 * @returns {import("express").Router} The routes.
 */
export function groupRoutes() {
  const router = Router();
  router.post("/events/:id/groups", requireUser, validate(createGroupSchema), addGroup);
  router.patch("/groups/:id", requireUser, validate(patchGroup), changeGroup);
  router.delete("/groups/:id", requireUser, validate(idParam), removeGroup);
  return router;
}
