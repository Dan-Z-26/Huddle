import { reminder } from "./agents/timeline.js";
import { overdue } from "./core/directives.js";
import { groupPeople } from "./routes/views.js";
import { postAgentMessage } from "./store/workspace.js";

const MAX_PER_RUN = 5;

/**
 * Posts a reminder for each directive that has waited longer than the SLA with people still to
 * acknowledge it. Each directive is reminded once. Code decides who is overdue and mentions them;
 * the model only words the nudge.
 * @param {object} store The store.
 * @param {string} nowIso The current time.
 * @param {{slaMinutes?: number, generate?: Function}} [options] How long before a reminder, and
 *   the model call, replaceable in tests.
 * @returns {Promise<number>} How many reminders were posted.
 */
export async function runReminders(store, nowIso, { slaMinutes = 120, generate } = {}) {
  const due = [...store.directives.values()]
    .filter((directive) => overdue(directive, nowIso, slaMinutes).shouldRemind)
    .slice(0, MAX_PER_RUN);
  let posted = 0;
  for (const directive of due) {
    const group = store.groups.get(directive.groupId);
    const message = store.messages.get(directive.messageId);
    if (!group || !message) continue;
    // Only people still in the group are reminded; someone removed can no longer see it.
    const inGroup = new Set(groupPeople(store, group).map(({ id }) => id));
    const pending = overdue(directive, nowIso, slaMinutes).pendingUserIds.filter((id) =>
      inGroup.has(id),
    );
    const names = pending.map((id) => store.users.get(id)?.name).filter(Boolean);
    if (names.length === 0) continue;
    // Marked first, so a slow model call can't lead to the same reminder twice.
    directive.remindedAt = nowIso;
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
  return posted;
}
