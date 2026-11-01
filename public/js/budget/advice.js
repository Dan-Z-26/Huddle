/** The Planner's next steps on the Ask Huddle page. */
import { api } from "../shared/api.js";
import { $, clear, el, keepFocus } from "../shared/dom.js";
import { generation, isCurrent } from "../shared/session.js";

const ACTION = {
  budget: "Open budget",
  timeline: "Open timeline",
  vendors: "Open vendors",
  ask: "Ask Huddle",
};

function item({ title, why, action }, open) {
  return el(
    "li",
    { class: "advice-item" },
    el("strong", { text: title }),
    el("p", { text: why }),
    ACTION[action]
      ? el("button", {
          type: "button",
          class: "button small",
          text: ACTION[action],
          "aria-label": `${ACTION[action]}: ${title}`,
          "data-focus-key": `advice:${title}`,
          onclick: () => open[action]?.(),
        })
      : null,
  );
}

/**
 * Shows the Planner's next steps on the Ask Huddle page. It never blocks the page: the section says
 * it is reading the plan and fills in when the answer comes, and failing is simply quiet.
 * @param {string} eventId The event.
 * @param {Record<string, () => void>} open What each step's button opens.
 */
export async function loadAdvice(eventId, open) {
  const started = generation();
  const section = $("advice");
  const list = $("advice-list");
  const status = $("advice-status");
  section.hidden = false;
  if (!list.children.length) status.textContent = "Reading your plan…";
  try {
    const { items, summary, offline } = await api.advice(eventId);
    if (!isCurrent(started)) return;
    keepFocus(() => {
      clear(list);
      list.append(...items.map((next) => item(next, open)));
    });
    status.textContent = offline
      ? "The AI isn't available right now, so these come straight from your figures."
      : summary;
  } catch {
    if (isCurrent(started)) section.hidden = true;
  }
}
