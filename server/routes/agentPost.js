import { speak } from "../agents/speech.js";
import { postAgentMessage } from "../store/workspace.js";

const IN_WORDS = { planner: "Planner", budget: "Budget", vendor: "Vendor", timeline: "Timeline" };

/**
 * Has an AI member say something in a room, in words the model writes from facts code supplies.
 * The caller doesn't have to wait for the model: the message arrives over the live stream.
 * @param {object} store The store.
 * @param {{groupId: string, eventId: string, agent: string, authorKind?: string, situation: string,
 *   facts: string[], fallback: string, suffix?: string, nowIso: string}} message Who speaks, where,
 *   what happened, and anything to add word for word after the model's text.
 * @returns {Promise<object | null>} The stored message; null if the room has since been removed.
 */
export function postSpoken(
  store,
  { groupId, eventId, agent, authorKind, situation, facts, fallback, suffix = "", nowIso },
) {
  const work = speak({ agent: IN_WORDS[agent], situation, facts, fallback })
    .catch(() => ({ wording: fallback, rationale: "" }))
    .then(({ wording, rationale }) =>
      store.groups.has(groupId)
        ? postAgentMessage(store, {
            groupId,
            authorId: `agent-${agent}@${eventId}`,
            authorKind,
            text: `${wording}${suffix}`,
            rationale: rationale || null,
            nowIso,
          })
        : null,
    )
    .finally(() => store.background.delete(work));
  store.background.add(work);
  return work;
}
