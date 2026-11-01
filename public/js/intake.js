import { api } from "./api.js";
import { announce, announceError, clear, el } from "./dom.js";
import { EXAMPLES, FIELD_META, FIELD_ORDER, OPENING } from "./fields.js";
import { createPicker } from "./rankPicker.js";

const $ = (id) => document.getElementById(id);
const isBlank = ({ name, purpose, date, city }) => !name && !purpose && !date && !city;
const toItems = (text) =>
  text
    .split(/[,;\n]/)
    .map((item) => item.trim())
    .filter(Boolean);

function countText(remaining) {
  if (remaining === 1) return "Last question";
  return `${remaining} left, mostly one tap`;
}

/**
 * Runs event setup. It opens by asking what the event is about, which the AI reads for anything
 * else it mentions; then only what is missing is asked, one at a time, with buttons wherever they
 * can do the job. A text box appears only where typing is needed. Calls `onProfile` after each answer and
 * `onConfirmed` once the workspace is created. `focus` moves focus into the first question, for
 * when the person has just asked to start; otherwise the page opens without taking focus.
 */
export async function startIntake(event, template, { onProfile, onConfirmed, focus = false }) {
  const answer = $("intake-answer");
  const date = $("intake-date");
  const send = $("intake-send");
  const picker = createPicker(template.categories, (text) => {
    $("intake-live").textContent = text;
  });
  let chosen = new Set();
  let busy = false;
  let current = null;

  const setBusy = (on) => {
    busy = on;
    send.disabled = on;
    send.textContent = on ? "Thinking…" : "Continue";
    for (const button of document.querySelectorAll("#intake-options button")) button.disabled = on;
  };

  const submit = async (value, mode) => {
    if (busy) return;
    announce("");
    setBusy(true);
    try {
      show(await api.intake(event.id, value, mode));
    } catch (err) {
      announceError(err.message);
      setBusy(false);
      focusStep();
      return;
    }
    setBusy(false);
    focusStep();
  };

  function showTextBox(meta, { focusIt = false } = {}) {
    $("intake-text-wrap").hidden = false;
    $("intake-other").hidden = true;
    answer.rows = meta.long ? 3 : 1;
    answer.placeholder = meta.placeholder ?? meta.typed ?? "";
    send.hidden = false;
    if (focusIt) answer.focus();
  }

  function drawChoices(options, meta) {
    const box = $("intake-options");
    clear(box);
    for (const option of options) {
      const pressed = meta.kind === "multi" ? { "aria-pressed": "false" } : {};
      box.append(
        el("button", {
          type: "button",
          class: "choice",
          text: option,
          ...pressed,
          onclick: (e) => {
            if (meta.kind !== "multi") return submit(option, "direct");
            const on = !chosen.has(option);
            if (on) chosen.add(option);
            else chosen.delete(option);
            e.target.setAttribute("aria-pressed", String(on));
            return null;
          },
        }),
      );
    }
  }

  function setProgress(step) {
    const total = FIELD_ORDER.length;
    $("intake-progress").max = total;
    $("intake-progress").value = total - step.remaining;
    $("intake-count").textContent = step.complete ? "All done" : countText(step.remaining);
  }

  function resetInputs() {
    answer.value = "";
    date.value = "";
    picker.reset();
    chosen = new Set();
    clear($("intake-options"));
    for (const id of [
      "intake-text-wrap",
      "intake-date-wrap",
      "intake-picker",
      "intake-other",
      "intake-skip",
    ])
      $(id).hidden = true;
    send.hidden = true;
  }

  function showOpening() {
    current = { field: "opening", meta: { kind: "opening" } };
    resetInputs();
    $("intake-title").textContent = OPENING.title;
    $("intake-count").textContent = "";
    $("intake-question").textContent = OPENING.question;
    $("intake-hint").textContent = OPENING.hint;
    $("intake-feedback").textContent = "";
    $("intake-heard").textContent = "";
    $("intake-form").hidden = false;
    $("intake-done").hidden = true;
    showTextBox({ long: true, placeholder: EXAMPLES[event.eventType] });
  }

  // Buttons wherever they can do the job; a text box only where typing is needed.
  function showInput(meta, options) {
    if (meta.kind === "date") {
      date.min = new Date().toISOString().slice(0, 10);
      $("intake-date-wrap").hidden = false;
      send.hidden = false;
    } else if (meta.kind === "rank") {
      picker.draw();
      $("intake-picker").hidden = false;
      send.hidden = false;
    } else if (meta.kind === "multi") {
      send.hidden = false;
      if (options.length === 0) showTextBox(meta);
      else $("intake-other").hidden = false;
    } else if (meta.kind === "text" || options.length === 0) {
      showTextBox(meta);
    } else if (meta.typed) {
      $("intake-other").hidden = false;
    }
  }

  function show(step) {
    onProfile(step.profile);
    setProgress(step);
    resetInputs();
    const meta = FIELD_META[step.field] ?? {};
    current = { ...step, meta };
    $("intake-title").textContent = step.complete ? "All set" : meta.title;
    $("intake-question").textContent = step.complete
      ? "That's everything I need."
      : step.nextQuestion;
    $("intake-feedback").textContent = step.feedback ?? "";
    const heard = (step.heard ?? []).map((field) => FIELD_META[field]?.title).filter(Boolean);
    $("intake-heard").textContent = heard.length ? `Got it: ${heard.join(", ")}.` : "";
    $("intake-hint").textContent = step.complete ? "" : (meta.hint ?? "");
    $("intake-form").hidden = step.complete;
    $("intake-done").hidden = !step.complete;
    if (step.complete) return;

    drawChoices(step.options ?? [], meta);
    $("intake-skip").hidden = !meta.skippable;
    showInput(meta, step.options ?? []);
  }

  function focusStep() {
    const { meta, complete } = current;
    const spoken = [
      $("intake-heard").textContent,
      $("intake-feedback").textContent,
      $("intake-question").textContent,
      $("intake-hint").textContent,
    ];
    if (complete) $("intake-confirm").focus();
    else if (meta.kind === "date") date.focus();
    else if (meta.kind === "rank") $("picker-list").querySelector("button").focus();
    else
      ($("intake-options").querySelector("button") ?? answer).focus({
        preventScroll: true,
      });
    // Moving focus reads the control, not the question; this says the rest.
    $("intake-live").textContent = spoken.filter(Boolean).join(" ");
  }

  function collect() {
    const { field, meta } = current;
    if (field === "opening") {
      const text = answer.value.trim();
      return text ? [text, "opening"] : [null, "Tell me a little about it first."];
    }
    if (meta.kind === "date")
      return date.value ? [date.value, "direct"] : [null, "Please pick a date."];
    if (meta.kind === "rank")
      return picker.ranked().length
        ? [picker.ranked().join("\n"), "direct"]
        : [null, "Tap at least one."];
    const typed = answer.value.trim();
    if (meta.kind === "multi") {
      const items = [...chosen, ...toItems(typed)];
      // Typed words go to the model, which can tell which category each belongs to.
      if (items.length) return [items.join("\n"), typed ? undefined : "direct"];
      return [null, "Tap one or more, or skip this for now."];
    }
    if (!typed) return [null, "Please type an answer first."];
    return [typed, meta.kind === "text" && meta.skippable ? undefined : "direct"];
  }

  $("intake-form").onsubmit = (e) => {
    e.preventDefault();
    const [value, modeOrError] = collect();
    if (value === null) {
      $("intake-feedback").textContent = modeOrError;
      $("intake-live").textContent = modeOrError;
      return;
    }
    submit(value, modeOrError);
  };
  answer.onkeydown = (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      $("intake-form").requestSubmit();
    }
  };
  // Clicking anywhere on the field opens the calendar, not just on its small icon.
  date.onclick = () => date.showPicker?.();
  $("intake-other").onclick = () => showTextBox(current.meta, { focusIt: true });
  $("intake-skip").onclick = () => submit("skip", "direct");
  $("intake-confirm").onclick = async () => {
    try {
      await api.confirmIntake(event.id);
      await onConfirmed();
    } catch (err) {
      announceError(err.message);
    }
  };

  try {
    const first = await api.intake(event.id);
    onProfile(first.profile);
    if (isBlank(first.profile)) showOpening();
    else show(first);
    if (focus) focusStep();
  } catch (err) {
    announceError(err.message);
  }
}
