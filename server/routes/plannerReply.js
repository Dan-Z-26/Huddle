import { handleMention } from "../agents/planner.js";
import { hideAmounts, mentionsMoney, parseAmount } from "../core/amount.js";
import { canSeeBudget, canView } from "../core/permissions.js";
import { categoryName, getTemplate } from "../core/templates.js";
import { categoriesMentioned } from "../agents/discoveryDemo.js";
import { speak } from "../agents/speech.js";
import { logExpense } from "./expenseWatch.js";
import { saveDraftBrief } from "./hiringSupport.js";
import { eventQuotes, mayWorkOn } from "./vendorSupport.js";
import { eventExpenses, postAgentMessage } from "../store/workspace.js";
import { groupPeople, messageView, profileFor, publicUser } from "../views.js";

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
const HYPOTHETICAL = /\?|\bwhat if\b|\bif we\b|\bshould we\b|\bcould we\b/i;
const SORRY = "Sorry, I couldn't work on that just now. Please try again in a moment.";

// Which category someone means: what they named, preferring their own; else the room they said it
// in; else the one thing they own. Naming someone else's category stays that category, so the
// permission check refuses it rather than picking another.
function categoryMeant({ template, group, role, asked, text }) {
  const known = (id) => template.categories.some((category) => category.id === id);
  const mentioned = categoriesMentioned(text.replace(/@huddle\b/gi, ""), template);
  const rooms = group.kind === "category" ? (group.categoryIds ?? []) : [];
  const options = [
    asked.result?.categoryId,
    mentioned.find((id) => mayWorkOn(role, id)),
    mentioned[0],
    rooms.find((id) => mayWorkOn(role, id)),
    role.kind === "core" && role.categoryIds.length === 1 ? role.categoryIds[0] : null,
  ];
  return options.find((id) => id && known(id)) ?? null;
}

async function briefReply({ store, event, template, group, user, role, asked, text }) {
  const categoryId = categoryMeant({ template, group, role, asked, text });
  if (!categoryId)
    return "Which category is this for? Ask me in that category's group, or name it.";
  if (!mayWorkOn(role, categoryId))
    return "Only that category's lead or the event manager can start a brief.";
  const brief = await saveDraftBrief({ store, event, template, categoryId, user });
  const name = categoryName(template, categoryId);
  const facts = [
    `A brief for ${name} has been drafted from the event details, for ${user.name}.`,
    "It has no budget or amounts in it.",
    "Next: open Vendors and quotes, check the answers on scope, deliverables, dates, must-haves and how the vendor is chosen, then send it to Core team for approval.",
  ];
  const { wording } = await speak({
    agent: "Vendor",
    situation: "You just drafted a vendor brief, which follows your message in full.",
    facts,
    fallback: facts.join(" "),
  });
  return `${wording}\n\n${brief.text}`;
}

// The amount comes from the person's own words and is read by code, never by the model. What the
// Budget agent says is posted in a group, so it leaves the figure on the Budget page.
function expenseReply({ store, event, template, group, user, role, asked, text }) {
  const parsed = parseAmount(text);
  const currency = store.budgets.get(event.id).currency;
  const ask = (situation, fallback) =>
    speak({ agent: "Budget", situation, facts: [situation, fallback], fallback });
  // A question or a what-if isn't money that has gone out, so nothing is recorded on a guess.
  if (HYPOTHETICAL.test(text))
    return ask(
      `${user.name} asked something about a payment, which doesn't say it has been made.`,
      "I haven't recorded anything. If this has been paid, tell me plainly, like: we paid ₹40,000 for chairs.",
    );
  if (!parsed)
    return ask(
      `${user.name} told you about a payment but gave no amount you can read.`,
      "How much was it? Please include the amount, like ₹40,000 or 2 lakh.",
    );
  if (parsed.currency && parsed.currency !== currency)
    return ask(
      `${user.name} gave a payment in the wrong currency.`,
      `Please give the amount in ${currency}.`,
    );
  const categoryId = categoryMeant({ template, group, role, asked, text });
  if (!categoryId)
    return ask(
      `${user.name} told you about a payment, but you can't tell which category it belongs to.`,
      "Which category should this go under? Ask me in its group, or name it.",
    );
  if (!canSeeBudget(role, { categoryId }))
    return ask(
      `${user.name} tried to record a payment against a category someone else owns, so it was not recorded.`,
      "That category belongs to someone else.",
    );
  const said = asked.result?.description?.trim();
  const description = said && !mentionsMoney(said) ? said : `Logged by ${user.name}`;
  logExpense({
    store,
    event,
    user,
    fields: { description, amountMinor: parsed.minor, categoryId, fromBuffer: false },
  });
  const name = categoryName(template, categoryId);
  const logged = `Logged "${description}" under ${name}.`;
  const where = "The figures are on the Budget page, and it can be removed there.";
  return ask(`You just recorded a payment for ${user.name}. ${logged}`, `${logged} ${where}`);
}

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
    authorId: `agent-vendor@${event.id}`,
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
    authorId: `agent-budget@${event.id}`,
    text: wording,
    rationale: rationale || null,
    nowIso,
  });
}

// Figures stay out of a shared room, and a vendor's room hears nothing of the team's plans: the
// asker is pointed to where they can read the answer. A lead's own answer has its amounts hidden.
async function postAnswer({ store, event, group, user, message, isManager, nowIso }, asked) {
  const withVendor = groupPeople(store, group).some(({ kind }) => kind === "vendor");
  const keep = !withVendor && !PRIVATE_INTENTS.has(asked.intent) && !looksPrivate(asked.reply);
  const note = withVendor ? VENDOR_ROOM_NOTE : PRIVATE_NOTE;
  const privately =
    !keep && (isManager || withVendor)
      ? await speak({
          agent: "Planner",
          situation: `${user.name} asked you something in a shared room, and the answer ${withVendor ? "isn't for the outside vendor in this room" : "involves budget figures"}.`,
          facts: [note],
          fallback: note,
        })
      : null;
  postAgentMessage(store, {
    groupId: group.id,
    authorId: `agent-planner@${event.id}`,
    text: privately?.wording ?? hideAmounts(asked.reply),
    rationale: keep && asked.rationale && !looksPrivate(asked.rationale) ? asked.rationale : null,
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
      authorId: `agent-planner@${event.id}`,
      // A reason someone can act on is worth more than "try again", which wouldn't help.
      text: err.name === "HttpError" ? err.message : SORRY,
      nowIso,
    });
  }
}
