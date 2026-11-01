import { noticeFacts, noticeTargets, word } from "../agents/notices.js";
import { postAgentMessage } from "../store/workspace.js";
import { vendorsOf } from "./hiringSupport.js";
import { categoryGroup } from "./vendorSupport.js";
import { directiveView, groupPeople } from "../views.js";
import { newId } from "../store/ids.js";

// A booked vendor has to confirm they saw a change, the same way the team confirms a directive.
function askVendorsToAcknowledge(store, event, message, vendors, nowIso) {
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
  store.publish({ type: "attention.updated", eventId: event.id });
}

/**
 * Tells each group an accepted change affects, worded from only the facts that group may see.
 * @param {{store: object, event: object, template: object, before: object, after: object,
 *   deltas: object[], nowIso: string}} input The change and where it happened.
 * @returns {Promise<object[]>} The notices posted.
 */
export async function postNotices({ store, event, template, before, after, deltas, nowIso }) {
  const guests = { before: before.guestCount, after: after.guestCount };
  // A category whose group was removed is told to Core team instead, so nobody is left out.
  const merged = new Map();
  for (const { slug, categoryIds } of noticeTargets({
    deltas,
    categoryGroupMap: template.categoryGroupMap,
  })) {
    const to = store.groups.has(`g-${event.id}-${slug}`) ? slug : "core-team";
    merged.set(to, [...new Set([...(merged.get(to) ?? []), ...categoryIds])]);
  }
  // A booked vendor hears about a new guest count even if their own price didn't move.
  if (guests.before !== guests.after)
    for (const { categoryIds } of vendorsOf(store, event.id)) {
      const { slug } = categoryGroup(store, event, template, categoryIds[0]);
      merged.set(slug, [...new Set([...(merged.get(slug) ?? []), categoryIds[0]])]);
    }
  const targets = [...merged].map(([slug, categoryIds]) => ({ slug, categoryIds }));
  const posted = await Promise.all(
    targets.map(async ({ slug, categoryIds }) => {
      const group = store.groups.get(`g-${event.id}-${slug}`);
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
          authorId: `agent-budget@${event.id}`,
          authorKind: "system",
          text: wording,
          rationale,
          nowIso,
        });
        // Someone booked by this very change has nothing to catch up on.
        const existing = vendors.filter(({ joinedAt }) => joinedAt !== nowIso);
        if (existing.length) askVendorsToAcknowledge(store, event, message, existing, nowIso);
        return message;
      } catch (err) {
        console.error(`Notice failed with ${err.name}`);
        return null;
      }
    }),
  );
  return posted.filter(Boolean);
}
