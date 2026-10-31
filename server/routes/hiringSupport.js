import { randomUUID } from "node:crypto";
import { draftBrief, defaultAnswers } from "../agents/hiring.js";
import { mentionsMoney } from "../core/amount.js";
import { bookedTasks, siteVisitTask } from "../core/hiring.js";
import { HttpError } from "../http.js";
import { postAgentMessage } from "../store/workspace.js";
import { categoryGroup } from "./vendorSupport.js";

export const briefId = (eventId, categoryId) => `b-${eventId}-${categoryId}`;
export const briefOf = (store, eventId, categoryId) =>
  store.briefs.get(briefId(eventId, categoryId));
const safeName = (name) => (mentionsMoney(name) ? "the vendor" : name);

/**
 * Creates or redrafts a category's brief, filling in whatever the lead hasn't answered from the
 * event. An approved brief stays as it was approved.
 * @param {{store: object, event: object, template: object, categoryId: string, user: object,
 *   answers?: object}} input Where, who, and any answers.
 * @returns {Promise<object>} The stored brief.
 */
export async function saveDraftBrief({ store, event, template, categoryId, user, answers = {} }) {
  const existing = briefOf(store, event.id, categoryId);
  if (existing?.status === "approved")
    throw HttpError(400, "BAD_REQUEST", "This brief is already approved.");
  if (existing?.status === "pending")
    throw HttpError(400, "BAD_REQUEST", "This brief is waiting for approval.");
  const category = template.categories.find(({ id }) => id === categoryId);
  const merged = { ...defaultAnswers(event, category), ...existing?.answers, ...answers };
  const {
    text,
    deliverables: suggested,
    offline,
  } = await draftBrief({
    profile: event,
    category,
    answers: merged,
  });
  // What the lead asked for wins over what the AI suggested.
  const asked = merged.deliverables
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  const deliverables = asked.length ? asked : suggested;
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

/** Opens the visit task once a brief is approved: the first thing that needs doing in person. */
export function startHiring({ store, event, template, categoryId, nowIso }) {
  const group = categoryGroup(store, event, template, categoryId);
  const category = template.categories.find(({ id }) => id === categoryId);
  if (!group) return;
  const task = siteVisitTask(
    { eventId: event.id, categoryId, groupId: group.id, eventDateIso: event.date, nowIso },
    category.name,
  );
  store.tasks.set(task.id, task);
  store.publish({ type: "timeline.updated", eventId: event.id });
}

/** A booked vendor's deliverables. */
export const deliverablesOf = (store, vendorUserId) =>
  [...store.deliverables.values()].filter((item) => item.vendorUserId === vendorUserId);

/** The vendor people on an event, optionally for one category. */
export const vendorsOf = (store, eventId, categoryId) =>
  [...store.users.values()].filter(
    (user) =>
      user.eventId === eventId &&
      user.kind === "vendor" &&
      (!categoryId || user.categoryIds.includes(categoryId)),
  );

function removeVendor(store, vendor) {
  store.users.delete(vendor.id);
  for (const group of store.groups.values())
    group.memberRoleIds = group.memberRoleIds.filter((id) => id !== vendor.roleId);
  for (const [id, item] of store.deliverables)
    if (item.vendorUserId === vendor.id) store.deliverables.delete(id);
  for (const [hash, invite] of store.invites)
    if (invite.vendorUserId === vendor.id) store.invites.delete(hash);
}

/**
 * What accepting a quote starts: the vendor becomes a person in that category's group only, with
 * their deliverables and the team's follow-up tasks. A vendor booked earlier for the category is
 * replaced. Runs only after the budget change has been applied.
 * @param {{store: object, event: object, template: object, quote: object, nowIso: string}} input
 *   The event and the accepted quote.
 * @returns {object | null} The vendor, or null when the category's group has been removed.
 */
export function bookVendor({ store, event, template, quote, nowIso }) {
  const group = categoryGroup(store, event, template, quote.categoryId);
  if (!group) return null;
  for (const earlier of vendorsOf(store, event.id, quote.categoryId)) removeVendor(store, earlier);
  const vendor = {
    id: `vendor-${quote.id}@${event.id}`,
    name: quote.vendorName,
    roleId: `vendor-${quote.id}`,
    kind: "vendor",
    eventId: event.id,
    categoryIds: [quote.categoryId],
    quoteId: quote.id,
    joinedAt: nowIso,
  };
  store.users.set(vendor.id, vendor);
  group.memberRoleIds.push(vendor.roleId);
  const brief = briefOf(store, event.id, quote.categoryId);
  for (const text of brief?.deliverables ?? []) {
    const id = `dv-${randomUUID().slice(0, 8)}`;
    store.deliverables.set(id, {
      id,
      eventId: event.id,
      vendorUserId: vendor.id,
      text,
      done: false,
    });
  }
  for (const task of bookedTasks(
    {
      eventId: event.id,
      categoryId: quote.categoryId,
      groupId: group.id,
      eventDateIso: event.date,
      nowIso,
    },
    safeName(vendor.name),
  ))
    store.tasks.set(task.id, task);
  postAgentMessage(store, {
    groupId: group.id,
    authorId: `agent-vendor@${event.id}`,
    text: `${safeName(vendor.name)} is booked and has joined this group. They can see messages from now on, with any amounts hidden.`,
    nowIso,
  });
  store.publish({ type: "groups.updated", eventId: event.id });
  return vendor;
}
