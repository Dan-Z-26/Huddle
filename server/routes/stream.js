/** The live event stream. */
import { Router } from "express";
import { HttpError, requireUser } from "../http.js";

/** One Server-Sent Events stream per client, with each event filtered by what the person may see. */
export function streamRoutes() {
  const router = Router();

  router.get("/stream", requireUser, (req, res, next) => {
    if (!req.app.locals.hub.add(res, req.user, req.session.id, req.ip))
      return next(HttpError(429, "RATE_LIMITED", "Too many open connections."));
  });

  return router;
}
