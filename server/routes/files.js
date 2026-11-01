/** Downloading an attachment. A file is visible only to members of the group it was posted in. */
import { Router } from "express";
import { canView } from "../core/permissions.js";
import { forbidden, notFound, requireUser, validate } from "../http.js";
import { readUpload } from "../store/files.js";
import { idParam } from "../validation/schemas.js";

// Header values must be plain ASCII: a readable fallback, and the real name in filename*.
function contentDisposition(name) {
  const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

async function downloadFile(req, res) {
  const { store, uploadsDir } = req.app.locals;
  const record = store.files.get(req.valid.params.id);
  const group = record && store.groups.get(record.groupId);
  if (!group || group.eventId !== req.user.eventId) throw notFound("No such file.");
  if (!canView(store.roleOf(req.user), { type: "file", group }))
    throw forbidden("You are not in the group this file was posted in.");
  // Rival quotes and budgets can live in this group's files, so a vendor gets only their own.
  if (req.user.kind === "vendor" && record.uploadedBy !== req.user.id)
    throw forbidden("This file is for the event team.");
  const bytes = await readUpload(uploadsDir, record).catch(() => {
    throw notFound("No such file.");
  });
  res.set({
    "Content-Type": record.mime,
    "Content-Disposition": contentDisposition(record.originalName),
    // The type was checked from the file's own bytes when it was saved; browsers must not guess.
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "sandbox; default-src 'none'",
  });
  res.send(bytes);
}

/**
 * File routes.
 * @returns {import("express").Router} The routes.
 */
export function fileRoutes() {
  const router = Router();
  router.get("/files/:id", requireUser, validate(idParam), downloadFile);
  return router;
}
