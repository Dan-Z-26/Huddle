import { handleMention } from "../agents/planner.js";
import { mentionsMoney } from "../core/amount.js";
import { canSeeBudget, canView } from "../core/permissions.js";
import { getTemplate } from "../core/templates.js";
import { eventQuotes } from "./vendorSupport.js";
import { addMessage, postAgentMessage } from "../store/workspace.js";
import { messageView, profileFor, publicUser } from "./views.js";

// A group has core members in it, so a reply that carries budget figures, the ranking or cut
// options must never be posted there, even when the manager asked. The manager sees those through
// Ask Huddle on the budget panel, which only the manager can open.
const PRIVATE_INTENTS = new Set(["budget_change", "ideas"]);
const PRIVATE_NOTE =
  "I've worked that out. It involves budget figures, so I won't post them in a group. Open Ask Huddle on the budget panel to see the details.";
const looksPrivate = (text) =>
  mentionsMoney(text) || /\bpriority\b/i.test(text) || /\bbudget\b.*\d/i.test(text);
const SORRY = "Sorry, I couldn't work on that just now. Please try again in a moment.";

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
    const keep = !PRIVATE_INTENTS.has(asked.intent) && !looksPrivate(asked.reply);
    postAgentMessage(store, {
      groupId: group.id,
      authorId,
      text: keep ? asked.reply : isManager ? PRIVATE_NOTE : asked.reply,
      rationale: keep && asked.rationale && !looksPrivate(asked.rationale) ? asked.rationale : null,
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
