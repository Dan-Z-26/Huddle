/** Directives in code: who has acknowledged, what is overdue, and what needs a person's attention. */
import { MINUTE_MS } from "./time.js";

const ackedIds = (directive) => new Set((directive.acks ?? []).map((ack) => ack.userId));
const addressedIds = (directive) => [...new Set(directive.addressedUserIds ?? [])];

/**
 * Reports who has acknowledged a directive among its addressed members.
 * @param {object} directive Directive.
 * @param {Array<{id: string}>} members Current members of the group, as user objects.
 * @returns {{acked: string[], pending: string[], label: string}} Status, such as
 *   "3 of 4 acknowledged".
 */
export function ackStatus(directive, members) {
  const memberIds = new Set(members.map((member) => member.id));
  const acks = ackedIds(directive);
  const addressed = addressedIds(directive).filter((id) => memberIds.has(id));
  const acked = addressed.filter((id) => acks.has(id));
  const pending = addressed.filter((id) => !acks.has(id));
  return { acked, pending, label: `${acked.length} of ${addressed.length} acknowledged` };
}

/**
 * Checks whether a directive has waited past its SLA and whether a first reminder is due.
 * @param {object} directive Directive.
 * @param {string} nowIso Current time.
 * @param {number} slaMinutes Minutes allowed; reaching this exactly counts as overdue.
 * @returns {{isOverdue: boolean, pendingUserIds: string[], shouldRemind: boolean}} Overdue state.
 */
export function overdue(directive, nowIso, slaMinutes) {
  const acks = ackedIds(directive);
  const pendingUserIds = addressedIds(directive).filter((id) => !acks.has(id));
  const waitedMs = Date.parse(nowIso) - Date.parse(directive.createdAt);
  const isOverdue = pendingUserIds.length > 0 && waitedMs >= slaMinutes * MINUTE_MS;
  return { isOverdue, pendingUserIds, shouldRemind: isOverdue && directive.remindedAt == null };
}

/**
 * Builds a user's "Needs my attention" list.
 * @param {string} userId User.
 * @param {object[]} directives Directives.
 * @param {object[]} tasks Tasks.
 * @returns {{directives: object[], tasks: object[]}} Unacknowledged directives addressed to the
 *   user, and the user's todo tasks.
 */
export function attentionFor(userId, directives, tasks) {
  return {
    directives: directives.filter(
      (directive) =>
        directive.addressedUserIds?.includes(userId) && !ackedIds(directive).has(userId),
    ),
    tasks: tasks.filter((task) => task.ownerUserId === userId && task.status === "todo"),
  };
}
