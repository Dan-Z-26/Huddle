/**
 * The hiring parts of the Vendors page: the board, the brief and its approval, and what follows a
 * booking. Everything shown comes from the server's view of this person's categories.
 */
import { api } from "../shared/api.js";
import {
  $,
  announce,
  announceError,
  clear,
  copyText,
  drawBriefDoc,
  el,
  keepFocus,
} from "../shared/dom.js";
import { drawBooked } from "./bookedVendor.js";

const STATUS = {
  draft: "Draft",
  pending: "Pending approval",
  changes: "Changes requested",
  approved: "Approved",
};
const AUTO_STEPS = new Set(["brief", "quotes", "shortlist"]);
const ANSWERS = ["scope", "deliverables", "dates", "mustHaves", "judging"];
const answerInput = (key) => $(`brief-${key.toLowerCase()}`);

function stepNote(step) {
  if (step.taskId || step.done) return "";
  return AUTO_STEPS.has(step.key) ? "ticks itself" : "after booking";
}

// Runs an action behind a busy button, then redraws the page.
async function runAction(onChanged, button, busy, work, done) {
  const label = button.textContent;
  button.disabled = true;
  button.textContent = busy;
  try {
    await work();
    // Back to its own words first: the redraw may give it new ones.
    button.textContent = label;
    await onChanged();
    if (done) announce(done);
  } catch (err) {
    button.textContent = label;
    announceError(err.message);
  } finally {
    button.disabled = false;
    // A button that hides itself or was disabled can't keep focus, so it moves somewhere sensible.
    if (document.activeElement === document.body)
      (button.offsetParent ? button : $("vendors-title")).focus();
  }
}

function boardRow(row, stages, page) {
  const at = stages.findIndex(({ id }) => id === row.stage);
  return el(
    "li",
    {},
    el(
      "button",
      {
        type: "button",
        class: "board-row",
        "aria-current": String(row.categoryId === page.category()),
        onclick: () => page.onSelect(row.categoryId),
      },
      el("strong", { text: row.name }),
      el("span", { class: "board-stage", text: stages[at].label }),
      el(
        "span",
        { class: "board-steps", "aria-hidden": "true" },
        ...stages.map((_, index) => el("span", { class: index <= at ? "is-on" : "" })),
      ),
      el("span", { class: "sr-only", text: `, step ${at + 1} of ${stages.length}` }),
    ),
  );
}

function drawBoard(rows, stages, page) {
  $("hiring-board-box").hidden = !page.isManager;
  const list = $("hiring-board");
  clear(list);
  list.append(...rows.map((row) => boardRow(row, stages, page)));
}

function drawBriefAnswers(brief, editable) {
  $("brief-form").hidden = !editable;
  for (const key of ANSWERS) {
    const input = answerInput(key);
    if (document.activeElement !== input) input.value = brief?.answers?.[key] ?? "";
  }
  $("brief-draft").textContent = brief ? "Redraft with these answers" : "Draft the brief";
}

function drawBriefResult(brief, editable) {
  $("brief-result").hidden = !brief;
  drawBriefDoc($("brief-text"), brief?.text ?? "");
  $("brief-send").hidden = !brief || !editable;
  $("brief-export").hidden = !brief;
  if (brief) $("brief-export").href = `/api/briefs/${encodeURIComponent(brief.id)}/export`;
}

function drawBriefStage(status, isManager) {
  $("brief-decide").hidden = !(isManager && status === "pending");
  $("brief-waiting").hidden = isManager || status !== "pending";
  $("rfq-step").hidden = status !== "approved";
  $("quote-locked").hidden = status === "approved";
  $("quote-form").hidden = status !== "approved";
}

function drawBrief({ brief }, isManager) {
  $("brief-status").textContent = brief ? STATUS[brief.status] : "Not started";
  $("brief-note").textContent = brief?.note ? `The event manager asked: ${brief.note}` : "";
  const editable = !brief || brief.status === "draft" || brief.status === "changes";
  drawBriefAnswers(brief, editable);
  drawBriefResult(brief, editable);
  drawBriefStage(brief?.status, isManager);
}

async function tickStep(e, step, onChanged) {
  try {
    await api.setTask(step.taskId, e.target.checked ? "done" : "todo");
    await onChanged();
    announce(`${step.label} ${e.target.checked ? "done" : "not done"}.`);
  } catch (err) {
    e.target.checked = !e.target.checked;
    announceError(err.message);
  }
}

function checklistItem(step, categoryId, onChanged) {
  const note = stepNote(step);
  return el(
    "li",
    {},
    el(
      "label",
      { class: "check" },
      el("input", {
        type: "checkbox",
        checked: step.done,
        disabled: !step.taskId,
        "data-focus-key": `step:${categoryId}:${step.key}`,
        onchange: (e) => tickStep(e, step, onChanged),
      }),
      step.label,
      note ? el("small", { class: "muted", text: `(${note})` }) : null,
    ),
  );
}

function drawChecklist(row, onChanged) {
  keepFocus(() => {
    const list = $("hire-checklist");
    clear(list);
    list.append(...row.checklist.map((step) => checklistItem(step, row.categoryId, onChanged)));
  });
}

function typedAnswers() {
  return Object.fromEntries(
    ANSWERS.map((key) => [key, answerInput(key).value.trim()]).filter(([, value]) => value),
  );
}

async function refresh(page) {
  const { rows, stages } = await api.hiring(page.event.id);
  page.current = rows.find(({ categoryId }) => categoryId === page.category()) ?? rows[0];
  drawBoard(rows, stages, page);
  drawBrief(page.current, page.isManager);
  drawChecklist(page.current, page.onChanged);
  drawBooked(page.current, page.act);
  return page.current;
}

function wireBriefButtons(page) {
  const briefId = () => page.current.brief.id;
  $("brief-form").onsubmit = (e) => {
    e.preventDefault();
    page.act(
      $("brief-draft"),
      "Drafting…",
      () => api.createBrief(page.event.id, page.category(), typedAnswers()),
      "Brief drafted.",
    );
  };
  $("brief-send").onclick = (e) =>
    page.act(e.target, "Sending…", () => api.sendBrief(briefId()), "Sent to Core team.");
  $("brief-approve").onclick = (e) =>
    page.act(
      e.target,
      "Approving…",
      () => api.decideBrief(briefId(), { approve: true }),
      "Brief approved.",
    );
  $("brief-changes").onclick = (e) => {
    const note = $("brief-change-note").value.trim();
    page.act(
      e.target,
      "Sending…",
      () => api.decideBrief(briefId(), { approve: false, ...(note ? { note } : {}) }),
      "Changes requested.",
    );
  };
  $("brief-copy").onclick = () => copyText(page.current.brief.text);
}

/**
 * Wires the hiring parts of the Vendors page.
 * @param {{event: object, isManager: boolean, category: () => string,
 *   onSelect: (categoryId: string) => void, onChanged: () => Promise<void>}} context The event, who
 *   is looking, the chosen category, how to choose one, and how to redraw the page.
 * @returns {{refresh: () => Promise<object>}} Draws the page and returns the chosen category's row.
 */
export function setUpHiring(context) {
  const page = {
    ...context,
    current: null,
    act: (...action) => runAction(context.onChanged, ...action),
  };
  wireBriefButtons(page);
  return { refresh: () => refresh(page) };
}
