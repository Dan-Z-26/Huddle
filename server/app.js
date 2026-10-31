import { fileURLToPath } from "node:url";
import express from "express";
import helmet from "helmet";
import { errorHandler, HttpError } from "./http.js";
import { budgetRoutes } from "./routes/budget.js";
import { eventRoutes } from "./routes/events.js";
import { messageRoutes } from "./routes/messages.js";
import { sessionRoutes } from "./routes/session.js";

const PUBLIC_DIR = fileURLToPath(new URL("../public", import.meta.url));

/**
 * Builds the Express app without listening, so tests can run it on port 0.
 * @param {{ store: ReturnType<typeof import("./store/index.js").createStore> }} deps
 * @returns {import("express").Express}
 */
export function createApp({ store }) {
  const app = express();
  app.disable("x-powered-by");
  app.locals.store = store;
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

  app.use("/api", sessionRoutes(), eventRoutes(), budgetRoutes(), messageRoutes());
  app.use("/api", (_req, _res, next) => next(HttpError(404, "NOT_FOUND", "Not found.")));
  app.use(express.static(PUBLIC_DIR));
  app.use(errorHandler);

  return app;
}
