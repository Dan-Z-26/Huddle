/** What accepting a quote starts: the vendor joins one room, with deliverables and follow-ups. */
import { mentionsMoney } from "../core/amount.js";
import { bookedTasks } from "../core/hiring.js";
import { newId } from "../store/ids.js";
import { postSpoken } from "./agentPost.js";
import { briefOf } from "./briefs.js";
import { vendorRoomFor } from "./vendors.js";

const safeName = (name) => (mentionsMoney(name) ? "the vendor" : name);

/**
 * A booked vendor's deliverables.
 * @param {object} store The store.
 * @param {string} vendorUserId The vendor.
 * @returns {object[]} The deliverables.
 */
export const deliverablesOf = (store, vendorUserId) =>
  [...store.deliverables.values()].filter((item) => item.vendorUserId === vendorUserId);

/**
 * The vendor people on an event, optionally for one category.
 * @param {object} store The store.
 * @param {string} eventId The event.
 * @param {string} [categoryId] The category.
 * @returns {object[]} The vendors.
 */
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

function addVendorPerson({ store, event, group, quote, nowIso }) {
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
  return vendor;
}

function addDeliverables(store, event, vendor, brief) {
  for (const text of brief?.deliverables ?? []) {
    const id = newId("dv");
    store.deliverables.set(id, {
      id,
      eventId: event.id,
      vendorUserId: vendor.id,
      text,
      done: false,
    });
  }
}

function addFollowUps({ store, event, group, quote, vendor, nowIso }) {
  const context = {
    eventId: event.id,
    categoryId: quote.categoryId,
    groupId: group.id,
    eventDateIso: event.date,
    nowIso,
  };
  for (const task of bookedTasks(context, safeName(vendor.name))) store.tasks.set(task.id, task);
}

/**
 * Books a vendor: they become a person in that category's group only, with their deliverables and
 * the team's follow-up tasks. A vendor booked earlier for the category is replaced. Runs only after
 * the budget change has been applied.
 * @param {{store: object, event: object, template: object, quote: object, nowIso: string}} input
 *   The event and the accepted quote.
 * @returns {object} The vendor.
 */
export function bookVendor({ store, event, template, quote, nowIso }) {
  const { categoryId } = quote;
  const group = vendorRoomFor(store, event, template, categoryId);
  for (const earlier of vendorsOf(store, event.id, categoryId)) removeVendor(store, earlier);
  const vendor = addVendorPerson({ store, event, group, quote, nowIso });
  addDeliverables(store, event, vendor, briefOf(store, event.id, categoryId));
  addFollowUps({ store, event, group, quote, vendor, nowIso });
  postSpoken(store, {
    groupId: group.id,
    eventId: event.id,
    agent: "vendor",
    situation: "A vendor has just been booked and joined this room, and can read what you write.",
    facts: [
      `${safeName(vendor.name)} is booked and has joined this group.`,
      "They can see messages from now on, with any amounts hidden.",
    ],
    nowIso,
  });
  store.nudge(event.id, "groups.updated");
  store.reactInDemo?.("booked", { event, categoryId, vendorName: safeName(vendor.name) });
  return vendor;
}
