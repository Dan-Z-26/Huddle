import { handleMention } from "../agents/planner.js";
import { canSeeBudget, canView } from "../core/permissions.js";
import { getTemplate } from "../core/templates.js";
import { eventQuotes } from "./vendorSupport.js";
import { addMessage, postAgentMessage } from "../store/workspace.js";
import { messageView, profileFor, publicUser } from "./views.js";

const SORRY = "Sorry, I couldn't work on that just now. Please try again in a moment.";
const APPLY_HINT = "To apply it, ask again in the Ask Huddle box on the budget panel.";

/**
 * Answers an @huddle message in the group it was posted in. The asker's own permissions decide
 * what the Planner can see: only the manager's request carries the budget or the ranking.
 * @param {{store: object, event: object, group: object, user: object, message: object,
 *   files?: Array<{mime: string, buffer: Buffer, name: string}>}} input Where and who asked.
 * @returns {Promise<void>} Resolves once the reply is posted; it never throws.
 */
export async function replyAsPlanner({ store, event, group, user, message, files = [] }) {
  const nowIso = new Date().toISOString();
  const authorId = `agent-planner@${event.id}`;
  const role = store.roleOf(user);
  const isManager = canSeeBudget(role, "total");
  try {
    const template = getTemplate(event.eventType);
    const asked = await handleMention({
      profile: isManager ? event : { ...profileFor(event, role), priorities: [] },
      state: isManager ? store.budgets.get(event.id) : undefined,
      template,
      actor: role,
      text: message.text,
      files: isManager ? files : [],
      tasks: store.tasksForEvent(event.id),
      quotes: isManager ? eventQuotes(store, event.id) : [],
      directives: store
        .directivesForEvent(event.id)
        .filter(({ groupId }) =>
          canView(role, { type: "group", group: store.groups.get(groupId) }),
        ),
      members: [...store.users.values()]
        .filter(({ eventId, kind }) => eventId === event.id && kind !== "agent")
        .map(publicUser),
      nowIso,
    });
    const applicable = asked.intent === "budget_change" && asked.result?.changeEvents?.length > 0;
    postAgentMessage(store, {
      groupId: group.id,
      authorId,
      text: applicable && isManager ? `${asked.reply}\n${APPLY_HINT}` : asked.reply,
      rationale: asked.rationale || null,
      nowIso,
    });
    if (asked.suggestDirective) {
      message.suggestDirective = true;
      store.publish({
        type: "message.updated",
        eventId: event.id,
        groupId: group.id,
        message: messageView(store, message),
      });
    }
  } catch (err) {
    console.error(`Planner reply failed with ${err.name}`);
    addMessage(store, {
      id: `m-${Math.random().toString(36).slice(2, 10)}`,
      groupId: group.id,
      authorId,
      authorKind: "agent",
      text: SORRY,
      fileIds: [],
      createdAt: nowIso,
      rationale: null,
    });
  }
}
