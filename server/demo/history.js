import { randomUUID } from "node:crypto";
import { rewordLines } from "../agents/speech.js";
import { taskFromDirective } from "../core/timelinePlanner.js";
import { DEMO_EVENT_ID as ID } from "../store/seed.js";
import { addMessage } from "../store/workspace.js";

const HOUR_MS = 3600000;
const MANAGER = `user-manager@${ID}`;
const DESIGNER = `user-creative-director@${ID}`;
const PRODUCTION = `user-production-lead@${ID}`;
const FOOD = `user-fb-lead@${ID}`;
const PRESS = `user-pr-head@${ID}`;
const SHORTLIST = "Please confirm the vendor shortlist for your area by Friday.";
// Left open on purpose, so the plan has something at risk to talk about from the first screen.
const STILL_OPEN = `${ID}-task-venue-booked`;

const CHATTER = [
  [30, "core-team", MANAGER, "Morning all. Let's get vendors closed out this month."],
  [29, "core-team", DESIGNER, "The reveal concept is ready. I'll share it with Meera today."],
  [28, "core-team", PRODUCTION, "I'm walking the ballroom with the hotel's AV team on Thursday."],
  [24, "stage-decor", DESIGNER, "The reveal wall opens in two halves. It needs a clear stage."],
  [23, "stage-decor", PRODUCTION, "Then we'll need to check ceiling height at the walk-through."],
  [20, "food-beverage", FOOD, "The hotel's menu is in. The vegetarian options look thin."],
  [19, "food-beverage", FOOD, "I've asked them for two more mains and a proper dessert."],
  [16, "pr-media", PRESS, "The embargo lifts at 11 am. The press list is growing nicely."],
  [12, "music-av", PRODUCTION, "The LED wall supplier can only hold the date with an advance."],
  [8, "core-team", PRESS, "Can we keep the press room next to the ballroom?"],
  [7, "core-team", MANAGER, "Yes, I'll ask the hotel today."],
];

/**
 * Gives the demo event a past: a few days of team chat, finished early tasks, and a directive that
 * only some people have acknowledged. Runs only for the real server, so tests of the plain seed
 * stay small.
 * @param {object} store A store with the demo event seeded.
 * @param {string} nowIso The current time.
 */
export function seedHistory(store, nowIso) {
  const now = Date.parse(nowIso);
  const at = (hours) => new Date(now - hours * HOUR_MS).toISOString();
  const say = (hours, slug, authorId, text) =>
    addMessage(store, {
      id: `m-${randomUUID().slice(0, 8)}`,
      groupId: `g-${ID}-${slug}`,
      authorId,
      authorKind: "human",
      text,
      fileIds: [],
      createdAt: at(hours),
      rationale: null,
    });
  for (const line of CHATTER) say(...line);

  const message = say(0.75, "announcements", MANAGER, SHORTLIST);
  const directive = {
    id: `d-${randomUUID().slice(0, 8)}`,
    messageId: message.id,
    groupId: message.groupId,
    addressedUserIds: [DESIGNER, PRODUCTION, FOOD, PRESS],
    acks: [
      { userId: FOOD, at: at(0.5) },
      { userId: PRESS, at: at(0.25) },
    ],
    createdAt: message.createdAt,
    remindedAt: null,
    taskId: null,
  };
  const task = {
    ...taskFromDirective(directive, {
      title: "Confirm the vendor shortlist",
      ownerGroupId: `g-${ID}-core-team`,
      dueDate: new Date(now + 3 * 24 * HOUR_MS).toISOString(),
    }),
    eventId: ID,
  };
  directive.taskId = task.id;
  store.tasks.set(task.id, task);
  store.directives.set(directive.id, directive);

  for (const item of store.tasksForEvent(ID))
    if (item.id !== STILL_OPEN && item.dueDate < nowIso && item.source !== "directive")
      store.tasks.set(item.id, { ...item, status: "done", atRisk: false });
}

/**
 * Has the model rewrite the Planner's opening lines in the demo's rooms for this event, in one call,
 * so they aren't canned text when a key is set. Runs before anyone is signed in.
 * @param {object} store A store with the demo event.
 * @param {{generate?: Function}} [deps] The model call, replaceable in tests.
 * @returns {Promise<void>} Resolves when done; the lines stay as they are if the model can't.
 */
export async function freshenOpeningLines(store, deps) {
  const event = store.events.get(ID);
  const fromPlanner = [...store.messages.values()].filter(
    ({ authorKind, authorId }) => authorKind === "agent" && authorId === `agent-planner@${ID}`,
  );
  // The seed posts them all at one moment. Anything later is a real reply, which stays as written.
  const opening = fromPlanner.filter(({ createdAt }) => createdAt === fromPlanner[0]?.createdAt);
  const lines = await rewordLines(
    {
      lines: opening.map(({ text }) => text),
      context: JSON.stringify({
        name: event.name,
        purpose: event.purpose,
        city: event.city,
        mustHaves: event.mustHaves.map(({ text }) => text),
      }),
    },
    deps,
  );
  opening.forEach((message, index) => (message.text = lines[index]));
}
