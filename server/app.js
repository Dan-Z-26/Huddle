import { fileURLToPath } from "node:url";
import express from "express";
import helmet from "helmet";
import { createAiLimiter, errorHandler, HttpError } from "./http.js";
import { budgetRoutes } from "./routes/budget.js";
import { directiveRoutes } from "./routes/directives.js";
import { groupRoutes } from "./routes/groups.js";
import { eventRoutes } from "./routes/events.js";
import { messageRoutes } from "./routes/messages.js";
import { sessionRoutes } from "./routes/session.js";
import { streamRoutes } from "./routes/stream.js";
import { createHub } from "./sse.js";
import { removeUploads } from "./store/files.js";
import { timelineRoutes } from "./routes/timeline.js";
import { vendorRoutes } from "./routes/vendors.js";

const PUBLIC_DIR = fileURLToPath(new URL("../public", import.meta.url));
const DEFAULT_UPLOADS = fileURLToPath(new URL("../data/uploads", import.meta.url));

/**
 * Builds the Express app without listening, so tests can run it on port 0.
 * @param {{ store: ReturnType<typeof import("./store/index.js").createStore>, uploadsDir?: string }} deps
 * Uploads go to `uploadsDir`, outside `public/`.
 * @returns {import("express").Express}
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

  app.use(
    helmet({
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
    }),
  );
  app.use(express.json({ limit: "100kb" }));
  app.use("/api", (_req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });

  // One budget of AI calls per client across every route, because they all draw on one API key.
  const ai = createAiLimiter({ windowMs: 60_000, max: 30 });
  const chat = createAiLimiter({ windowMs: 60_000, max: 120 });
  app.use(
    "/api",
    sessionRoutes(),
    streamRoutes(),
    eventRoutes({ ai }),
    budgetRoutes({ ai }),
    timelineRoutes({ ai }),
    vendorRoutes({ ai }),
    groupRoutes(),
    directiveRoutes({ ai }),
    messageRoutes({ ai, chat }),
  );
  app.use("/api", (_req, _res, next) => next(HttpError(404, "NOT_FOUND", "Not found.")));
  app.use(express.static(PUBLIC_DIR));
  app.use(errorHandler);

  return app;
}
