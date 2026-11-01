/** The inputs a setup question can use, and reading the answer back from them. */
import { $, clear, today } from "../shared/dom.js";

const toItems = (text) =>
  text
    .split(/[,;\n]/)
    .map((item) => item.trim())
    .filter(Boolean);

/**
 * Shows the text box for a field.
 * @param {object} meta How the field is answered.
 * @param {{focusIt?: boolean}} [options] Whether to move focus into it.
 */
export function showTextBox(meta, { focusIt = false } = {}) {
  const answer = $("intake-answer");
  $("intake-text-wrap").hidden = false;
  $("intake-other").hidden = true;
  answer.rows = meta.long ? 3 : 1;
  answer.placeholder = meta.placeholder ?? meta.typed ?? "";
  $("intake-send").hidden = false;
  if (focusIt) answer.focus();
}

/**
 * Clears and hides every input, ready for the next question.
 * @param {object} flow The setup's state.
 */
export function resetInputs(flow) {
  $("intake-answer").value = "";
  $("intake-date").value = "";
  flow.picker.reset();
  flow.chosen = new Set();
  clear($("intake-options"));
  for (const id of [
    "intake-text-wrap",
    "intake-date-wrap",
    "intake-picker",
    "intake-other",
    "intake-skip",
  ])
    $(id).hidden = true;
  $("intake-send").hidden = true;
}

/**
 * Shows the right input for a field: buttons wherever they can do the job, and a text box only where
 * typing is needed.
 * @param {object} meta How the field is answered.
 * @param {string[]} options The answer buttons.
 * @param {object} picker The ranking picker.
 */
export function showInput(meta, options, picker) {
  const send = $("intake-send");
  if (meta.kind === "date") {
    $("intake-date").min = today();
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

// Each way of answering gives a value and how to send it, or null and what to ask for instead.
const COLLECTORS = {
  date: () =>
    $("intake-date").value ? [$("intake-date").value, "direct"] : [null, "Please pick a date."],
  rank: (flow) => {
    const ranked = flow.picker.ranked();
    return ranked.length ? [ranked.join("\n"), "direct"] : [null, "Tap at least one."];
  },
  multi: (flow, typed) => {
    const items = [...flow.chosen, ...toItems(typed)];
    // Typed words go to the model, which can tell which category each belongs to.
    if (items.length) return [items.join("\n"), typed ? undefined : "direct"];
    return [null, "Tap one or more, or skip this for now."];
  },
  opening: (_flow, typed) =>
    typed ? [typed, "opening"] : [null, "Tell me a little about it first."],
};

/**
 * Reads the current answer.
 * @param {object} flow The setup's state.
 * @returns {[string | null, string | undefined]} The value and how to send it, or null and what to
 *   ask for instead.
 */
export function collect(flow) {
  const { meta } = flow.current;
  const typed = $("intake-answer").value.trim();
  const collector = COLLECTORS[meta.kind];
  if (collector) return collector(flow, typed);
  if (!typed) return [null, "Please type an answer first."];
  return [typed, meta.kind === "text" && meta.skippable ? undefined : "direct"];
}
