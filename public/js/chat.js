import { api } from "./api.js";
import { announce, clear, el, formatTime, initials, keepFocus } from "./dom.js";
import { isCurrent, generation } from "./session.js";
import { openPin } from "./pin.js";

const $ = (id) => document.getElementById(id);
const ABOUT = {
  announcements: "Everyone is here. Only the event manager and AI members can post.",
  core: "The core team's room for budget talk and quote comparisons.",
  category: "A working room for the people who own this area.",
};
const BADGE = { agent: "AI", system: "Automatic notice" };
const kb = (bytes) =>
  bytes < 1024 * 100
    ? `${Math.max(1, Math.round(bytes / 1024))} KB`
    : `${(bytes / 1048576).toFixed(1)} MB`;

// The group on screen, and what is drawn for it. Live events update these in place.
let current = null;
const rows = new Map();
const pinned = new Map();

const nameOf = (id) => current?.members.find((member) => member.id === id)?.name ?? "Someone";

function directiveCard(directive, where) {
  const { me, isManager } = current;
  const status = directive.status;
  const mine = directive.addressedUserIds.includes(me.id);
  const acked = directive.acks.some(({ userId }) => userId === me.id);
  const card = el(
    "div",
    { class: "directive" },
    el("strong", { text: "Directive" }),
    el("span", {
      class: "directive-status",
      tabindex: "-1",
      "data-focus-after": `ack:${directive.id}:${where}`,
      text: status.label,
    }),
  );
  if (isManager && status.pending.length)
    card.append(
      el("span", { class: "muted", text: `Waiting for ${status.pending.map(nameOf).join(", ")}` }),
    );
  if (mine && !acked)
    card.append(
      el("button", {
        type: "button",
        class: "button primary small",
        text: "Got it",
        "aria-label": `Got it: ${directive.text ?? "this directive"}`.slice(0, 120),
        "data-focus-key": `ack:${directive.id}:${where}`,
        onclick: () => acknowledge(directive.id),
      }),
    );
  if (mine && acked) card.append(el("span", { class: "tag", text: "You've acknowledged this" }));
  return card;
}

async function acknowledge(id) {
  try {
    await api.ack(id);
    announce("Acknowledged. Thank you.");
  } catch (err) {
    announce(err.message);
  }
}

function messageRow(message) {
  const badge = BADGE[message.authorKind];
  const name = current.members.find((member) => member.id === message.authorId)?.name ?? "Huddle";
  const byline = el("div", { class: "byline" }, el("strong", { text: name }));
  if (badge) byline.append(el("span", { class: "ai-badge", text: badge }));
  byline.append(el("time", { datetime: message.createdAt, text: formatTime(message.createdAt) }));
  const body = [byline, el("p", { text: message.text })];
  if (message.files?.length) {
    body.push(
      el(
        "ul",
        { class: "attachments", "aria-label": "Attachments" },
        ...message.files.map((file) =>
          el(
            "li",
            {},
            el("a", {
              href: `/api/files/${encodeURIComponent(file.id)}`,
              download: "",
              text: `${file.name} (${kb(file.size)})`,
            }),
          ),
        ),
      ),
    );
  }
  if (message.directive) body.push(directiveCard(message.directive, `row:${message.id}`));
  else if (current.isManager && message.authorKind === "human") {
    const suggested = message.suggestDirective;
    body.push(
      el(
        "div",
        { class: "message-actions" },
        suggested ? el("span", { class: "tag note", text: "Huddle suggests pinning this" }) : null,
        el("button", {
          type: "button",
          class: "link-button",
          text: "Pin as directive",
          "aria-label": `Pin as directive: ${message.text.slice(0, 40)}`,
          "data-focus-key": `pin:${message.id}`,
          onclick: () => openPin(message, current, afterPin),
        }),
      ),
    );
  }
  if (message.rationale)
    body.push(
      el(
        "details",
        { class: "why" },
        el("summary", { text: "Why this?" }),
        el("p", { text: message.rationale }),
      ),
    );
  const kind = message.authorKind === "system" ? " system" : badge ? " ai" : "";
  const row = el(
    "article",
    { class: `message${kind}` },
    el("span", { class: "avatar", "aria-hidden": "true", text: initials(name) }),
    el("div", {}, ...body),
  );
  rows.set(message.id, { row, message });
  return row;
}

function afterPin() {
  announce("Pinned. Everyone it names has been asked to tap Got it.");
}

function renderPinned() {
  keepFocus(drawPinned);
}

function drawPinned() {
  const list = $("pinned-list");
  clear(list);
  $("pinned").hidden = pinned.size === 0;
  for (const { directive, text } of pinned.values()) {
    const card = directiveCard({ ...directive, text }, `pinned:${directive.id}`);
    card.prepend(
      el("span", {
        class: "directive-text",
        text: text.length > 120 ? `${text.slice(0, 120)}…` : text,
      }),
    );
    list.append(el("li", { class: "pinned-item" }, card));
  }
}

/** Adds a message that arrived live, to the room on screen. Announced by the log's live region. */
export function addLiveMessage(message) {
  if (!current || message.groupId !== current.group.id || rows.has(message.id)) return false;
  const log = $("messages");
  log.querySelector(".empty")?.remove();
  log.querySelector(".thinking")?.remove();
  log.append(messageRow(message));
  if (message.directive)
    pinned.set(message.directive.id, { directive: message.directive, text: message.text });
  renderPinned();
  return true;
}

/** Redraws one message, for example when the Planner suggests pinning it. */
export function updateLiveMessage(message) {
  const known = rows.get(message.id);
  if (!current || !known || message.groupId !== current.group.id) return;
  known.row.replaceWith(messageRow(message));
}

// Only the card changes, so an acknowledgement isn't announced as a whole new message.
function placeDirective({ row, message }, directive) {
  const card = directiveCard(directive, `row:${message.id}`);
  const old = row.querySelector(".directive");
  if (old) return old.replaceWith(card);
  const body = row.lastElementChild;
  body.querySelector(".message-actions")?.remove();
  body.querySelector(".why")?.before(card) ?? body.append(card);
}

/** Updates a directive's card and the pinned list as people acknowledge it. */
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

function setUpComposer(group) {
  const form = $("composer");
  const note = $("composer-note");
  form.hidden = !group.canPost;
  note.hidden = group.canPost;
  note.textContent =
    group.kind === "announcements"
      ? "Only the event manager and AI members post in #announcements."
      : "You can read this room. Posting here is for the people who own this area.";
  const text = $("composer-text");
  const files = $("composer-files");
  const send = $("composer-send");
  text.onkeydown = (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      form.requestSubmit();
    }
  };
  form.onsubmit = async (e) => {
    e.preventDefault();
    const body = text.value.trim();
    const status = $("composer-status");
    if (send.getAttribute("aria-disabled") === "true") return;
    if (!body && files.files.length === 0) {
      status.textContent = "Write a message or attach a file first.";
      return;
    }
    if (files.files.length > 3) {
      status.textContent = "Please attach up to 3 files.";
      return;
    }
    const data = new FormData();
    if (body) data.set("text", body);
    for (const file of files.files) data.append("files", file);
    // aria-disabled, not disabled, so focus stays on the button while it works.
    send.setAttribute("aria-disabled", "true");
    send.textContent = files.files.length ? "Uploading…" : "Sending…";
    status.textContent = files.files.length
      ? `Uploading ${files.files.length === 1 ? "1 file" : `${files.files.length} files`}…`
      : "Sending…";
    try {
      const { message } = await api.postMessage(group.id, data);
      text.value = "";
      files.value = "";
      status.textContent = "Message sent.";
      addLiveMessage(message);
      if (/@huddle\b/i.test(message.text)) {
        const waiting = el("p", { class: "muted thinking", text: "Huddle is working on that…" });
        $("messages").append(waiting);
        // If no reply comes, don't leave this standing.
        setTimeout(() => waiting.remove(), 45_000);
      }
      $("messages").scrollTop = $("messages").scrollHeight;
    } catch (err) {
      status.textContent = err.message;
    } finally {
      send.removeAttribute("aria-disabled");
      send.textContent = "Send";
    }
  };
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
    // Filled before it is put in the page, so a screen reader doesn't read the whole history aloud.
    const fresh = $("messages").cloneNode(false);
    if (messages.length === 0)
      fresh.append(el("p", { class: "muted empty", text: "No messages yet." }));
    fresh.append(...messages.map(messageRow));
    $("messages").replaceWith(fresh);
    for (const directive of pins) pinned.set(directive.id, { directive, text: directive.text });
    renderPinned();
    setUpComposer(group);
    fresh.scrollTop = fresh.scrollHeight;
  } catch (err) {
    announce(err.message);
  }
}
