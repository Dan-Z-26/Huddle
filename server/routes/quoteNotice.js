import { mentionsMoney } from "../core/amount.js";
import { postSpoken } from "./agentPost.js";
import { categoryGroup, eventQuotes } from "./vendorSupport.js";
import { groupPeople } from "../views.js";

/**
 * Tells the category's room, and so the event manager, that a quote has been added and is ready to
 * compare. The Vendor agent words it from facts code supplies; it never carries an amount, so
 * anyone in the room may read it.
 * @param {{store: object, event: object, template: object, quote: object, user: object}} input The
 *   confirmed quote, who added it, and where it belongs.
 */
export function announceQuote({ store, event, template, quote, user }) {
  store.publish({ type: "quotes.updated", eventId: event.id });
  store.publish({ type: "attention.updated", eventId: event.id });
  const own = categoryGroup(store, event, template, quote.categoryId);
  if (!own) return;
  // A booked vendor reads their category's room, and must not learn a rival's name.
  const room = groupPeople(store, own).some(({ kind }) => kind === "vendor")
    ? store.groups.get(`g-${event.id}-core-team`)
    : own;
  if (!room) return;
  const category = template.categories.find(({ id }) => id === quote.categoryId);
  const vendor = mentionsMoney(quote.vendorName) ? "a vendor" : quote.vendorName;
  const waiting = eventQuotes(store, event.id).filter(
    (item) => item.categoryId === quote.categoryId && item.status === "confirmed",
  ).length;
  const facts = [
    `${user.name} added a quote from ${vendor} for ${category.name}${quote.sourceFileId ? ", read from an uploaded file and checked by them" : ""}.`,
    waiting > 1
      ? `There are now ${waiting} quotes to compare.`
      : "It is the first quote for this category.",
    "The event manager can compare them under Vendors and quotes.",
  ];
  postSpoken(store, {
    groupId: room.id,
    eventId: event.id,
    agent: "vendor",
    situation: "A team member has just added a vendor quote and the event manager needs to know.",
    facts,
    fallback: facts.join(" "),
    nowIso: new Date().toISOString(),
  });
}
