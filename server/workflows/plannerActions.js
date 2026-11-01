/** What the Planner does beyond answering: drafting a brief, and recording a payment. */
import { categoriesMentioned } from "../agents/discoveryDemo.js";
import { speak } from "../agents/speech.js";
import { mentionsMoney, parseAmount } from "../core/amount.js";
import { canSeeBudget } from "../core/permissions.js";
import { categoryName } from "../core/templates.js";
import { saveDraftBrief } from "./briefs.js";
import { logExpense } from "./expenseWatch.js";
import { mayWorkOn } from "./vendors.js";

const HYPOTHETICAL = /\?|\bwhat if\b|\bif we\b|\bshould we\b|\bcould we\b/i;

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

/**
 * Drafts a brief for whoever asked @huddle, if the category is theirs to hire for.
 * @param {object} context The event, the room, who asked, and what the Planner understood.
 * @returns {Promise<string>} The reply, with the brief in full after it.
 */
export async function briefReply({ store, event, template, group, user, role, asked, text }) {
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

/**
 * Records a payment someone told @huddle about. The amount comes from their own words and is read by
 * code, never by the model. What the Budget agent says is posted in a group, so it leaves the figure
 * on the Budget page.
 * @param {object} context The event, the room, who asked, and what the Planner understood.
 * @returns {Promise<{wording: string, rationale: string}>} What to say back.
 */
export function expenseReply({ store, event, template, group, user, role, asked, text }) {
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
