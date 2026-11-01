/** A group on screen: its pinned directives, messages and what arrives live. */
import { api } from "../shared/api.js";
import {
  $,
  announce,
  announceError,
  clear,
  el,
  formatDay,
  initials,
  keepFocus,
} from "../shared/dom.js";
import { isCurrent, generation } from "../shared/session.js";
import { setUpComposer } from "./composer.js";
import { directiveCard } from "./directiveCard.js";
import { attachmentList, byline, whyDetails } from "./messageParts.js";
import { openPin } from "./pin.js";

const ABOUT = {
  announcements: "Everyone is here. Only the event manager and AI members can post.",
  core: "The core team's room for budget talk and quote comparisons.",
  category: "A working room for the people who own this area.",
};
const BADGE = { agent: "AI", system: "Automatic notice" };
const ROW_KIND = { agent: " ai", system: " system" };
const SAME_BREATH_MS = 5 * 60_000;
const SPOKEN_TEXT_CHARS = 40;
const PINNED_TEXT_CHARS = 120;
const NEAR_END_PX = 120;

// The group on screen, and what is drawn for it. Live events update these in place.
let current = null;
const rows = new Map();
const pinned = new Map();
let last = null;

const nameOf = (id) => current?.members.find((member) => member.id === id)?.name ?? "Someone";

const cardFor = (directive, where) => directiveCard(directive, where, { ...current, nameOf });

// A follow-up from the same person, moments later, drops the repeated name and avatar.
function continues(message) {
  return (
    last?.authorId === message.authorId &&
    message.authorKind === "human" &&
    new Date(message.createdAt) - new Date(last.createdAt) < SAME_BREATH_MS
  );
}

function appendRow(log, message) {
  const day = formatDay(message.createdAt);
  const newDay = !last || formatDay(last.createdAt) !== day;
  if (newDay) log.append(el("p", { class: "day", text: day }));
  log.append(messageRow(message, !newDay && continues(message)));
  last = message;
}

function pinActions(message) {
  const suggested = message.suggestDirective;
  return el(
    "div",
    { class: `message-actions${suggested ? " is-suggested" : ""}` },
    suggested ? el("span", { class: "tag note", text: "Huddle suggests pinning this" }) : null,
    el("button", {
      type: "button",
      class: "link-button",
      text: "Pin as directive",
      "aria-label": `Pin as directive: ${message.text.slice(0, SPOKEN_TEXT_CHARS)}`,
      "data-focus-key": `pin:${message.id}`,
      onclick: () => openPin(message, current, () => afterPin(message.id)),
    }),
  );
}

function messageBody(message, name) {
  const badge = BADGE[message.authorKind];
  const body = [
    byline(message, name, badge),
    el("p", { class: "message-text", text: message.text }),
  ];
  if (message.files?.length) body.push(attachmentList(message.files));
  if (message.directive) body.push(cardFor(message.directive, `row:${message.id}`));
  else if (current.isManager && message.authorKind === "human") body.push(pinActions(message));
  if (message.rationale) body.push(whyDetails(message.rationale));
  return body;
}

function messageRow(message, cont = false) {
  const name = current.members.find((member) => member.id === message.authorId)?.name ?? "Huddle";
  const isAi = message.authorKind === "agent";
  const kind = ROW_KIND[message.authorKind] ?? "";
  const mine = message.authorId === current.me.id ? " mine" : "";
  const row = el(
    "article",
    { class: `message${kind}${mine}${cont ? " is-cont" : ""}` },
    el("span", { class: "avatar", "aria-hidden": "true", text: isAi ? "✦" : initials(name) }),
    el("div", { class: "message-body" }, ...messageBody(message, name)),
  );
  rows.set(message.id, { row, message, cont });
  return row;
}

function afterPin(messageId) {
  announce("Pinned. Everyone it names has been asked to tap Got it.");
  // The Pin button is about to go, so focus moves to the message it belonged to.
  const row = rows.get(messageId)?.row;
  row?.setAttribute("tabindex", "-1");
  row?.focus();
}

function renderPinned() {
  keepFocus(drawPinned);
}

function drawPinned() {
  const list = $("pinned-list");
  clear(list);
  $("pinned").hidden = pinned.size === 0;
  for (const { directive, text } of pinned.values()) {
    const card = cardFor({ ...directive, text }, `pinned:${directive.id}`);
    card.prepend(
      el("span", {
        class: "directive-text",
        text: text.length > PINNED_TEXT_CHARS ? `${text.slice(0, PINNED_TEXT_CHARS)}…` : text,
      }),
    );
    list.append(el("li", { class: "pinned-item" }, card));
  }
}

/**
 * Adds a message that arrived live, to the room on screen. Announced by the log's live region.
 * @param {object} message The message.
 * @returns {boolean} Whether it was added.
 */
export function addLiveMessage(message) {
  if (!current || message.groupId !== current.group.id || rows.has(message.id)) return false;
  const log = $("messages");
  log.querySelector(".empty")?.remove();
  log.querySelector(".thinking")?.remove();
  const nearEnd = log.scrollHeight - log.scrollTop - log.clientHeight < NEAR_END_PX;
  appendRow(log, message);
  if (nearEnd) log.scrollTop = log.scrollHeight;
  if (message.directive)
    pinned.set(message.directive.id, { directive: message.directive, text: message.text });
  renderPinned();
  return true;
}

/**
 * Updates one message when the Planner suggests pinning it. Only its actions change, so the log
 * isn't re-read.
 * @param {object} message The message.
 */
export function updateLiveMessage(message) {
  const known = rows.get(message.id);
  if (!current || !known || message.groupId !== current.group.id) return;
  known.message = message;
  const old = known.row.querySelector(".message-actions");
  if (old) keepFocus(() => old.replaceWith(pinActions(message)));
}

// Only the card changes, so an acknowledgement isn't announced as a whole new message.
function placeDirective({ row, message }, directive) {
  const card = cardFor(directive, `row:${message.id}`);
  const old = row.querySelector(".directive");
  if (old) {
    old.replaceWith(card);
    return;
  }
  const body = row.lastElementChild;
  body.querySelector(".message-actions")?.remove();
  const why = body.querySelector(".why");
  if (why) why.before(card);
  else body.append(card);
}

/**
 * Updates a directive's card and the pinned list as people acknowledge it.
 * @param {object} directive The directive.
 */
export function updateLiveDirective(directive) {
  if (!current || directive.groupId !== current.group.id) return;
  const known = [...rows.values()].find(({ message }) => message.id === directive.messageId);
  if (known) {
    known.message.directive = directive;
    keepFocus(() => placeDirective(known, directive));
    pinned.set(directive.id, { directive, text: known.message.text });
  } else if (pinned.has(directive.id))
    pinned.set(directive.id, { ...pinned.get(directive.id), directive });
  renderPinned();
}

/**
 * Shows one group: its pinned directives, recent messages and composer. The log is swapped whole,
 * so a full render stays silent and screen readers announce only messages that arrive later.
 * @param {object} group The group, with `canPost`.
 * @param {object[]} members People and AI members of the event.
 * @param {{me: object, isManager: boolean}} who The person looking.
 * @param {() => boolean} isStillWanted Whether this group is still the one wanted when the fetch returns.
 */
export async function showGroup(group, members, who, isStillWanted) {
  $("group-title").textContent = group.name;
  $("group-about").textContent = ABOUT[group.kind] ?? "";
  const started = generation();
  try {
    const { messages, pinned: pins } = await api.messages(group.id);
    if (!isStillWanted() || !isCurrent(started)) return;
    current = { group, members, ...who };
    rows.clear();
    pinned.clear();
    last = null;
    // Filled before it is put in the page, so a screen reader doesn't read the whole history aloud.
    const fresh = $("messages").cloneNode(false);
    if (messages.length === 0)
      fresh.append(
        el("p", {
          class: "muted empty",
          text: group.canPost
            ? "No messages yet. Say hello, or ask Huddle for a hand."
            : "No messages yet.",
        }),
      );
    for (const message of messages) appendRow(fresh, message);
    const hadFocus = document.activeElement === $("messages");
    $("messages").replaceWith(fresh);
    if (hadFocus) fresh.focus();
    for (const directive of pins) pinned.set(directive.id, { directive, text: directive.text });
    renderPinned();
    setUpComposer(group, addLiveMessage, who.me.kind === "vendor");
    fresh.scrollTop = fresh.scrollHeight;
  } catch (err) {
    announceError(err.message);
  }
}
