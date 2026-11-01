/** Directives: pinning a message as an instruction, and recording each person's "Got it". */
import { taskFromDirective as wordTask } from "../agents/directiveTask.js";
import { mentionsMoney } from "../core/amount.js";
import { getTemplate } from "../core/templates.js";
import { taskFromDirective } from "../core/timelinePlanner.js";
import { groupIdFor, newId } from "../store/ids.js";
import { directiveView } from "../views.js";

const GENERIC_TITLE = "Follow up on the manager's directive (details in the group)";

/**
 * Records that someone has acknowledged a directive, and tells everyone connected.
 * @param {object} store The store.
 * @param {object} directive The directive.
 * @param {string} userId Who acknowledged it; the caller has checked they were addressed.
 * @returns {object} The directive with its status.
 */
export function ackDirective(store, directive, userId) {
  const group = store.groups.get(directive.groupId);
  if (!directive.acks.some((ack) => ack.userId === userId))
    directive.acks.push({ userId, at: new Date().toISOString() });
  const view = directiveView(store, directive);
  store.publish({
    type: "directive.updated",
    eventId: group.eventId,
    groupId: group.id,
    directive: view,
  });
  store.nudge(group.eventId, "attention.updated");
  return view;
}

// The title and owner are worded by the model; the due date is read from the text in code.
async function taskForDirective({ store, event, group, directive, text, nowIso }) {
  const wording = await wordTask({
    directiveText: text,
    template: getTemplate(event.eventType),
    nowIso,
  });
  const owner = store.groups.get(groupIdFor(event.id, wording.ownerGroupSlug)) ?? group;
  // The timeline is visible to everyone, so an amount typed into a directive stays out of it.
  const title = mentionsMoney(wording.title) ? GENERIC_TITLE : wording.title;
  return {
    ...taskFromDirective(directive, { title, ownerGroupId: owner.id, dueDate: wording.dueDate }),
    eventId: event.id,
  };
}

/**
 * Pins a message as a directive, and has the Planner turn it into a timeline task.
 * @param {object} store The store.
 * @param {{event: object, group: object, message: object, addressed: Array<{id: string}>}} input The
 *   message to pin, where it was posted, and who must confirm it.
 * @returns {Promise<{directive: object, task: object}>} The directive with its status, and the task.
 */
export async function pinAsDirective(store, { event, group, message, addressed }) {
  const nowIso = new Date().toISOString();
  const directive = {
    id: newId("d"),
    messageId: message.id,
    groupId: group.id,
    addressedUserIds: addressed.map(({ id }) => id),
    acks: [],
    createdAt: nowIso,
    remindedAt: null,
    taskId: null,
  };
  const context = { store, event, group, directive, text: message.text, nowIso };
  const task = await taskForDirective(context);
  directive.taskId = task.id;
  store.tasks.set(task.id, task);
  store.directives.set(directive.id, directive);
  const view = directiveView(store, directive);
  store.publish({
    type: "directive.updated",
    eventId: event.id,
    groupId: group.id,
    directive: view,
  });
  store.nudge(event.id, "timeline.updated", "attention.updated");
  store.reactInDemo?.("directive", { event, directive });
  return { directive: view, task };
}
