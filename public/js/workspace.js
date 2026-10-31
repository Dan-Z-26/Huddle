import { api } from "./api.js";
import { announce, clear, el, formatTime, initials } from "./dom.js";

const ABOUT = {
  announcements: "Everyone is here. Only the event manager and AI members can post.",
  core: "The core team's room for budget talk and quote comparisons.",
  category: "A working room for the people who own this area.",
};
const BADGE = { agent: "AI", system: "Automatic notice" };

/** Renders the group list and calls `onOpen(group)` when one is chosen. */
export function renderGroups(groups, activeId, onOpen) {
  const list = document.getElementById("group-list");
  clear(list);
  document.getElementById("groups-empty").hidden = groups.length > 0;
  for (const group of groups) {
    list.append(
      el(
        "li",
        {},
        el("button", {
          type: "button",
          "aria-current": String(group.id === activeId),
          onclick: () => onOpen(group),
          text: group.name,
        }),
      ),
    );
  }
}

function messageRow(message, author) {
  const badge = BADGE[message.authorKind];
  const name = author?.name ?? "Huddle";
  const byline = el("div", { class: "byline" }, el("strong", { text: name }));
  if (badge) byline.append(el("span", { class: "ai-badge", text: badge }));
  byline.append(el("time", { datetime: message.createdAt, text: formatTime(message.createdAt) }));
  const body = [byline, el("p", { text: message.text })];
  if (message.rationale) {
    body.push(
      el(
        "details",
        { class: "why" },
        el("summary", { text: "Why this?" }),
        el("p", { text: message.rationale }),
      ),
    );
  }
  const kind = message.authorKind === "system" ? " system" : badge ? " ai" : "";
  return el(
    "article",
    { class: `message${kind}` },
    el("span", { class: "avatar", "aria-hidden": "true", text: initials(name) }),
    el("div", {}, ...body),
  );
}

/**
 * Shows one group's recent messages. The log is swapped whole, so a full render stays silent and
 * screen readers announce only messages that arrive later.
 * @param {object} group The group.
 * @param {object[]} members People and AI members of the event.
 * @param {() => boolean} isCurrent Whether this group is still the one wanted, once the fetch returns.
 */
export async function showGroup(group, members, isCurrent) {
  document.getElementById("group-title").textContent = group.name;
  document.getElementById("group-about").textContent = ABOUT[group.kind] ?? "";
  try {
    const { messages } = await api.messages(group.id);
    if (!isCurrent()) return;
    const byId = new Map(members.map((member) => [member.id, member]));
    const log = document.getElementById("messages");
    const fresh = log.cloneNode(false);
    if (messages.length === 0) fresh.append(el("p", { class: "muted", text: "No messages yet." }));
    fresh.append(...messages.map((message) => messageRow(message, byId.get(message.authorId))));
    log.replaceWith(fresh);
  } catch (err) {
    announce(err.message);
  }
}

/** Lists what needs the user's attention; an empty list says so plainly. */
export function renderAttention({ directives, tasks }) {
  const box = document.getElementById("attention");
  clear(box);
  const items = [
    ...directives.map(() => "A directive is waiting for you"),
    ...tasks.map((t) => t.title),
  ];
  box.append(
    items.length
      ? el("ul", {}, ...items.map((text) => el("li", { text })))
      : el("p", { text: "Nothing is waiting for you." }),
  );
}
