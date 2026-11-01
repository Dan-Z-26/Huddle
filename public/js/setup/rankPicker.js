/** The tap-in-order ranking used in setup. */
import { $, clear, el } from "../shared/dom.js";

function pickerItem(id, name, position, onclick) {
  return el(
    "li",
    {},
    el(
      "button",
      { type: "button", "aria-pressed": String(position > 0), "data-id": id, onclick },
      el("span", { class: "rank", "aria-hidden": "true", text: position || "" }),
      name,
      position ? el("span", { class: "sr-only", text: ` (rank ${position})` }) : null,
    ),
  );
}

/**
 * The tap-in-order ranking used in setup.
 * @param {Array<{id: string, name: string}>} categories What can be ranked.
 * @param {(text: string) => void} say Announces each change.
 * @returns {{draw: () => void, reset: () => void, ranked: () => string[]}} The picker.
 */
export function createPicker(categories, say) {
  let ranked = [];
  const choose = (id, name, position, list) => {
    ranked = position ? ranked.filter((item) => item !== id) : [...ranked, id];
    draw();
    // The buttons were redrawn, so put focus back and say what changed.
    list.querySelector(`[data-id="${CSS.escape(id)}"]`).focus();
    say(position ? `${name} removed` : `${name}, rank ${ranked.length}`);
  };
  function draw() {
    const list = $("picker-list");
    clear(list);
    for (const { id, name } of categories)
      list.append(
        pickerItem(id, name, ranked.indexOf(id) + 1, () =>
          choose(id, name, ranked.indexOf(id) + 1, list),
        ),
      );
  }
  return {
    draw,
    reset: () => {
      ranked = [];
    },
    ranked: () => ranked,
  };
}
