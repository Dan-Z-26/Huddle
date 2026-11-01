/** Wires the Express app: security headers, rate limits, routes and static files. */
import { fileURLToPath } from "node:url";
import express from "express";
import helmet from "helmet";
import { MINUTE_MS } from "./core/time.js";
import { createLimiter, errorHandler, notFound, refuseCrossSite } from "./http.js";
import { budgetRoutes } from "./routes/budget.js";
import { directiveRoutes } from "./routes/directives.js";
import { eventRoutes } from "./routes/events.js";
import { expenseRoutes } from "./routes/expenses.js";
import { fileRoutes } from "./routes/files.js";
import { groupRoutes } from "./routes/groups.js";
import { hiringRoutes } from "./routes/hiring.js";
import { intakeRoutes } from "./routes/intake.js";
import { messageRoutes } from "./routes/messages.js";
import { sessionRoutes } from "./routes/session.js";
import { streamRoutes } from "./routes/stream.js";
import { timelineRoutes } from "./routes/timeline.js";
import { joinRoute, vendorAccessRoutes } from "./routes/vendorAccess.js";
import { vendorRoutes } from "./routes/vendors.js";
import { createHub } from "./sse.js";
import { removeUploads } from "./store/files.js";

const PUBLIC_DIR = fileURLToPath(new URL("../public", import.meta.url));
const DEFAULT_UPLOADS = fileURLToPath(new URL("../data/uploads", import.meta.url));
const API_PER_MINUTE = 600;
const AI_PER_MINUTE = 30;
const CHAT_PER_MINUTE = 120;

function securityHeaders() {
  return helmet({
    contentSecurityPolicy: {
      // useDefaults would add style-src 'unsafe-inline' and upgrade-insecure-requests,
      // and Safari would then upgrade http://localhost to https.
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        imgSrc: ["'self'"],
        connectSrc: ["'self'"],
        fontSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
      },
    },
    xFrameOptions: { action: "deny" },
  });
}

function apiRouters() {
  // One budget of AI calls per client across every route, because they all draw on one API key.
  const ai = createLimiter({ windowMs: MINUTE_MS, max: AI_PER_MINUTE });
  const chat = createLimiter({ windowMs: MINUTE_MS, max: CHAT_PER_MINUTE });
  return [
    sessionRoutes(),
    streamRoutes(),
    eventRoutes({ ai }),
    intakeRoutes({ ai }),
    budgetRoutes({ ai }),
    expenseRoutes({ ai }),
    hiringRoutes({ ai }),
    vendorAccessRoutes(),
    timelineRoutes({ ai }),
    vendorRoutes({ ai }),
    groupRoutes(),
    directiveRoutes({ ai }),
    messageRoutes({ ai, chat }),
    fileRoutes(),
  ];
}

/**
 * Builds the Express app without listening, so tests can run it on port 0.
 * @param {{store: ReturnType<typeof import("./store/index.js").createStore>, uploadsDir?: string}}
 *   deps The store, and where uploads go, outside `public/`.
 * @returns {import("express").Express} The app.
 */
export function createApp({ store, uploadsDir = DEFAULT_UPLOADS }) {
  const app = express();
  app.disable("x-powered-by");
  app.locals.store = store;
  app.locals.uploadsDir = uploadsDir;
  const hub = createHub();
  app.locals.hub = hub;
  store.publish = (event) => hub.send(store, event);
  store.discardFiles = (records) => removeUploads(uploadsDir, records);
  // A hop count, never `true`, which would let clients spoof the IP the rate limits key on.
  app.set("trust proxy", Number(process.env.TRUST_PROXY_HOPS) || 0);

  app.use(securityHeaders());
  app.use((_req, res, next) => {
    res.set("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=()");
    next();
  });
  // A ceiling on everything, high enough for a whole team behind one address. It comes before the
  // body is read, so a flood can't make the server parse anything.
  app.use("/api", createLimiter({ windowMs: MINUTE_MS, max: API_PER_MINUTE }), refuseCrossSite);
  app.use(express.json({ limit: "100kb" }));
  app.use("/api", (_req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });
  app.use("/api", ...apiRouters());
  app.use("/api", (_req, _res, next) => next(notFound("Not found.")));
  app.use(joinRoute());
  app.use(express.static(PUBLIC_DIR));
  app.use(errorHandler);
  return app;
}
