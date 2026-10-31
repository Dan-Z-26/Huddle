import { createHash, randomBytes } from "node:crypto";
import { Router } from "express";
import { getTemplate } from "../core/templates.js";
import { HttpError, requireUser, startSession, validate } from "../http.js";
import * as schemas from "../validation/schemas.js";
import { briefOf, deliverablesOf } from "./hiringSupport.js";
import { requireCategory } from "./vendorSupport.js";

const INVITE_DAYS = 7;
const DAY_MS = 86400000;
const hashOf = (token) => createHash("sha256").update(token).digest("hex");

function findVendor(req) {
  const { store } = req.app.locals;
  const vendor = store.users.get(req.valid.params.id);
  if (vendor?.kind !== "vendor" || vendor.eventId !== req.user.eventId)
    throw HttpError(404, "NOT_FOUND", "No such vendor.");
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

/** The invite link, and what a booked vendor sees and does. */
export function vendorAccessRoutes() {
  const router = Router();

  router.post("/vendors/:id/invite", requireUser, validate(schemas.vendorParam), (req, res) => {
    const { store } = req.app.locals;
    const vendor = findVendor(req);
    endInvites(store, vendor.id);
    const token = randomBytes(24).toString("base64url");
    const expiresAt = Date.now() + INVITE_DAYS * DAY_MS;
    // Only a hash is kept: the link itself is shown once, to whoever created it.
    store.invites.set(hashOf(token), { vendorUserId: vendor.id, expiresAt });
    res.status(201).json({ path: `/join/${token}`, expiresAt: new Date(expiresAt).toISOString() });
  });

  router.delete("/vendors/:id/invite", requireUser, validate(schemas.vendorParam), (req, res) => {
    const { store } = req.app.locals;
    const vendor = findVendor(req);
    endInvites(store, vendor.id);
    res.status(204).end();
  });

  // Everything a booked vendor sees beyond their group: the brief and what to hand over.
  router.get("/vendor/home", requireUser, (req, res) => {
    const { store } = req.app.locals;
    if (req.user.kind !== "vendor")
      throw HttpError(403, "FORBIDDEN", "This page is for booked vendors.");
    const brief = briefOf(store, req.user.eventId, req.user.categoryIds[0]);
    res.json({
      brief: brief?.text ?? "",
      deliverables: deliverablesOf(store, req.user.id),
    });
  });

  router.patch("/deliverables/:id", requireUser, validate(schemas.patchDeliverable), (req, res) => {
    const { store } = req.app.locals;
    const item = store.deliverables.get(req.valid.params.id);
    if (!item || item.vendorUserId !== req.user.id)
      throw HttpError(404, "NOT_FOUND", "No such deliverable.");
    item.done = req.valid.body.done;
    // Everything handed over closes the team's follow-up task.
    const allDone = deliverablesOf(store, req.user.id).every(({ done }) => done);
    const task = store.tasks.get(
      `${item.eventId}-task-hire-${req.user.categoryIds[0]}-deliverables`,
    );
    if (task) {
      task.status = allDone ? "done" : "todo";
      if (allDone) task.atRisk = false;
    }
    store.publish({ type: "timeline.updated", eventId: item.eventId });
    res.json({ deliverable: item });
  });

  return router;
}

/** The vendor's invite link: an expiring, revocable way in that signs them in as themselves only. */
export function joinRoute() {
  const router = Router();
  router.get("/join/:token", (req, res) => {
    const { store } = req.app.locals;
    const hash = hashOf(String(req.params.token).slice(0, 200));
    const invite = store.invites.get(hash);
    const vendor = invite && store.users.get(invite.vendorUserId);
    if (!vendor || invite.expiresAt <= Date.now()) {
      res.redirect("/?invite=invalid");
      return;
    }
    startSession(res, store, vendor.id, { invited: true });
    res.redirect("/");
  });
  return router;
}
