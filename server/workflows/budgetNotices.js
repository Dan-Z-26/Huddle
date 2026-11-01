/** Tells the groups an accepted budget change affects. Code picks the rooms; the model words it. */
import { noticeFacts, noticeTargets, word } from "../agents/notices.js";
import { agentIdFor, CORE_TEAM, groupIdFor, newId } from "../store/ids.js";
import { postAgentMessage } from "../store/workspace.js";
import { directiveView, groupPeople } from "../views.js";
import { vendorsOf } from "./booking.js";
import { categoryGroup } from "./vendors.js";

// A booked vendor has to confirm they saw a change, the same way the team confirms a directive.
function askVendorsToAcknowledge({ store, event, message, vendors, nowIso }) {
  const directive = {
    id: newId("d"),
    messageId: message.id,
    groupId: message.groupId,
    addressedUserIds: vendors.map(({ id }) => id),
    acks: [],
    createdAt: nowIso,
    remindedAt: null,
    taskId: null,
  };
  store.directives.set(directive.id, directive);
  store.publish({
    type: "directive.updated",
    eventId: event.id,
    groupId: message.groupId,
    directive: { ...directiveView(store, directive), text: message.text },
  });
  store.nudge(event.id, "attention.updated");
}

// Which room hears about which categories.
function noticeRooms({ store, event, template, deltas, guestsChanged }) {
  const rooms = new Map();
  const add = (slug, categoryIds) =>
    rooms.set(slug, [...new Set([...(rooms.get(slug) ?? []), ...categoryIds])]);
  const { categoryGroupMap } = template;
  for (const { slug, categoryIds } of noticeTargets({ deltas, categoryGroupMap })) {
    // A category whose group was removed is told to Core team instead, so nobody is left out.
    add(store.groups.has(groupIdFor(event.id, slug)) ? slug : CORE_TEAM, categoryIds);
  }
  // A booked vendor hears about a new guest count even if their own price didn't move.
  if (guestsChanged)
    for (const { categoryIds } of vendorsOf(store, event.id))
      add(categoryGroup(store, event, template, categoryIds[0]).slug, [categoryIds[0]]);
  return [...rooms];
}

async function postRoomNotice(room, { store, event, template, after, deltas, guests, nowIso }) {
  const [slug, categoryIds] = room;
  const group = store.groups.get(groupIdFor(event.id, slug));
  if (!group) return null;
  const vendors = groupPeople(store, group).filter(({ kind }) => kind === "vendor");
  const facts = noticeFacts({
    guests,
    deltas,
    categoryIds,
    groupSlug: slug,
    template,
    currency: after.currency,
    hideCosts: vendors.length > 0,
    memberRoleIds: group.memberRoleIds,
  });
  if (facts.length === 0) return null;
  // The change is already applied, so a failed notice must not report the change as failed.
  try {
    const { wording, rationale } = await word({ facts, groupName: group.name });
    const message = postAgentMessage(store, {
      groupId: group.id,
      authorId: agentIdFor("budget", event.id),
      authorKind: "system",
      text: wording,
      rationale,
      nowIso,
    });
    // Someone booked by this very change has nothing to catch up on.
    const existing = vendors.filter(({ joinedAt }) => joinedAt !== nowIso);
    if (existing.length)
      askVendorsToAcknowledge({ store, event, message, vendors: existing, nowIso });
    return message;
  } catch (err) {
    console.error(`Notice failed with ${err.name}`);
    return null;
  }
}

/**
 * Tells each group an accepted change affects, worded from only the facts that group may see.
 * @param {{store: object, event: object, template: object, before: object, after: object,
 *   deltas: object[], nowIso: string}} input The change and where it happened.
 * @returns {Promise<object[]>} The notices posted.
 */
export async function postNotices({ store, event, template, before, after, deltas, nowIso }) {
  const guests = { before: before.guestCount, after: after.guestCount };
  const guestsChanged = guests.before !== guests.after;
  const rooms = noticeRooms({ store, event, template, deltas, guestsChanged });
  const context = { store, event, template, after, deltas, guests, nowIso };
  const posted = await Promise.all(rooms.map((room) => postRoomNotice(room, context)));
  return posted.filter(Boolean);
}
