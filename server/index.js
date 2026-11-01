import { mkdirSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createApp } from "./app.js";
import { createStore } from "./store/index.js";
import { freshenOpeningLines, seedHistory } from "./demo/history.js";
import { installStory } from "./demo/story.js";
import { runDailyDigests, runReminders } from "./reminders.js";
import { seedDemo } from "./store/seed.js";

try {
  process.loadEnvFile(new URL("../.env", import.meta.url));
} catch (err) {
  if (err.code !== "ENOENT") throw err;
}

const uploadsDir = new URL("../data/uploads/", import.meta.url);

const port = process.env.PORT || 3000;
const DEMO_PAST_MS = 2 * 86400000;
const store = createStore();
const startedAt = new Date();
seedDemo(store, new Date(startedAt - DEMO_PAST_MS).toISOString());
seedHistory(store, startedAt.toISOString());
createApp({ store, uploadsDir: fileURLToPath(uploadsDir) }).listen(port, (listenError) => {
  if (listenError) throw listenError;
  // Demo storage is not persistent. This runs only once we hold the port, so a second start on a
  // busy port can't delete the running server's files. Sync on purpose: awaiting fs/promises
  // before listen made a busy port exit 0 silently (Node 26).
  rmSync(uploadsDir, { recursive: true, force: true });
  mkdirSync(uploadsDir, { recursive: true });
  // How long a directive may sit unacknowledged before the Timeline agent nudges, and how often to look.
  const slaMinutes = Number(process.env.DIRECTIVE_SLA_MINUTES) || 120;
  const postDigests = () =>
    runDailyDigests(store, new Date().toISOString()).catch((err) =>
      console.error(`Digests failed with ${err.name}`),
    );
  postDigests();
  freshenOpeningLines(store).catch((err) => console.error(`Opening lines failed with ${err.name}`));
  setInterval(() => {
    runReminders(store, new Date().toISOString(), { slaMinutes }).catch((err) =>
      console.error(`Reminders failed with ${err.name}`),
    );
    postDigests();
  }, 60_000).unref();
  if (process.env.DEMO_STORY !== "off") installStory(store);
  console.log(`Huddle listening on http://localhost:${port}`);
});
