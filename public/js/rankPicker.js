import { clear, el } from "./dom.js";

/**
 * The tap-in-order ranking used in setup.
 * @param {Array<{id: string, name: string}>} categories What can be ranked.
 * @param {(text: string) => void} say Announces each change.
 * @returns {{draw: () => void, reset: () => void, ranked: () => string[]}} The picker.
 */
export function createPicker(categories, say) {
  let ranked = [];

  function draw() {
    const list = document.getElementById("picker-list");
    clear(list);
    for (const { id, name } of categories) {
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
                draw();
                // The buttons were redrawn, so put focus back and say what changed.
                list.querySelector(`[data-id="${CSS.escape(id)}"]`).focus();
                say(position ? `${name} removed` : `${name}, rank ${ranked.length}`);
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

  return {
    draw,
    reset: () => {
      ranked = [];
    },
    ranked: () => ranked,
  };
}
