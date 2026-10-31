import rateLimit from "express-rate-limit";

export const USER_COOKIE = "huddle_user";

/**
 * Sets the "View as" cookie. Lax is enough: no GET route changes state, so cross-site POSTs stay blocked.
 * @param {import("express").Response} res The response.
 * @param {string} userId The seeded user to view as.
 */
export function setUserCookie(res, userId) {
  res.cookie(USER_COOKIE, userId, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
  });
}

/**
 * Builds an error the error handler sends to the client as-is, so its message must be safe to show.
 * @param {number} status HTTP status.
 * @param {string} code One of the error codes in docs/interfaces.md.
 * @param {string} message Client-facing message.
 * @returns {Error} Pass it to `next` or throw it.
 */
export function HttpError(status, code, message) {
  return Object.assign(new Error(message), { name: "HttpError", status, code });
}

/**
 * Reads one cookie by name without building an object, so keys like "__proto__" are never assigned.
 * @param {string} [header] Raw Cookie header.
 * @returns {string | undefined} Decoded value, or undefined if absent or badly encoded.
 */
function readUserCookie(header = "") {
  for (const pair of header.split(";")) {
    const eq = pair.indexOf("=");
    if (eq !== -1 && pair.slice(0, eq).trim() === USER_COOKIE) {
      try {
        return decodeURIComponent(pair.slice(eq + 1).trim());
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

/**
 * Reads the "View as" cookie from a request.
 * @param {import("express").Request} req The request.
 * @returns {string | undefined} The user id the cookie names, if any.
 */
export const readUserId = (req) => readUserCookie(req.headers.cookie);

/**
 * Resolves the "View as" cookie to a seeded user and sets `req.user`; otherwise responds 401.
 * AI members are refused because the cookie is client-controlled and agents may post anywhere.
 * @type {import("express").RequestHandler}
 */
export function requireUser(req, _res, next) {
  const user = req.app.locals.store.users.get(readUserId(req));
  if (!user || user.kind === "agent") {
    return next(HttpError(401, "UNAUTHENTICATED", "Choose a user to view as first."));
  }
  req.user = user;
  next();
}

/**
 * Route rule: every route with an event :id first checks it is the user's own event.
 * @param {import("express").Request} req The request.
 * @returns {object} The event.
 * @throws {Error} 404 for a missing event or another event's id, so the two look the same.
 */
export function ownEvent(req) {
  const event = req.app.locals.store.events.get(req.params.id);
  if (!event || event.id !== req.user.eventId) throw HttpError(404, "NOT_FOUND", "No such event.");
  return event;
}

/**
 * Like `ownEvent`, and also requires the event manager.
 * @param {import("express").Request} req The request.
 * @returns {object} The event.
 * @throws {Error} 404 as `ownEvent`, or 403 for anyone but the manager.
 */
export function managerOnly(req) {
  const event = ownEvent(req);
  if (req.user.kind !== "manager")
    throw HttpError(403, "FORBIDDEN", "Only the event manager can do this.");
  return event;
}

/**
 * Gets an event's budget, which exists once intake is confirmed.
 * @param {object} store The store.
 * @param {{id: string}} event The event.
 * @returns {object} BudgetState.
 * @throws {Error} 404 before the workspace exists.
 */
export function requireBudget(store, event) {
  const state = store.budgets.get(event.id);
  if (!state) throw HttpError(404, "NOT_FOUND", "This event has no budget yet.");
  return state;
}

/**
 * Validates a request with a zod schema over `{ body, params, query }` and sets `req.valid` to the
 * parsed result. Only the field path is reported: zod's messages can echo client-supplied keys.
 * @param {import("zod").ZodType} schema
 * @returns {import("express").RequestHandler}
 */
export function validate(schema) {
  return (req, _res, next) => {
    const result = schema.safeParse({ body: req.body, params: req.params, query: req.query });
    if (!result.success) {
      const field = result.error.issues[0].path.join(".").slice(0, 100);
      return next(HttpError(400, "BAD_REQUEST", `Invalid request${field && `: ${field}`}`));
    }
    req.valid = result.data;
    next();
  };
}

/**
 * Creates a rate limiter with its own in-memory counters, for routes that can call a model.
 * @param {{ windowMs: number, max: number }} options
 * @returns {import("express").RequestHandler}
 */
export function createAiLimiter({ windowMs, max }) {
  return rateLimit({
    windowMs,
    limit: max,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    handler: (_req, _res, next) =>
      next(HttpError(429, "RATE_LIMITED", "Too many requests. Please try again shortly.")),
  });
}

/**
 * Maps any error to a status, code and message that are safe to send.
 * @param {*} err
 * @param {import("express").Request} req
 * @returns {{ status: number, code: string, message: string }}
 */
function describeError(err, req) {
  if (err.name === "HttpError") return err;
  if (err.name === "MulterError") {
    return err.code === "LIMIT_FILE_SIZE"
      ? { status: 413, code: "PAYLOAD_TOO_LARGE", message: "That file is larger than 5 MB." }
      : { status: 400, code: "BAD_REQUEST", message: "Invalid upload." };
  }
  if (err.type === "entity.too.large") {
    return { status: 413, code: "PAYLOAD_TOO_LARGE", message: "Request body is too large." };
  }
  // Library 4xx messages can quote the request (body-parser includes a JSON snippet), so drop them.
  if (err.status >= 400 && err.status < 500) {
    return { status: 400, code: "BAD_REQUEST", message: "Invalid request." };
  }
  // Only the name: error messages can carry message contents or provider keys.
  console.error(`Unhandled ${err.name} on ${req.method} ${req.path}`);
  return { status: 500, code: "INTERNAL", message: "Something went wrong." };
}

/**
 * Express error handler. Every API error leaves here as `{ error: { code, message } }`.
 * @type {import("express").ErrorRequestHandler}
 */
export function errorHandler(err, req, res, next) {
  if (res.headersSent) return next(err);
  const { status, code, message } = describeError(err, req);
  res.status(status).json({ error: { code, message } });
}
