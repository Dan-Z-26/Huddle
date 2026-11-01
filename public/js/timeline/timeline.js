/** The timeline: the flow band on every page, the full page, and the manager's tools. */
import { api } from "../shared/api.js";
import {
  $,
  announce,
  announceError,
  clear,
  el,
  formatShortDate,
  keepFocus,
  today,
} from "../shared/dom.js";
import { flowOf, groupByMonth } from "./timelineView.js";

// The groups this person is in: only they can tick a task off, and the server checks it too.
let myGroupIds = new Set();

/**
 * Sets which groups this person is in, before the timeline is drawn.
 * @param {object[]} groups Their groups.
 */
export function setTimelineGroups(groups) {
  myGroupIds = new Set(groups.map(({ id }) => id));
}

const classNames = (flags) =>
  Object.entries(flags)
    .filter(([, on]) => on)
    .map(([name]) => name)
    .join(" ");

function flowStep(step, isFinal, nextStepId) {
  const done = step.status === "done";
  const isNext = step.id === nextStepId;
  const late = !done && step.atRisk;
  const state = (done && "Done") || (isNext && "Next") || "";
  const classes = classNames({
    "flow-step": true,
    "is-done": done,
    "is-next": isNext,
    "at-risk": late,
    "is-final": isFinal,
  });
  return el(
    "li",
    { class: classes },
    el("span", { class: "flow-bead", "aria-hidden": "true" }),
    el(
      "span",
      { class: "flow-label" },
      el("time", { datetime: step.dueDate, text: formatShortDate(step.dueDate) }),
      el("span", { class: "flow-name", text: step.title }),
      late ? el("span", { class: "risk", text: "At risk" }) : null,
      state ? el("span", { class: "sr-only", text: ` (${state})` }) : null,
    ),
  );
}

function drawFlow(tasks) {
  const { steps, next, nextStepId, progress } = flowOf(tasks);
  $("flow").hidden = tasks.length === 0;
  const summary = $("flow-summary");
  clear(summary);
  if (next)
    summary.append(
      el("strong", { text: "Next: " }),
      `${next.title}, ${formatShortDate(next.dueDate)}`,
      // append() would print a null, unlike el().
      next.atRisk ? el("span", { class: "risk", text: " At risk" }) : "",
    );
  else summary.textContent = "Everything on the timeline is done.";
  $("flow-progress").textContent = progress;
  const rail = $("flow-steps");
  clear(rail);
  rail.append(
    ...steps.map((step, index) => flowStep(step, index === steps.length - 1, nextStepId)),
  );
}

async function setStatus(task, bead) {
  const status = bead.checked ? "done" : "todo";
  try {
    renderTimeline((await api.setTask(task.id, status)).tasks);
    announce(`${task.title} marked ${status === "done" ? "done" : "not done"}.`);
  } catch (err) {
    bead.checked = !bead.checked;
    announceError(err.message);
  }
}

function roadItem(task, { nextId, finalId }) {
  const done = task.status === "done";
  const mine = myGroupIds.has(task.ownerGroupId);
  const bead = el("input", {
    type: "checkbox",
    class: "bead",
    checked: done,
    disabled: !mine,
    "data-focus-key": `task:${task.id}`,
    onchange: (e) => setStatus(task, e.target),
  });
  const classes = classNames({
    "road-item": true,
    "is-done": done,
    "at-risk": task.atRisk && !done,
    "is-next": task.id === nextId,
    "is-final": task.id === finalId,
  });
  return el(
    "li",
    { class: classes },
    el("time", { class: "road-date", datetime: task.dueDate, text: formatShortDate(task.dueDate) }),
    el(
      "label",
      {},
      bead,
      el(
        "span",
        { class: "road-text" },
        el("span", { class: "road-title", text: task.title }),
        el(
          "span",
          { class: "road-about" },
          task.ownerGroupName ?? "",
          task.source === "directive" ? " (from a directive)" : "",
          mine ? "" : ", ticked off by that group",
        ),
        task.id === nextId ? el("span", { class: "tag note", text: "Next" }) : null,
        task.atRisk && !done ? el("span", { class: "tag warn", text: "At risk" }) : null,
      ),
    ),
  );
}

function drawRoad(tasks) {
  const list = $("timeline-list");
  clear(list);
  const { next, steps } = flowOf(tasks);
  const context = { nextId: next?.id, finalId: steps.at(-1)?.id };
  for (const { label, tasks: inMonth } of groupByMonth(tasks))
    list.append(
      el(
        "section",
        { class: "road-month" },
        el("h3", { text: label }),
        el("ol", { class: "road" }, ...inMonth.map((task) => roadItem(task, context))),
      ),
    );
}

/**
 * Draws the flow band shown on every page, and the full Timeline page.
 * @param {object[]} tasks The tasks, in date order.
 */
export function renderTimeline(tasks) {
  drawFlow(tasks);
  keepFocus(() => drawRoad(tasks));
}

/**
 * Wires the manager's Timeline tools: moving the event date with the calendar, and the digest.
 * @param {object} event The event.
 * @param {() => Promise<void>} reload Redraws the workspace after a change.
 */
export function setUpTimelineTools(event, reload) {
  const date = $("reschedule-date");
  date.min = today();
  date.value = event.date?.slice(0, 10) ?? "";
  $("reschedule").onsubmit = async (e) => {
    e.preventDefault();
    try {
      await api.reschedule(event.id, date.value);
      await reload();
      announce("Event date moved and timeline replanned.");
    } catch (err) {
      announceError(err.message);
    }
  };
  const digestButton = $("post-digest");
  digestButton.onclick = async () => {
    digestButton.disabled = true;
    try {
      await api.digest(event.id);
      await reload();
      announce("Digest posted in Announcements.");
    } catch (err) {
      announceError(err.message);
    } finally {
      digestButton.disabled = false;
    }
  };
}
