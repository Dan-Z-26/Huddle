import { mkdirSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createApp } from "./app.js";
import { createStore } from "./store/index.js";
import { runReminders } from "./reminders.js";
import { seedDemo } from "./store/seed.js";

try {
  process.loadEnvFile(new URL("../.env", import.meta.url));
} catch (err) {
  if (err.code !== "ENOENT") throw err;
}

const uploadsDir = new URL("../data/uploads/", import.meta.url);

const port = process.env.PORT || 3000;
const store = createStore();
seedDemo(store);
createApp({ store, uploadsDir: fileURLToPath(uploadsDir) }).listen(port, (err) => {
  if (err) throw err;
  // Demo storage is not persistent. This runs only once we hold the port, so a second start on a
  // busy port can't delete the running server's files. Sync on purpose: awaiting fs/promises
  // before listen made a busy port exit 0 silently (Node 26).
  rmSync(uploadsDir, { recursive: true, force: true });
  mkdirSync(uploadsDir, { recursive: true });
  // How long a directive may sit unacknowledged before the Timeline agent nudges, and how often to look.
  const slaMinutes = Number(process.env.DIRECTIVE_SLA_MINUTES) || 120;
  setInterval(() => {
    runReminders(store, new Date().toISOString(), { slaMinutes }).catch((err) =>
      console.error(`Reminders failed with ${err.name}`),
    );
  }, 60_000).unref();
  console.log(`Huddle listening on http://localhost:${port}`);
});
