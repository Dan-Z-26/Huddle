/** The first page: the event brief, today's digest, and what the team and the AI are doing. */
import { api } from "../shared/api.js";
import {
  $,
  clear,
  countdown,
  el,
  formatDate,
  formatMoney,
  formatTime,
  keepFocus,
} from "../shared/dom.js";
import { roomIcon } from "../shared/icons.js";

const MAX_FEED = 12;
const DAY_MS = 86400000;
let feed = [];
let context = null;

function fact(label, value) {
  return value
    ? el("div", { class: "brief-fact" }, el("dt", { text: label }), el("dd", { text: value }))
    : null;
}

function mustHaveList({ mustHaves = [], absoluteMustHaveId }) {
  if (mustHaves.length === 0) return null;
  return el(
    "section",
    { class: "brief-block" },
    el("h3", { text: "Must-haves" }),
    el(
      "ul",
      { class: "brief-must", role: "list" },
      ...mustHaves.map(({ id, text }) =>
        el(
          "li",
          { class: id === absoluteMustHaveId ? "is-absolute" : "" },
          text,
          id === absoluteMustHaveId
            ? el("span", { class: "seal", text: "The one that can't move" })
            : null,
        ),
      ),
    ),
  );
}

function priorityList({ priorities = [] }, categories) {
  if (priorities.length === 0) return null;
  const nameOf = (id) => categories.find((item) => item.id === id)?.name ?? id;
  return el(
    "section",
    { class: "brief-block" },
    el("h3", { text: "Your priorities, in your order" }),
    el("ol", { class: "brief-rank" }, ...priorities.map((id) => el("li", { text: nameOf(id) }))),
  );
}

function notesBlock(notes) {
  if (notes.length === 0) return null;
  return el(
    "section",
    { class: "brief-block" },
    el("h3", { text: "Keep in mind" }),
    el("ul", { class: "brief-notes", role: "list" }, ...notes.map((text) => el("li", { text }))),
  );
}

function briefFacts({ date, city, venueType, guests, budget }) {
  return el(
    "dl",
    { class: "brief-facts" },
    fact("When", date && formatDate(date)),
    fact("Where", [venueType, city].filter(Boolean).join(", ")),
    fact("Guests", guests?.confirmed ? String(guests.confirmed) : null),
    fact("Budget", budget?.totalMinor ? formatMoney(budget.totalMinor, budget.currency) : null),
    el(
      "div",
      { class: "sr-only" },
      el("dt", { text: "Time left" }),
      el("dd", { text: countdown(date) }),
    ),
  );
}

function feelingFigure({ attendeeExperience }) {
  if (!attendeeExperience) return null;
  return el(
    "figure",
    { class: "brief-feel" },
    el("figcaption", { text: "What guests should feel" }),
    el("blockquote", { text: attendeeExperience }),
  );
}

function drawBrief({ event, template }) {
  $("overview-sash").textContent = countdown(event.date);
  $("overview-kind").textContent = template.label;
  $("overview-title").textContent = event.name || template.label;
  const hero = $("overview-brief");
  clear(hero);
  hero.append(
    event.purpose ? el("p", { class: "brief-purpose", text: event.purpose }) : "",
    briefFacts(event),
    feelingFigure(event) ?? "",
    el(
      "div",
      { class: "brief-blocks" },
      mustHaveList(event),
      priorityList(event, template.categories),
      notesBlock(Object.values(event.constraints ?? {}).flat()),
    ),
  );
}

const memberOf = (id) => context.members.find((member) => member.id === id);
const roomOf = (id) => context.groups.find((group) => group.id === id);

function drawDigest(message) {
  const box = $("overview-digest");
  clear(box);
  $("digest-card").hidden = !message;
  if (!message) return;
  box.append(el("p", { class: "digest-text", text: message.text }));
  $("digest-time").textContent = formatTime(message.createdAt);
  $("digest-time").dateTime = message.createdAt;
}

function feedItem(message, isNew) {
  const room = roomOf(message.groupId);
  const author = memberOf(message.authorId);
  const isAi = message.authorKind !== "human";
  return el(
    "li",
    {},
    el(
      "button",
      {
        type: "button",
        class: `feed-item${isNew ? " is-new" : ""}${isAi ? " is-ai" : ""}`,
        "data-focus-key": `feed:${message.id}`,
        onclick: () => context.openGroup(message.groupId),
      },
      el("span", { class: "tile" }, roomIcon(room?.name ?? "")),
      el(
        "span",
        { class: "feed-body" },
        el(
          "span",
          { class: "feed-who" },
          el("strong", { text: author?.name ?? "Huddle" }),
          isAi ? el("span", { class: "ai-badge", text: "AI" }) : null,
          el("span", { class: "feed-room", text: `in ${room?.name ?? "a group"}` }),
          el("time", { datetime: message.createdAt, text: formatTime(message.createdAt) }),
        ),
        el("span", { class: "feed-text", text: message.text }),
      ),
    ),
  );
}

// One notice posted in several rooms is one thing that happened.
const withoutRepeats = (messages) =>
  messages.filter(
    (message, index) =>
      !messages
        .slice(index + 1)
        .some(({ authorId, text }) => authorId === message.authorId && text === message.text),
  );

function drawFeed(newId) {
  const list = $("overview-feed");
  const { scrollTop } = list;
  keepFocus(() => {
    clear(list);
    $("feed-empty").hidden = feed.length > 0;
    for (const message of withoutRepeats(feed).toReversed())
      list.append(feedItem(message, message.id === newId));
  });
  list.scrollTop = scrollTop;
}

/**
 * Draws the first page: the event brief, today's digest, and what the team and the AI are doing.
 * @param {{event: object, template: object, groups: object[], members: object[],
 *   openGroup: (id: string) => void}} input The event, its rooms and people, and how to open a room.
 * @returns {Promise<void>} Resolves once the digest and the feed are drawn.
 */
export async function renderOverview(input) {
  context = input;
  drawBrief(input);
  const { messages } = await api.activity(input.event.id);
  feed = messages.filter(({ text }) => text);
  drawFeed();
  const home = input.groups.find(({ kind }) => kind === "announcements");
  const posted = home ? (await api.messages(home.id)).messages : [];
  drawDigest(
    posted.findLast(
      ({ digest, createdAt }) => digest && Date.now() - Date.parse(createdAt) < DAY_MS,
    ),
  );
}

/**
 * Adds a message that just arrived to the feed, and to the digest if that's what it is.
 * @param {object} message The message.
 */
export function addToOverview(message) {
  if (!context || !message.text || !roomOf(message.groupId)) return;
  if (feed.some(({ id }) => id === message.id)) return;
  feed = [...feed, message].slice(-MAX_FEED);
  drawFeed(message.id);
  const who = memberOf(message.authorId)?.name ?? "Huddle";
  $("feed-live").textContent =
    `New in ${roomOf(message.groupId).name}: ${who}${message.authorKind === "human" ? "" : " (AI)"}`;
  if (message.digest) drawDigest(message);
}
