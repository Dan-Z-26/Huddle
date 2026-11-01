/** "Suggest ideas": personalised ideas from the event's own profile, each saying why it fits. */
import { api } from "../shared/api.js";
import { $, announce, announceError, clear, el, whileBusy } from "../shared/dom.js";
import { generation, isCurrent } from "../shared/session.js";

const LEVEL = { light: "Light on budget", moderate: "Moderate", stretch: "A stretch" };

function ideaCard({ title, whyItFits, level, costShare }) {
  return el(
    "li",
    { class: "idea" },
    el("h3", { class: "idea-title", text: title }),
    el("span", { class: "tag note", text: LEVEL[level] ?? level }),
    el("p", { text: whyItFits }),
    el("p", { class: "muted", text: costShare }),
  );
}

/** Hides the ideas panel. */
export const hideIdeas = () => ($("ideas").hidden = true);

function showIdeas({ ideas, rationale, offline }) {
  const list = $("ideas-list");
  clear(list);
  list.append(...ideas.map(ideaCard));
  if (ideas.length === 0)
    list.append(el("li", { text: "No ideas came back that fit. Please try again." }));
  $("ideas-offline").hidden = !offline;
  $("ideas-rationale").textContent = rationale;
  $("ideas").hidden = false;
  $("ideas").focus();
}

/**
 * Wires "Suggest ideas": personalised ideas from the event's own profile, each saying why it fits.
 * @param {string} eventId The event.
 */
export function setUpIdeas(eventId) {
  const button = $("ideas-get");
  button.onclick = async () => {
    announce("");
    const started = generation();
    try {
      const answer = await whileBusy(button, "Thinking…", () => api.ideas(eventId));
      if (isCurrent(started)) showIdeas(answer);
    } catch (err) {
      announceError(err.message);
    }
  };
  $("ideas-close").onclick = () => {
    hideIdeas();
    button.focus();
  };
}
