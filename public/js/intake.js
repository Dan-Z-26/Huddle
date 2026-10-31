import { api } from "./api.js";
import { announce, clear, el } from "./dom.js";
import { FIELD_META, FIELD_ORDER } from "./fields.js";

const $ = (id) => document.getElementById(id);

/**
 * Runs the intake as one question at a time: a progress bar, the question, quick replies where
 * they help, and a ranking picker for priorities. Calls `onProfile` after each answer and
 * `onConfirmed` once the workspace is created. `focus` moves focus into the first question, for
 * when the person has just asked to start; otherwise the page opens without taking focus.
 */
export async function startIntake(event, template, { onProfile, onConfirmed, focus = false }) {
  const answer = $("intake-answer");
  const send = $("intake-send");
  let ranked = [];
  let busy = false;

  const sendAnswer = async (text) => {
    const value = text.trim();
    if (busy) return;
    if (!value) {
      announce("Please type an answer first.");
      return;
    }
    announce("");
    busy = true;
    send.disabled = true;
    send.textContent = "Thinking…";
    try {
      show(await api.intake(event.id, value));
    } catch (err) {
      announce(err.message);
    } finally {
      busy = false;
      send.disabled = false;
      send.textContent = "Continue";
    }
  };

  function quickReplies(step, meta) {
    const chips = [];
    const { guests } = step.profile;
    if (step.field === "guests" && guests.suggested > 0 && guests.confirmed === null)
      chips.push([`Yes, plan for ${guests.suggested}`, "yes"]);
    if (meta.chipsFromMustHaves)
      for (const { text } of step.profile.mustHaves) chips.push([text, text]);
    if (meta.skippable) chips.push(["Skip for now", "skip"]);
    return chips;
  }

  function renderPicker() {
    const list = $("picker-list");
    clear(list);
    for (const { id, name } of template.categories) {
      const position = ranked.indexOf(id) + 1;
      list.append(
        el(
          "li",
          {},
          el(
            "button",
            {
              type: "button",
              "aria-pressed": String(position > 0),
              "data-id": id,
              onclick: () => {
                ranked = position ? ranked.filter((item) => item !== id) : [...ranked, id];
                renderPicker();
                answer.value = ranked
                  .map((item) => template.categories.find((c) => c.id === item).name)
                  .join(", ");
                // The buttons were redrawn, so put focus back and say what changed.
                list.querySelector(`[data-id="${CSS.escape(id)}"]`).focus();
                $("intake-live").textContent = position
                  ? `${name} removed`
                  : `${name}, rank ${ranked.length}`;
              },
            },
            el("span", { class: "rank", "aria-hidden": "true", text: position || "" }),
            name,
            position ? el("span", { class: "sr-only", text: ` (rank ${position})` }) : null,
          ),
        ),
      );
    }
  }

  function show(step, moveFocus = true) {
    const wasFocused = document.activeElement === answer;
    onProfile(step.profile);
    const index = step.complete ? FIELD_ORDER.length : FIELD_ORDER.indexOf(step.field);
    const meta = FIELD_META[step.field] ?? {};
    $("intake-progress").max = FIELD_ORDER.length;
    $("intake-progress").value = index;
    $("intake-title").textContent = step.complete ? "All set" : meta.title;
    $("intake-count").textContent = step.complete
      ? `${FIELD_ORDER.length} of ${FIELD_ORDER.length}`
      : `Question ${index + 1} of ${FIELD_ORDER.length}`;
    $("intake-question").textContent = step.complete
      ? "That's everything I need."
      : step.nextQuestion;
    $("intake-feedback").textContent = step.feedback ?? "";
    $("intake-hint").textContent = step.complete ? "" : (meta.hint ?? "");
    $("intake-form").hidden = step.complete;
    $("intake-done").hidden = !step.complete;

    ranked = [];
    $("intake-picker").hidden = !meta.picker;
    if (meta.picker) renderPicker();

    const chips = $("intake-chips");
    clear(chips);
    for (const [label, reply] of step.complete ? [] : quickReplies(step, meta)) {
      chips.append(
        el("button", {
          type: "button",
          class: "chip",
          onclick: () => sendAnswer(reply),
          text: label,
        }),
      );
    }
    answer.value = "";
    answer.placeholder = meta.placeholder ?? "";
    answer.rows = meta.long ? 4 : 2;
    if (!moveFocus) return;
    const spoken = [step.feedback, $("intake-question").textContent, $("intake-hint").textContent];
    if (step.complete) $("intake-confirm").focus();
    else if (meta.picker) $("picker-list").querySelector("button").focus();
    else answer.focus();
    // Moving focus already reads the labelled field; otherwise nothing would be said.
    if (wasFocused || step.complete || meta.picker)
      $("intake-live").textContent = spoken.filter(Boolean).join(" ");
  }

  $("intake-form").onsubmit = (e) => {
    e.preventDefault();
    sendAnswer(answer.value);
  };
  answer.onkeydown = (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      $("intake-form").requestSubmit();
    }
  };
  $("intake-confirm").onclick = async () => {
    try {
      await api.confirmIntake(event.id);
      await onConfirmed();
    } catch (err) {
      announce(err.message);
    }
  };

  try {
    show(await api.intake(event.id), focus);
  } catch (err) {
    announce(err.message);
  }
}
