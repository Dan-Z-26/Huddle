import rateLimit from "express-rate-limit";

export const SESSION_COOKIE = "huddle_session";
const SESSION_MS = 24 * 3_600_000;

/**
 * Signs a person in: a new server-side session, with only its random id in the cookie. Lax, because
 * an invite link has to see who is already signed in; `refuseCrossSite` covers what Strict would.
 * @param {import("express").Response} res The response.
 * @param {object} store The store.
 * @param {string} userId The person.
 * @param {{invited?: boolean}} [options] Passed on to `store.openSession`.
 */
export function startSession(res, store, userId, options) {
  res.cookie(SESSION_COOKIE, store.openSession(userId, options), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: SESSION_MS,
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
function readSessionCookie(header = "") {
  for (const pair of header.split(";")) {
    const eq = pair.indexOf("=");
    if (eq !== -1 && pair.slice(0, eq).trim() === SESSION_COOKIE) {
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
 * Reads the session id from a request.
 * @param {import("express").Request} req The request.
 * @returns {string | undefined} The id the cookie holds, if any.
 */
export const readSessionId = (req) => readSessionCookie(req.headers.cookie);

/** Whether a session has passed its lifetime. */
export const sessionExpired = ({ startedAt }) => Date.now() - startedAt > SESSION_MS;

/**
 * The live session behind a request, if any. The role always comes from the session's user, so a
 * client can never choose or upgrade it.
 * @param {import("express").Request} req The request.
 * @returns {{id: string, userId: string, invited: boolean, startedAt: number} | null} The session.
 */
export function sessionOf(req) {
  const { store } = req.app.locals;
  const id = readSessionId(req);
  const session = id === undefined ? undefined : store.sessions.get(id);
  if (!session) return null;
  if (sessionExpired(session)) {
    store.sessions.delete(id);
    return null;
  }
  return { id, ...session };
}

/**
 * Resolves the session to a person and sets `req.user`; otherwise responds 401.
 * @type {import("express").RequestHandler}
 */
export function requireUser(req, _res, next) {
  const session = sessionOf(req);
  const user = session && req.app.locals.store.users.get(session.userId);
  if (!user || user.kind === "agent") {
    return next(HttpError(401, "UNAUTHENTICATED", "Please sign in first."));
  }
  req.user = user;
  req.session = session;
  next();
}

/**
 * Route rule: every route with an event :id first checks it is the user's own event. Vendors are
 * refused by default: only the few routes meant for them pass `vendorsToo`.
 * @param {import("express").Request} req The request.
 * @param {{vendorsToo?: boolean}} [options] Lets a vendor through.
 * @returns {object} The event.
 * @throws {Error} 404 for a missing event or another event's id, so the two look the same; 403 for
 *   a vendor.
 */
export function ownEvent(req, { vendorsToo = false } = {}) {
  const event = req.app.locals.store.events.get(req.params.id);
  if (!event || event.id !== req.user.eventId) throw HttpError(404, "NOT_FOUND", "No such event.");
  if (req.user.kind === "vendor" && !vendorsToo)
    throw HttpError(403, "FORBIDDEN", "This is for the event team.");
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
 * Creates a rate limiter with its own in-memory counters, keyed by client address.
 * @param {{ windowMs: number, max: number }} options
 * @returns {import("express").RequestHandler}
 */
export function createLimiter({ windowMs, max }) {
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
 * Refuses a write that a browser says came from another site, which a page there can't fake. Tools
 * send no such header, and they have no cookie for a page to borrow.
 * @type {import("express").RequestHandler}
 */
export function refuseCrossSite(req, _res, next) {
  const from = req.get("sec-fetch-site");
  const isWrite = !["GET", "HEAD", "OPTIONS"].includes(req.method);
  if (isWrite && from && from !== "same-origin" && from !== "none")
    return next(HttpError(403, "FORBIDDEN", "This request came from another site."));
  return next();
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
  // Only the name and the route's pattern: messages can carry contents or keys, and real paths
  // can carry invite tokens and ids.
  console.error(`Unhandled ${err.name} on ${req.method} ${req.route?.path ?? "(no route)"}`);
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
