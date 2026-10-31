import { handleMention } from "../agents/planner.js";
import { mentionsMoney } from "../core/amount.js";
import { canSeeBudget, canView } from "../core/permissions.js";
import { getTemplate } from "../core/templates.js";
import { categoriesMentioned } from "../agents/discoveryDemo.js";
import { saveDraftBrief } from "./hiringSupport.js";
import { eventQuotes, mayWorkOn } from "./vendorSupport.js";
import { eventExpenses } from "../store/workspace.js";
import { addMessage, postAgentMessage } from "../store/workspace.js";
import { messageView, profileFor, publicUser } from "./views.js";

// A group has core members in it, so a reply that carries budget figures, the ranking or cut
// options must never be posted there, even when the manager asked. The manager sees those through
// Ask Huddle in the sidebar, which only the manager can open.
const PRIVATE_INTENTS = new Set(["budget_change", "ideas", "advice"]);
const PRIVATE_NOTE =
  "I've worked that out. It involves budget figures, so I won't post them in a group. Open Ask Huddle in the sidebar to see the details.";
const looksPrivate = (text) =>
  mentionsMoney(text) || /\bpriority\b/i.test(text) || /\bbudget\b.*\d/i.test(text);
const SORRY = "Sorry, I couldn't work on that just now. Please try again in a moment.";

// Which category someone means: what they said, then the room they said it in, then what they own.
function briefCategory({ template, group, role, asked, text }) {
  const known = (id) => template.categories.some((category) => category.id === id);
  const named = asked.result?.categoryId;
  const options = [
    named,
    categoriesMentioned(text.replace(/@huddle\b/gi, ""), template).find((id) =>
      mayWorkOn(role, id),
    ),
    group.categoryIds?.find((id) => mayWorkOn(role, id)),
    role.kind === "core" && role.categoryIds.length === 1 ? role.categoryIds[0] : null,
  ];
  return options.find((id) => id && known(id)) ?? null;
}

async function briefReply({ store, event, template, group, user, role, asked, text }) {
  const categoryId = briefCategory({ template, group, role, asked, text });
  if (!categoryId)
    return "Which category is this for? Ask me in that category's group, or name it.";
  if (!mayWorkOn(role, categoryId))
    return "Only that category's lead or the event manager can start a brief.";
  const brief = await saveDraftBrief({ store, event, template, categoryId, user });
  const name = template.categories.find(({ id }) => id === categoryId).name;
  return `I've drafted a brief for ${name} from your event details. It has no budget or amounts in it. Open Vendors and quotes to check my answers on scope, deliverables, dates, must-haves and how you'll choose, then send it to Core team for approval.\n\n${brief.text}`;
}

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
      expenses: isManager ? eventExpenses(store, event.id) : [],
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
    if (asked.intent === "vendor_brief") {
      postAgentMessage(store, {
        groupId: group.id,
        authorId: `agent-vendor@${event.id}`,
        text: await briefReply({
          store,
          event,
          template,
          group,
          user,
          role,
          asked,
          text: message.text,
        }),
        nowIso,
      });
      return;
    }
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
