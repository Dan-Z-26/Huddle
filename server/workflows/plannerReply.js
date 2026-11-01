/** Answering an @huddle message in its group: what the Planner may see, and what it may post. */
import { handleMention } from "../agents/planner.js";
import { speak } from "../agents/speech.js";
import { hideAmounts, mentionsMoney } from "../core/amount.js";
import { canSeeBudget, canView } from "../core/permissions.js";
import { getTemplate } from "../core/templates.js";
import { agentIdFor } from "../store/ids.js";
import { eventExpenses, postAgentMessage } from "../store/workspace.js";
import { hasVendor, messageView, profileFor, publicUser } from "../views.js";
import { briefReply, expenseReply } from "./plannerActions.js";
import { eventQuotes } from "./vendors.js";

// A group has core members in it, so a reply that carries budget figures, the ranking or cut
// options must never be posted there, even when the manager asked. The manager sees those through
// Ask Huddle in the sidebar, which only the manager can open.
const PRIVATE_INTENTS = new Set(["budget_change", "ideas", "advice"]);
const PRIVATE_NOTE =
  "I've worked that out. It involves budget figures, so I won't post them in a group. Open Ask Huddle in the sidebar to see the details.";
const VENDOR_ROOM_NOTE =
  "An outside vendor is in this room, so I won't answer here. Please ask me in Core team.";
const looksPrivate = (text) =>
  mentionsMoney(text) || /\bpriority\b/i.test(text) || /\bbudget\b.*\d/i.test(text);
const SORRY = "Sorry, I couldn't work on that just now. Please try again in a moment.";

// The asker's own permissions decide what the Planner can see: only the manager's request carries
// the budget or the ranking.
function mentionInput({
  store,
  event,
  group,
  role,
  isManager,
  template,
  askedText,
  files,
  nowIso,
}) {
  return {
    profile: isManager ? event : { ...profileFor(event, role), priorities: [] },
    state: isManager ? store.budgets.get(event.id) : undefined,
    template,
    actor: role,
    text: askedText,
    roomCategoryIds: group.kind === "category" ? group.categoryIds : [],
    files: isManager ? files : [],
    tasks: store.tasksForEvent(event.id),
    quotes: isManager ? eventQuotes(store, event.id) : [],
    expenses: isManager ? eventExpenses(store, event.id) : [],
    directives: store
      .directivesForEvent(event.id)
      .filter(({ groupId }) => canView(role, { type: "group", group: store.groups.get(groupId) })),
    members: [...store.users.values()]
      .filter(({ eventId, kind }) => eventId === event.id && kind !== "agent")
      .map(publicUser),
    nowIso,
  };
}

async function postBrief(context, asked) {
  const { store, event, group, askedText, nowIso } = context;
  postAgentMessage(store, {
    groupId: group.id,
    authorId: agentIdFor("vendor", event.id),
    text: await briefReply({ ...context, asked, text: askedText }),
    nowIso,
  });
}

async function postExpense(context, asked) {
  const { store, event, group, askedText, nowIso } = context;
  const text = askedText.replace(/@huddle\b/gi, "");
  const { wording, rationale } = await expenseReply({ ...context, asked, text });
  postAgentMessage(store, {
    groupId: group.id,
    authorId: agentIdFor("budget", event.id),
    text: wording,
    rationale: rationale || null,
    nowIso,
  });
}

// The asker is pointed to where they can read the answer, in the Planner's own words.
function redirectNote(user, withVendor) {
  const note = withVendor ? VENDOR_ROOM_NOTE : PRIVATE_NOTE;
  const about = withVendor
    ? "isn't for the outside vendor in this room"
    : "involves budget figures";
  return speak({
    agent: "Planner",
    situation: `${user.name} asked you something in a shared room, and the answer ${about}.`,
    facts: [note],
    fallback: note,
  });
}

// Figures stay out of a shared room, and a vendor's room hears nothing of the team's plans. A lead's
// own answer has its amounts hidden.
async function postAnswer({ store, event, group, user, message, isManager, nowIso }, asked) {
  const withVendor = hasVendor(store, group);
  const keep = !withVendor && !PRIVATE_INTENTS.has(asked.intent) && !looksPrivate(asked.reply);
  const redirected = !keep && (isManager || withVendor);
  const { wording } = redirected ? await redirectNote(user, withVendor) : {};
  const showsWhy = keep && asked.rationale && !looksPrivate(asked.rationale);
  postAgentMessage(store, {
    groupId: group.id,
    authorId: agentIdFor("planner", event.id),
    text: wording ?? hideAmounts(asked.reply),
    rationale: showsWhy ? asked.rationale : null,
    nowIso,
  });
  if (!asked.suggestDirective) return;
  message.suggestDirective = true;
  store.publish({
    type: "message.updated",
    eventId: event.id,
    groupId: group.id,
    message: messageView(store, message),
  });
}

const POSTERS = { vendor_brief: postBrief, log_expense: postExpense };

/**
 * Answers an @huddle message in the group it was posted in.
 * @param {{store: object, event: object, group: object, user: object, message: object,
 *   askedText: string, files?: Array<{mime: string, buffer: Buffer, name: string}>}} input Where and
 *   who asked. askedText is what they actually typed; the stored message has amounts hidden.
 * @returns {Promise<void>} Resolves once the reply is posted; it never throws.
 */
export async function replyAsPlanner({ files = [], ...input }) {
  const { store, event, group, user } = input;
  const nowIso = new Date().toISOString();
  const role = store.roleOf(user);
  try {
    const context = {
      ...input,
      files,
      role,
      nowIso,
      isManager: canSeeBudget(role, "total"),
      template: getTemplate(event.eventType),
    };
    const asked = await handleMention(mentionInput(context));
    await (POSTERS[asked.intent] ?? postAnswer)(context, asked);
  } catch (err) {
    console.error(`Planner reply failed with ${err.name}`);
    postAgentMessage(store, {
      groupId: group.id,
      authorId: agentIdFor("planner", event.id),
      // A reason someone can act on is worth more than "try again", which wouldn't help.
      text: err.name === "HttpError" ? err.message : SORRY,
      nowIso,
    });
  }
}
