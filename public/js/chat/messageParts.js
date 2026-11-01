/** Small pieces of a chat message. */
import { el, formatSize, formatTime } from "../shared/dom.js";

/**
 * Who wrote a message, whether they are AI, and when.
 * @param {object} message The message.
 * @param {string} name The author's name.
 * @param {string} [badge] Says in words that the author isn't a person.
 * @returns {HTMLElement} The line.
 */
export function byline(message, name, badge) {
  return el(
    "div",
    { class: "byline" },
    el("strong", { text: name }),
    badge ? el("span", { class: "ai-badge", text: badge }) : null,
    el("time", { datetime: message.createdAt, text: formatTime(message.createdAt) }),
  );
}

/**
 * A message's attachments, as download links.
 * @param {Array<{id: string, name: string, size: number}>} files The files.
 * @returns {HTMLElement} The list.
 */
export function attachmentList(files) {
  return el(
    "ul",
    { class: "attachments", "aria-label": "Attachments" },
    ...files.map((file) =>
      el(
        "li",
        {},
        el("a", {
          href: `/api/files/${encodeURIComponent(file.id)}`,
          download: "",
          text: `${file.name} (${formatSize(file.size)})`,
        }),
      ),
    ),
  );
}

/**
 * The AI's short reason for what it said, folded away until asked for.
 * @param {string} rationale The reason.
 * @returns {HTMLElement} The details element.
 */
export function whyDetails(rationale) {
  return el(
    "details",
    { class: "why" },
    el("summary", { text: "Why this?" }),
    el("p", { text: rationale }),
  );
}
