/** A booked vendor's way in: the invite link, what they see, and ticking off deliverables. */
import { createHash, randomBytes } from "node:crypto";
import { Router } from "express";
import { getTemplate } from "../core/templates.js";
import { DAY_MS, MINUTE_MS } from "../core/time.js";
import {
  createLimiter,
  forbidden,
  notFound,
  requireUser,
  sessionOf,
  startSession,
  validate,
} from "../http.js";
import * as schemas from "../validation/schemas.js";
import { deliverablesOf } from "../workflows/booking.js";
import { briefOf } from "../workflows/briefs.js";
import { requireCategory } from "../workflows/vendors.js";

const INVITE_DAYS = 7;
const INVITE_TOKEN_BYTES = 24;
const MAX_TOKEN_LENGTH = 200;
const JOINS_PER_MINUTE = 30;
const hashOf = (token) => createHash("sha256").update(token).digest("hex");

function findVendor(req) {
  const { store } = req.app.locals;
  const vendor = store.users.get(req.valid.params.id);
  if (vendor?.kind !== "vendor" || vendor.eventId !== req.user.eventId)
    throw notFound("No such vendor.");
  const event = store.events.get(vendor.eventId);
  requireCategory(req, getTemplate(event.eventType), vendor.categoryIds[0]);
  return vendor;
}

// A new or revoked link ends the old one, and anyone already in through it.
function endInvites(store, vendorId) {
  for (const [hash, invite] of store.invites)
    if (invite.vendorUserId === vendorId) store.invites.delete(hash);
  for (const [id, session] of store.sessions)
    if (session.invited && session.userId === vendorId) store.sessions.delete(id);
}

function createInvite(req, res) {
  const { store } = req.app.locals;
  const vendor = findVendor(req);
  endInvites(store, vendor.id);
  const token = randomBytes(INVITE_TOKEN_BYTES).toString("base64url");
  const expiresAt = Date.now() + INVITE_DAYS * DAY_MS;
  // Only a hash is kept: the link itself is shown once, to whoever created it.
  store.invites.set(hashOf(token), { vendorUserId: vendor.id, expiresAt });
  res.status(201).json({ path: `/join/${token}`, expiresAt: new Date(expiresAt).toISOString() });
}

function revokeInvite(req, res) {
  endInvites(req.app.locals.store, findVendor(req).id);
  res.status(204).end();
}

// Everything a booked vendor sees beyond their group: the brief and what to hand over.
function vendorHome(req, res) {
  const { store } = req.app.locals;
  if (req.user.kind !== "vendor") throw forbidden("This page is for booked vendors.");
  const brief = briefOf(store, req.user.eventId, req.user.categoryIds[0]);
  res.json({ brief: brief?.text ?? "", deliverables: deliverablesOf(store, req.user.id) });
}

function markDeliverable(req, res) {
  const { store } = req.app.locals;
  const item = store.deliverables.get(req.valid.params.id);
  if (!item || item.vendorUserId !== req.user.id) throw notFound("No such deliverable.");
  item.done = req.valid.body.done;
  // Everything handed over closes the team's follow-up task.
  const allDone = deliverablesOf(store, req.user.id).every(({ done }) => done);
  const task = store.tasks.get(`${item.eventId}-task-hire-${req.user.categoryIds[0]}-deliverables`);
  if (task) {
    task.status = allDone ? "done" : "todo";
    if (allDone) task.atRisk = false;
  }
  store.nudge(item.eventId, "timeline.updated");
  res.json({ deliverable: item });
}

function followInvite(req, res) {
  const { store } = req.app.locals;
  const invite = store.invites.get(hashOf(String(req.params.token).slice(0, MAX_TOKEN_LENGTH)));
  const vendor = invite && store.users.get(invite.vendorUserId);
  if (!vendor || invite.expiresAt <= Date.now()) {
    res.redirect("/?invite=invalid");
    return;
  }
  // Nothing else leads back to a private event, so a link someone sent can't sign them out of it.
  const current = sessionOf(req);
  if (current && !current.invited && store.users.has(current.userId)) {
    res.redirect("/?invite=signed-in");
    return;
  }
  startSession(res, store, vendor.id, { invited: true });
  res.redirect("/");
}

/**
 * Invite links, and what a booked vendor sees and does.
 * @returns {import("express").Router} The routes.
 */
export function vendorAccessRoutes() {
  const router = Router();
  router.post("/vendors/:id/invite", requireUser, validate(schemas.idParam), createInvite);
  router.delete("/vendors/:id/invite", requireUser, validate(schemas.idParam), revokeInvite);
  router.get("/vendor/home", requireUser, vendorHome);
  router.patch(
    "/deliverables/:id",
    requireUser,
    validate(schemas.patchDeliverable),
    markDeliverable,
  );
  return router;
}

/**
 * The vendor's invite link: an expiring, revocable way in that signs them in as themselves only.
 * @returns {import("express").Router} The route, outside /api because people follow it from a message.
 */
export function joinRoute() {
  const router = Router();
  const joins = createLimiter({ windowMs: MINUTE_MS, max: JOINS_PER_MINUTE });
  router.get("/join/:token", joins, followInvite);
  return router;
}
