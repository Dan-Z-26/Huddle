import { api } from "./api.js";
import { announce, clear, el, formatShortDate } from "./dom.js";

const SVG_NS = "http://www.w3.org/2000/svg";

function renderStrip(tasks) {
  const strip = document.getElementById("timeline-strip");
  clear(strip);
  for (const task of tasks.filter(({ status }) => status === "todo").slice(0, 3)) {
    strip.append(
      el(
        "li",
        {},
        el("time", { datetime: task.dueDate, text: formatShortDate(task.dueDate) }),
        ` ${task.title}`,
        task.atRisk ? el("strong", { text: " At risk" }) : null,
      ),
    );
  }
}

// One curve of the strand. Curves alternate left and right, so the thread winds down the page.
function thread(index) {
  const node = document.createElementNS(SVG_NS, "svg");
  node.setAttribute("class", "strand-thread");
  node.setAttribute("viewBox", "0 0 48 100");
  node.setAttribute("preserveAspectRatio", "none");
  node.setAttribute("aria-hidden", "true");
  const path = document.createElementNS(SVG_NS, "path");
  const bend = index % 2 === 0 ? 46 : 2;
  path.setAttribute("d", `M24 0C${bend} 30 ${bend} 70 24 100`);
  node.append(path);
  return node;
}

/** Draws the timeline as a winding strand, with a bead to tick for each task, and the pinned strip. */
export function renderTimeline(tasks) {
  renderStrip(tasks);
  const list = document.getElementById("timeline-list");
  clear(list);
  tasks.forEach((task, index) => {
    const done = task.status === "done";
    const bead = el("input", { type: "checkbox", class: "bead", checked: done });
    bead.dataset.task = task.id;
    bead.addEventListener("change", async () => {
      try {
        const status = bead.checked ? "done" : "todo";
        renderTimeline((await api.setTask(task.id, status)).tasks);
        // The list was redrawn, so put focus back on this task's bead.
        list.querySelector(`[data-task="${CSS.escape(task.id)}"]`)?.focus();
        announce(`${task.title} marked ${status === "done" ? "done" : "not done"}.`);
      } catch (err) {
        bead.checked = !bead.checked;
        announce(err.message);
      }
    });
    const about = [formatShortDate(task.dueDate), task.ownerGroupName].filter(Boolean).join(", ");
    const classes = ["strand-item"];
    if (done) classes.push("is-done");
    if (task.atRisk) classes.push("at-risk");
    if (index === tasks.length - 1) classes.push("is-final");
    list.append(
      el(
        "li",
        { class: classes.join(" ") },
        thread(index),
        el(
          "label",
          {},
          bead,
          el(
            "span",
            { class: "strand-text" },
            el("span", { class: "strand-title", text: task.title }),
            el("span", { class: "strand-about", text: about }),
            task.atRisk ? el("strong", { class: "risk", text: "At risk" }) : null,
          ),
        ),
      ),
    );
  });
}
