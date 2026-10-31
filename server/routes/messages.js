import { Router } from "express";
import { canView } from "../core/permissions.js";
import { HttpError, requireUser, validate } from "../http.js";
import { groupMessages } from "../validation/schemas.js";

/** Reading a group's history. Posting arrives with the rest of the team workspace. */
export function messageRoutes() {
  const router = Router();

  router.get("/groups/:id/messages", requireUser, validate(groupMessages), (req, res, next) => {
    const { store } = req.app.locals;
    const group = store.groups.get(req.valid.params.id);
    // Other events' groups look the same as missing ones.
    if (!group || group.eventId !== req.user.eventId)
      return next(HttpError(404, "NOT_FOUND", "No such group."));
    if (!canView(store.roleOf(req.user), { type: "group", group }))
      return next(HttpError(403, "FORBIDDEN", "You are not in this group."));
    const { before, limit } = req.valid.query;
    res.json(store.messagesForGroup(group.id, { before, limit }));
  });

  return router;
}
