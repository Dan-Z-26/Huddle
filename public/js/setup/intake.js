/**
 * Event setup. It opens by asking what the event is about, which the AI reads for anything else it
 * mentions; then only what is missing is asked, one at a time, with buttons wherever they can do the
 * job. A text box appears only where typing is needed.
 */
import { api } from "../shared/api.js";
import { $, announce, announceError, clear, el } from "../shared/dom.js";
import { EXAMPLES, FIELD_META, FIELD_ORDER, OPENING } from "./fields.js";
import { collect, resetInputs, showInput, showTextBox } from "./intakeInputs.js";
import { createPicker } from "./rankPicker.js";

const isBlank = ({ name, purpose, date, city }) => !name && !purpose && !date && !city;
function countText(remaining) {
  if (remaining === 1) return "Last question";
  return `${remaining} left, mostly one tap`;
}

function setBusy(flow, on) {
  flow.busy = on;
  $("intake-send").disabled = on;
  $("intake-send").textContent = on ? "Thinking…" : "Continue";
  for (const button of document.querySelectorAll("#intake-options button")) button.disabled = on;
}

async function submit(flow, value, mode) {
  if (flow.busy) return;
  announce("");
  setBusy(flow, true);
  try {
    show(flow, await api.intake(flow.event.id, value, mode));
  } catch (err) {
    announceError(err.message);
  }
  setBusy(flow, false);
  focusStep(flow);
}

function tapChoice(e, option, meta, flow) {
  if (meta.kind !== "multi") {
    submit(flow, option, "direct");
    return;
  }
  const on = !flow.chosen.has(option);
  if (on) flow.chosen.add(option);
  else flow.chosen.delete(option);
  e.target.setAttribute("aria-pressed", String(on));
}

function drawChoices(options, meta, flow) {
  const box = $("intake-options");
  clear(box);
  for (const option of options)
    box.append(
      el("button", {
        type: "button",
        class: "choice",
        text: option,
        ...(meta.kind === "multi" ? { "aria-pressed": "false" } : {}),
        onclick: (e) => tapChoice(e, option, meta, flow),
      }),
    );
}

function setProgress(step) {
  const total = FIELD_ORDER.length;
  $("intake-progress").max = total;
  $("intake-progress").value = total - step.remaining;
  $("intake-count").textContent = step.complete ? "All done" : countText(step.remaining);
}

function showOpening(flow) {
  flow.current = { field: "opening", meta: { kind: "opening" } };
  resetInputs(flow);
  $("intake-title").textContent = OPENING.title;
  $("intake-count").textContent = "";
  $("intake-question").textContent = OPENING.question;
  $("intake-hint").textContent = OPENING.hint;
  $("intake-feedback").textContent = "";
  $("intake-heard").textContent = "";
  $("intake-form").hidden = false;
  $("intake-done").hidden = true;
  showTextBox({ long: true, placeholder: EXAMPLES[flow.event.eventType] });
}

function drawStepText(step, meta) {
  const { complete } = step;
  $("intake-title").textContent = complete ? "All set" : meta.title;
  $("intake-question").textContent = complete ? "That's everything I need." : step.nextQuestion;
  $("intake-feedback").textContent = step.feedback ?? "";
  const heard = (step.heard ?? []).map((field) => FIELD_META[field]?.title).filter(Boolean);
  $("intake-heard").textContent = heard.length ? `Got it: ${heard.join(", ")}.` : "";
  $("intake-hint").textContent = complete ? "" : (meta.hint ?? "");
  $("intake-form").hidden = complete;
  $("intake-done").hidden = !complete;
}

function show(flow, step) {
  flow.onProfile(step.profile);
  setProgress(step);
  resetInputs(flow);
  const meta = FIELD_META[step.field] ?? {};
  flow.current = { ...step, meta };
  drawStepText(step, meta);
  if (step.complete) return;
  const options = step.options ?? [];
  drawChoices(options, meta, flow);
  $("intake-skip").hidden = !meta.skippable;
  showInput(meta, options, flow.picker);
}

function focusStep(flow) {
  const { meta, complete } = flow.current;
  const spoken = [
    $("intake-heard").textContent,
    $("intake-feedback").textContent,
    $("intake-question").textContent,
    $("intake-hint").textContent,
  ];
  if (complete) $("intake-confirm").focus();
  else if (meta.kind === "date") $("intake-date").focus();
  else if (meta.kind === "rank") $("picker-list").querySelector("button").focus();
  else
    ($("intake-options").querySelector("button") ?? $("intake-answer")).focus({
      preventScroll: true,
    });
  // Moving focus reads the control, not the question; this says the rest.
  $("intake-live").textContent = spoken.filter(Boolean).join(" ");
}

function wireControls(flow) {
  $("intake-form").onsubmit = (e) => {
    e.preventDefault();
    const [value, modeOrError] = collect(flow);
    if (value === null) {
      $("intake-feedback").textContent = modeOrError;
      $("intake-live").textContent = modeOrError;
      return;
    }
    submit(flow, value, modeOrError);
  };
  $("intake-answer").onkeydown = (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      $("intake-form").requestSubmit();
    }
  };
  // Clicking anywhere on the field opens the calendar, not just on its small icon.
  $("intake-date").onclick = () => $("intake-date").showPicker?.();
  $("intake-other").onclick = () => showTextBox(flow.current.meta, { focusIt: true });
  $("intake-skip").onclick = () => submit(flow, "skip", "direct");
  $("intake-confirm").onclick = async () => {
    try {
      await api.confirmIntake(flow.event.id);
      await flow.onConfirmed();
    } catch (err) {
      announceError(err.message);
    }
  };
}

/**
 * Runs event setup.
 * @param {object} event The event.
 * @param {object} template Its event type's template.
 * @param {{onProfile: (profile: object) => void, onConfirmed: () => Promise<void>, focus?: boolean}}
 *   hooks Called after each answer, and once the workspace is created. `focus` moves focus into the
 *   first question, for when the person has just asked to start; otherwise the page opens without
 *   taking focus.
 * @returns {Promise<void>} Resolves once the first question is showing.
 */
export async function startIntake(event, template, { onProfile, onConfirmed, focus = false }) {
  const flow = {
    event,
    onProfile,
    onConfirmed,
    picker: createPicker(template.categories, (text) => {
      $("intake-live").textContent = text;
    }),
    chosen: new Set(),
    busy: false,
    current: null,
  };
  wireControls(flow);
  try {
    const first = await api.intake(event.id);
    onProfile(first.profile);
    if (isBlank(first.profile)) showOpening(flow);
    else show(flow, first);
    if (focus) focusStep(flow);
  } catch (err) {
    announceError(err.message);
  }
}
