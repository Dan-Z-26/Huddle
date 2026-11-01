import { clear, el, formatMoney, formatShortDate, keepFocus } from "./dom.js";
import { roomIcon } from "./icons.js";

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

// The AI members are in every room, so only the people are counted.
const peopleIn = ({ memberRoleIds }) =>
  memberRoleIds.filter((id) => !id.startsWith("agent-")).length;

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
          el("span", { class: "tile" }, roomIcon(group.name)),
          el(
            "span",
            { class: "group-text" },
            group.name,
            el("small", {
              text: `${peopleIn(group)} ${peopleIn(group) === 1 ? "person" : "people"}`,
            }),
          ),
          count ? el("span", { class: "unread", text: `${count} new` }) : null,
        ),
      ),
    );
  }
}

/**
 * Lists what needs the person's attention: directives they haven't acknowledged, and their open
 * tasks. A directive opens its group. An empty list says so plainly.
 * Spending near or over its plan comes first and opens the Budget page.
 * @param {{directives: object[], tasks: object[], spending: object | null, briefs?: object[],
 *   quotes?: object[]}} attention From the server.
 * @param {(groupId: string) => void} openGroup Opens a group by id.
 * @param {() => void} [openBudget] Opens the Budget page.
 * @param {(categoryId: string) => void} [openVendors] Opens Vendors on a category.
 */
export function renderAttention(
  attention,
  openGroup,
  openBudget = () => {},
  openVendors = () => {},
) {
  keepFocus(() => drawAttention(attention, openGroup, openBudget, openVendors));
}

const MAX_ATTENTION = 5;
let lastCount = null;

function spendingItems(spending, openBudget) {
  if (!spending) return [];
  const money = (minor) => formatMoney(minor, spending.currency);
  const button = (key, text) =>
    el(
      "li",
      {},
      el("button", {
        type: "button",
        class: "link-button",
        "data-focus-key": `attn:${key}`,
        onclick: openBudget,
        text,
      }),
    );
  return [
    ...spending.categories.map(({ categoryId, name, status, overMinor, leftMinor }) =>
      button(
        categoryId,
        status === "over"
          ? `${name} is ${money(overMinor)} over plan`
          : `${name} has ${money(leftMinor)} left`,
      ),
    ),
    ...(spending.bufferLeftMinor === null
      ? []
      : [button("buffer", `The buffer is low: ${money(spending.bufferLeftMinor)} left`)]),
  ];
}

function drawAttention(
  { directives, tasks, spending, briefs = [], quotes = [] },
  openGroup,
  openBudget,
  openVendors,
) {
  const box = document.getElementById("attention");
  clear(box);
  const items = [
    ...spendingItems(spending, openBudget),
    ...quotes.map(({ categoryId, name, count }) =>
      el(
        "li",
        {},
        el("button", {
          type: "button",
          class: "link-button",
          "data-focus-key": `attn:quotes-${categoryId}`,
          onclick: () => openVendors(categoryId),
          text: `${name}: ${count} ${count === 1 ? "quote" : "quotes"} to review`,
        }),
      ),
    ),
    ...briefs.map(({ categoryId, name }) =>
      el(
        "li",
        {},
        el("button", {
          type: "button",
          class: "link-button",
          "data-focus-key": `attn:brief-${categoryId}`,
          onclick: () => openVendors(categoryId),
          text: `${name} brief is waiting for your approval`,
        }),
      ),
    ),
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
  document.getElementById("attention-count").textContent = items.length || "";
  // Heard when something new arrives, not on every redraw.
  if (lastCount !== null && items.length > lastCount)
    document.getElementById("attention-live").textContent =
      `Needs your attention: ${items.length} ${items.length === 1 ? "item" : "items"}.`;
  lastCount = items.length;
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
