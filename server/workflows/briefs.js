/** A category's hiring brief: drafting it, sending it for approval, and the manager's decision. */
import { defaultAnswers, draftBrief } from "../agents/hiring.js";
import { mentionsMoney } from "../core/amount.js";
import { siteVisitTask } from "../core/hiring.js";
import { categoryName, categoryOf, getTemplate } from "../core/templates.js";
import { badRequest } from "../http.js";
import { CORE_TEAM, groupIdFor } from "../store/ids.js";
import { postSpoken } from "./agentPost.js";
import { categoryGroup } from "./vendors.js";

const briefId = (eventId, categoryId) => `b-${eventId}-${categoryId}`;

/**
 * A category's brief, if it has one.
 * @param {object} store The store.
 * @param {string} eventId The event.
 * @param {string} categoryId The category.
 * @returns {object | undefined} The brief.
 */
export const briefOf = (store, eventId, categoryId) =>
  store.briefs.get(briefId(eventId, categoryId));

/**
 * Creates or redrafts a category's brief, filling in whatever the lead hasn't answered from the
 * event. An approved brief stays as it was approved.
 * @param {{store: object, event: object, template: object, categoryId: string, user: object,
 *   answers?: object}} input Where, who, and any answers.
 * @returns {Promise<object>} The stored brief.
 * @throws {Error} 400 when the brief has already gone for approval or been approved.
 */
export async function saveDraftBrief({ store, event, template, categoryId, user, answers = {} }) {
  const existing = briefOf(store, event.id, categoryId);
  if (existing?.status === "approved") throw badRequest("This brief is already approved.");
  if (existing?.status === "pending") throw badRequest("This brief is waiting for approval.");
  const category = categoryOf(template, categoryId);
  const merged = { ...defaultAnswers(event, category), ...existing?.answers, ...answers };
  const { text, deliverables, offline } = await draftBrief({
    profile: event,
    category,
    answers: merged,
  });
  const brief = {
    id: briefId(event.id, categoryId),
    eventId: event.id,
    categoryId,
    status: "draft",
    answers: merged,
    text,
    deliverables,
    note: existing?.note ?? null,
    createdById: user.id,
    createdAt: new Date().toISOString(),
    offline,
  };
  store.briefs.set(brief.id, brief);
  return brief;
}

/**
 * Sends a brief to the manager for approval, and tells Core team.
 * @param {{store: object, event: object, brief: object, user: object}} input Who sends which brief.
 */
export function sendBrief({ store, event, brief, user }) {
  brief.status = "pending";
  const core = store.groups.get(groupIdFor(event.id, CORE_TEAM));
  const name = categoryName(getTemplate(event.eventType), brief.categoryId);
  if (core)
    postSpoken(store, {
      groupId: core.id,
      eventId: event.id,
      agent: "vendor",
      situation: "A lead has sent a vendor brief for approval. It follows your message in full.",
      facts: [
        `${user.name} sent the ${name} brief for approval.`,
        "The event manager can approve it under Vendors and quotes.",
      ],
      suffix: `\n\n${brief.text}`,
      nowIso: new Date().toISOString(),
    });
  store.nudge(event.id, "attention.updated");
}

// Opens the visit task once a brief is approved: the first thing that needs doing in person.
function startHiring({ store, event, template, categoryId, group, nowIso }) {
  if (!group) return;
  const task = siteVisitTask(
    { eventId: event.id, categoryId, groupId: group.id, eventDateIso: event.date, nowIso },
    categoryName(template, categoryId),
  );
  store.tasks.set(task.id, task);
  store.nudge(event.id, "timeline.updated");
}

function decisionText(name, approve, note) {
  if (approve) return `The ${name} brief is approved. You can send it out and add quotes.`;
  const reason = note && !mentionsMoney(note) ? `: ${note}` : ".";
  return `The ${name} brief needs changes${reason}`;
}

/**
 * Records the manager's decision on a brief and tells the category's room.
 * @param {{store: object, event: object, brief: object, user: object, approve: boolean,
 *   note?: string}} input Who decided what, and any note for the lead.
 */
export function decideBrief({ store, event, brief, user, approve, note }) {
  const template = getTemplate(event.eventType);
  const nowIso = new Date().toISOString();
  const { categoryId } = brief;
  const group = categoryGroup(store, event, template, categoryId);
  brief.status = approve ? "approved" : "changes";
  brief.note = approve ? null : (note ?? null);
  if (approve) startHiring({ store, event, template, categoryId, group, nowIso });
  if (group)
    postSpoken(store, {
      groupId: group.id,
      eventId: event.id,
      agent: "vendor",
      situation: `${user.name} has just decided on a vendor brief.`,
      facts: [decisionText(categoryName(template, categoryId), approve, note)],
      nowIso,
    });
  store.nudge(event.id, "attention.updated");
  store.reactInDemo?.("brief", { event, categoryId, approved: approve });
}
