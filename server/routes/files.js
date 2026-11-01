import { Router } from "express";
import { canView } from "../core/permissions.js";
import { HttpError, requireUser, validate } from "../http.js";
import { readUpload } from "../store/files.js";
import { fileParam } from "../validation/schemas.js";

/** Downloading an attachment. A file is visible only to members of the group it was posted in. */
export function fileRoutes() {
  const router = Router();

  router.get("/files/:id", requireUser, validate(fileParam), async (req, res) => {
    const { store, uploadsDir } = req.app.locals;
    const record = store.files.get(req.valid.params.id);
    const group = record && store.groups.get(record.groupId);
    if (!group || group.eventId !== req.user.eventId)
      throw HttpError(404, "NOT_FOUND", "No such file.");
    if (!canView(store.roleOf(req.user), { type: "file", group }))
      throw HttpError(403, "FORBIDDEN", "You are not in the group this file was posted in.");
    // Rival quotes and budgets can live in this group's files, so a vendor gets only their own.
    if (req.user.kind === "vendor" && record.uploadedBy !== req.user.id)
      throw HttpError(403, "FORBIDDEN", "This file is for the event team.");
    const bytes = await readUpload(uploadsDir, record).catch(() => {
      throw HttpError(404, "NOT_FOUND", "No such file.");
    });
    // Header values must be plain ASCII: a readable fallback, and the real name in filename*.
    const ascii = record.originalName.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "");
    res.set({
      "Content-Type": record.mime,
      "Content-Disposition": `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(record.originalName)}`,
      // The type was checked from the file's own bytes when it was saved; browsers must not guess.
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "sandbox; default-src 'none'",
    });
    res.send(bytes);
  });

  return router;
}
