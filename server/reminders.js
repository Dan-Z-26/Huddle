/** The timers' work: daily digests, and reminders for what has waited too long. */
import { reminder } from "./agents/timeline.js";
import { overdue } from "./core/directives.js";
import { dayOf } from "./core/time.js";
import { agentIdFor, ANNOUNCEMENTS, groupIdFor } from "./store/ids.js";
import { postAgentMessage } from "./store/workspace.js";
import { groupPeople } from "./views.js";
import { postSpoken } from "./workflows/agentPost.js";
import { postDigest } from "./workflows/timeline.js";

const MAX_PER_RUN = 5;
const DEFAULT_SLA_MINUTES = 120;

/**
 * Posts today's digest for every event that has a workspace and hasn't had one today.
 * @param {object} store The store.
 * @param {string} nowIso The current time.
 * @returns {Promise<number>} How many were posted.
 */
export async function runDailyDigests(store, nowIso) {
  const today = dayOf(nowIso);
  const due = [...store.events.values()]
    .filter(
      ({ id }) =>
        store.budgets.has(id) &&
        store.groups.has(groupIdFor(id, ANNOUNCEMENTS)) &&
        !store.digests.has(`${id}:${today}`),
    )
    .slice(0, MAX_PER_RUN);
  await Promise.all(due.map((event) => postDigest(store, event, nowIso)));
  return due.length;
}

// Only people still in the group are reminded; someone removed can no longer see it.
function pendingNames(store, group, pendingUserIds) {
  const inGroup = new Set(groupPeople(store, group).map(({ id }) => id));
  return pendingUserIds
    .filter((id) => inGroup.has(id))
    .map((id) => store.users.get(id)?.name)
    .filter(Boolean);
}

// Marked first, so a slow model call can't lead to the same reminder twice, and whatever happens,
// so nobody to remind can't hold up the ones that can be. Says whether a reminder was posted.
async function remindAbout(store, directive, { nowIso, slaMinutes, generate }) {
  const group = store.groups.get(directive.groupId);
  const message = store.messages.get(directive.messageId);
  const { pendingUserIds } = overdue(directive, nowIso, slaMinutes);
  directive.remindedAt = nowIso;
  if (!group || !message) return false;
  const names = pendingNames(store, group, pendingUserIds);
  if (names.length === 0) return false;
  try {
    const { reminderText } = await reminder(
      { directiveText: message.text, pendingNames: names },
      generate ? { generate } : undefined,
    );
    postAgentMessage(store, {
      groupId: group.id,
      authorId: agentIdFor("timeline", group.eventId),
      text: reminderText,
      nowIso,
    });
    return true;
  } catch (err) {
    console.error(`Reminder failed with ${err.name}`);
    return false;
  }
}

// Anything overdue on a booking is reminded once, in the group that owns it. No model needed.
function remindAboutVendorTasks(store, nowIso) {
  const today = dayOf(nowIso);
  const overdueTasks = [...store.tasks.values()]
    .filter(
      ({ source, status, dueDate, remindedAt }) =>
        source === "vendor" && status !== "done" && !remindedAt && dayOf(dueDate) < today,
    )
    .slice(0, MAX_PER_RUN);
  for (const task of overdueTasks) {
    task.remindedAt = nowIso;
    if (store.groups.has(task.ownerGroupId))
      postSpoken(store, {
        groupId: task.ownerGroupId,
        eventId: task.eventId,
        agent: "timeline",
        situation: "A step this room owns has gone past its date. Nudge kindly.",
        facts: [`Reminder: "${task.title}" is overdue.`],
        nowIso,
      });
  }
  return overdueTasks.length;
}

/**
 * Posts a reminder for each directive that has waited longer than the SLA with people still to
 * acknowledge it. Each directive is reminded once. Code decides who is overdue and mentions them;
 * the model only words the nudge.
 * @param {object} store The store.
 * @param {string} nowIso The current time.
 * @param {{slaMinutes?: number, generate?: Function, eventId?: string}} [options] How long before a
 *   reminder, the model call, replaceable in tests, and one event to limit it to.
 * @returns {Promise<number>} How many reminders were posted.
 */
export async function runReminders(
  store,
  nowIso,
  { slaMinutes = DEFAULT_SLA_MINUTES, generate, eventId } = {},
) {
  const due = [...store.directives.values()]
    .filter((directive) => !eventId || store.groups.get(directive.groupId)?.eventId === eventId)
    .filter((directive) => overdue(directive, nowIso, slaMinutes).shouldRemind)
    .slice(0, MAX_PER_RUN);
  let posted = 0;
  for (const directive of due)
    if (await remindAbout(store, directive, { nowIso, slaMinutes, generate })) posted += 1;
  return posted + remindAboutVendorTasks(store, nowIso);
}
