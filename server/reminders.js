import { reminder } from "./agents/timeline.js";
import { overdue } from "./core/directives.js";
import { postSpoken } from "./routes/agentPost.js";
import { postDigest } from "./routes/timeline.js";
import { groupPeople } from "./views.js";
import { postAgentMessage } from "./store/workspace.js";

const MAX_PER_RUN = 5;

/**
 * Posts today's digest for every event that has a workspace and hasn't had one today.
 * @param {object} store The store.
 * @param {string} nowIso The current time.
 * @returns {Promise<number>} How many were posted.
 */
export async function runDailyDigests(store, nowIso) {
  const today = nowIso.slice(0, 10);
  const due = [...store.events.values()]
    .filter(
      ({ id }) =>
        store.budgets.has(id) &&
        store.groups.has(`g-${id}-announcements`) &&
        !store.digests.has(`${id}:${today}`),
    )
    .slice(0, MAX_PER_RUN);
  await Promise.all(due.map((event) => postDigest(store, event, nowIso)));
  return due.length;
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
export async function runReminders(store, nowIso, { slaMinutes = 120, generate, eventId } = {}) {
  const due = [...store.directives.values()]
    .filter((directive) => !eventId || store.groups.get(directive.groupId)?.eventId === eventId)
    .filter((directive) => overdue(directive, nowIso, slaMinutes).shouldRemind)
    .slice(0, MAX_PER_RUN);
  let posted = 0;
  for (const directive of due) {
    const group = store.groups.get(directive.groupId);
    const message = store.messages.get(directive.messageId);
    // Marked either way: nobody to remind must not hold up the ones that can be.
    if (!group || !message) {
      directive.remindedAt = nowIso;
      continue;
    }
    // Only people still in the group are reminded; someone removed can no longer see it.
    const inGroup = new Set(groupPeople(store, group).map(({ id }) => id));
    const pending = overdue(directive, nowIso, slaMinutes).pendingUserIds.filter((id) =>
      inGroup.has(id),
    );
    const names = pending.map((id) => store.users.get(id)?.name).filter(Boolean);
    // Marked first, so a slow model call can't lead to the same reminder twice.
    directive.remindedAt = nowIso;
    if (names.length === 0) continue;
    try {
      const { reminderText } = await reminder(
        { directiveText: message.text, pendingNames: names },
        generate ? { generate } : undefined,
      );
      postAgentMessage(store, {
        groupId: group.id,
        authorId: `agent-timeline@${group.eventId}`,
        text: reminderText,
        nowIso,
      });
      posted += 1;
    } catch (err) {
      console.error(`Reminder failed with ${err.name}`);
    }
  }
  return posted + remindAboutVendorTasks(store, nowIso);
}

// Anything overdue on a booking is reminded once, in the group that owns it. No model needed.
function remindAboutVendorTasks(store, nowIso) {
  const today = nowIso.slice(0, 10);
  const overdueTasks = [...store.tasks.values()]
    .filter(
      ({ source, status, dueDate, remindedAt }) =>
        source === "vendor" && status !== "done" && !remindedAt && dueDate.slice(0, 10) < today,
    )
    .slice(0, MAX_PER_RUN);
  for (const task of overdueTasks) {
    task.remindedAt = nowIso;
    if (store.groups.has(task.ownerGroupId)) {
      const late = `Reminder: "${task.title}" is overdue.`;
      postSpoken(store, {
        groupId: task.ownerGroupId,
        eventId: task.eventId,
        agent: "timeline",
        situation: "A step this room owns has gone past its date. Nudge kindly.",
        facts: [late],
        fallback: late,
        nowIso,
      });
    }
  }
  return overdueTasks.length;
}
