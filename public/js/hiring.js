import { api } from "./api.js";
import { drawBooked } from "./bookedVendor.js";
import { announce, announceError, clear, copyText, el, keepFocus, drawBriefDoc } from "./dom.js";

const $ = (id) => document.getElementById(id);
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

/**
 * The hiring parts of the Vendors page: the board, the brief and its approval, and what follows a
 * booking. Everything shown comes from the server's view of this person's categories.
 * @param {{event: object, isManager: boolean, category: () => string,
 *   onSelect: (categoryId: string) => void, onChanged: () => Promise<void>}} context The event, who
 *   is looking, the chosen category, how to choose one, and how to redraw the page.
 * @returns {{refresh: () => Promise<object>}} Draws the page and returns the chosen category's row.
 */
export function setUpHiring({ event, isManager, category, onSelect, onChanged }) {
  async function act(button, busy, work, done) {
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

  function drawBoard(rows, stages) {
    $("hiring-board-box").hidden = !isManager;
    const list = $("hiring-board");
    clear(list);
    const order = stages.map(({ id }) => id);
    for (const row of rows) {
      const at = order.indexOf(row.stage);
      const label = stages[at].label;
      list.append(
        el(
          "li",
          {},
          el(
            "button",
            {
              type: "button",
              class: "board-row",
              "aria-current": String(row.categoryId === category()),
              onclick: () => onSelect(row.categoryId),
            },
            el("strong", { text: row.name }),
            el("span", { class: "board-stage", text: label }),
            el(
              "span",
              { class: "board-steps", "aria-hidden": "true" },
              ...stages.map((_, index) => el("span", { class: index <= at ? "is-on" : "" })),
            ),
            el("span", { class: "sr-only", text: `, step ${at + 1} of ${stages.length}` }),
          ),
        ),
      );
    }
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

  function drawBriefStage(status) {
    $("brief-decide").hidden = !(isManager && status === "pending");
    $("brief-waiting").hidden = isManager || status !== "pending";
    $("rfq-step").hidden = status !== "approved";
    $("quote-locked").hidden = status === "approved";
    $("quote-form").hidden = status !== "approved";
  }

  function drawBrief({ brief }) {
    $("brief-status").textContent = brief ? STATUS[brief.status] : "Not started";
    $("brief-note").textContent = brief?.note ? `The event manager asked: ${brief.note}` : "";
    const editable = !brief || brief.status === "draft" || brief.status === "changes";
    drawBriefAnswers(brief, editable);
    drawBriefResult(brief, editable);
    drawBriefStage(brief?.status);
  }

  function drawChecklist(row) {
    keepFocus(() => fillChecklist(row));
  }

  function fillChecklist(row) {
    const list = $("hire-checklist");
    clear(list);
    for (const step of row.checklist) {
      const box = el("input", {
        type: "checkbox",
        checked: step.done,
        disabled: !step.taskId,
        "data-focus-key": `step:${row.categoryId}:${step.key}`,
        onchange: async (e) => {
          try {
            await api.setTask(step.taskId, e.target.checked ? "done" : "todo");
            await onChanged();
            announce(`${step.label} ${e.target.checked ? "done" : "not done"}.`);
          } catch (err) {
            e.target.checked = !e.target.checked;
            announceError(err.message);
          }
        },
      });
      const note = stepNote(step);
      list.append(
        el(
          "li",
          {},
          el(
            "label",
            { class: "check" },
            box,
            step.label,
            note ? el("small", { class: "muted", text: `(${note})` }) : null,
          ),
        ),
      );
    }
  }

  function answers() {
    return Object.fromEntries(
      ANSWERS.map((key) => [key, answerInput(key).value.trim()]).filter(([, value]) => value),
    );
  }

  let current = null;
  async function refresh() {
    const { rows, stages } = await api.hiring(event.id);
    current = rows.find(({ categoryId }) => categoryId === category()) ?? rows[0];
    drawBoard(rows, stages);
    drawBrief(current);
    drawChecklist(current);
    drawBooked(current, act);
    return current;
  }

  $("brief-form").onsubmit = (e) => {
    e.preventDefault();
    act(
      $("brief-draft"),
      "Drafting…",
      () => api.createBrief(event.id, category(), answers()),
      "Brief drafted.",
    );
  };
  $("brief-send").onclick = (e) =>
    act(e.target, "Sending…", () => api.sendBrief(current.brief.id), "Sent to Core team.");
  $("brief-approve").onclick = (e) =>
    act(
      e.target,
      "Approving…",
      () => api.decideBrief(current.brief.id, { approve: true }),
      "Brief approved.",
    );
  $("brief-changes").onclick = (e) => {
    const note = $("brief-change-note").value.trim();
    act(
      e.target,
      "Sending…",
      () => api.decideBrief(current.brief.id, { approve: false, ...(note ? { note } : {}) }),
      "Changes requested.",
    );
  };
  $("brief-copy").onclick = () => copyText(current.brief.text);
  return { refresh };
}
