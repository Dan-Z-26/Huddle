import { clear, el, formatShortDate, keepFocus } from "./dom.js";

/**
 * Renders the group list and calls `onOpen(group)` when one is chosen. A group with messages the
 * person hasn't seen says so in text, not only with a mark.
 * @param {object[]} groups The groups.
 * @param {string | null} activeId The group on screen.
 * @param {(group: object) => void} onOpen What to do when one is chosen.
 * @param {Map<string, number>} [unread] New messages per group id.
 */
export function renderGroups(groups, activeId, onOpen, unread = new Map()) {
  keepFocus(() => drawGroups(groups, activeId, onOpen, unread));
}

function drawGroups(groups, activeId, onOpen, unread) {
  const list = document.getElementById("group-list");
  clear(list);
  document.getElementById("groups-empty").hidden = groups.length > 0;
  for (const group of groups) {
    const count = unread.get(group.id) ?? 0;
    list.append(
      el(
        "li",
        {},
        el(
          "button",
          {
            type: "button",
            "aria-current": String(group.id === activeId),
            "data-focus-key": `group:${group.id}`,
            onclick: () => onOpen(group),
          },
          group.name,
          count ? el("span", { class: "unread", text: `${count} new` }) : null,
        ),
      ),
    );
  }
}

/**
 * Lists what needs the person's attention: directives they haven't acknowledged, and their open
 * tasks. A directive opens its group. An empty list says so plainly.
 * @param {{directives: object[], tasks: object[]}} attention From the server.
 * @param {(groupId: string) => void} openGroup Opens a group by id.
 */
export function renderAttention(attention, openGroup) {
  keepFocus(() => drawAttention(attention, openGroup));
}

const MAX_ATTENTION = 5;

function drawAttention({ directives, tasks }, openGroup) {
  const box = document.getElementById("attention");
  clear(box);
  const items = [
    ...directives.map(({ id, groupId, groupName, text }) =>
      el(
        "li",
        {},
        el("button", {
          type: "button",
          class: "link-button",
          "data-focus-key": `attn:${id}`,
          onclick: () => openGroup(groupId),
          text: `Directive in ${groupName}: ${text}`,
        }),
      ),
    ),
    ...tasks.map(({ title, dueDate }) =>
      el("li", { text: `${title}, due ${formatShortDate(dueDate)}` }),
    ),
  ];
  const more = items.length - MAX_ATTENTION;
  box.append(
    items.length
      ? el(
          "ul",
          { class: "attention-list" },
          ...items.slice(0, MAX_ATTENTION),
          more > 0 ? el("li", { class: "muted", text: `and ${more} more on the timeline` }) : null,
        )
      : el("p", { text: "Nothing is waiting for you." }),
  );
}
