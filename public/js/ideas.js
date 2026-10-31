import { api } from "./api.js";
import { announce, clear, el } from "./dom.js";
import { generation, isCurrent } from "./session.js";

const $ = (id) => document.getElementById(id);
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

export const hideIdeas = () => ($("ideas").hidden = true);

/**
 * Wires "Suggest ideas": personalised ideas from the event's own profile, each saying why it fits.
 * @param {string} eventId The event.
 */
export function setUpIdeas(eventId) {
  const button = $("ideas-get");
  button.onclick = async () => {
    announce("");
    const started = generation();
    button.disabled = true;
    button.textContent = "Thinking…";
    try {
      const { ideas, rationale, offline } = await api.ideas(eventId);
      if (!isCurrent(started)) return;
      const list = $("ideas-list");
      clear(list);
      list.append(...ideas.map(ideaCard));
      if (ideas.length === 0)
        list.append(el("li", { text: "No ideas came back that fit. Please try again." }));
      $("ideas-offline").hidden = !offline;
      $("ideas-rationale").textContent = rationale;
      $("ideas").hidden = false;
      $("ideas").focus();
    } catch (err) {
      announce(err.message);
    } finally {
      button.disabled = false;
      button.textContent = "Suggest ideas for this event";
    }
  };
  $("ideas-close").onclick = () => {
    hideIdeas();
    button.focus();
  };
}
