import { colorOf } from "./budgetChart.js";
import { el } from "./dom.js";

function cutTags(cut, mustHaveText) {
  const tags = [];
  if (cut.removedEntirely)
    tags.push(el("span", { class: "tag warn", text: "Removes it entirely" }));
  else if (cut.tierBefore && cut.tierBefore.id !== cut.tierAfter?.id)
    tags.push(
      el("span", {
        class: "tag note",
        text: `${cut.tierBefore.label} to ${cut.tierAfter?.label ?? "below the lowest level"}`,
      }),
    );
  else tags.push(el("span", { class: "tag", text: "Keeps its current level" }));
  for (const id of cut.mustHaveConflicts)
    tags.push(el("span", { class: "tag warn", text: `Touches must-have: ${mustHaveText(id)}` }));
  if (!cut.coversShortfall)
    tags.push(el("span", { class: "tag note", text: "Can't cover the whole gap alone" }));
  return tags;
}

/**
 * A card for cutting one category to close a budget gap.
 * @param {object} option The option from the server.
 * @param {{nameOf: (id: string) => string, mustHaveText: (id: string) => string, note?: string}}
 *   context Names, and the AI's note on what guests would notice.
 * @param {() => void} onToggle Called when it is chosen or unchosen.
 * @returns {HTMLElement} The card; its state and figures are filled in by the caller.
 */
export function optionCard(option, { nameOf, mustHaveText, note }, onToggle) {
  const { categoryId, rank, atHigh, atLow } = option;
  const card = el(
    "button",
    { type: "button", class: "option", "aria-pressed": "false", onclick: onToggle },
    el(
      "span",
      { class: "option-head" },
      el("span", { class: "option-dot", "aria-hidden": "true" }),
      nameOf(categoryId),
      rank ? el("small", { class: "muted", text: `priority ${rank}` }) : null,
      el("span", { class: "option-state" }),
    ),
    el("span", { class: "option-figures" }),
    el("span", { class: "option-bar", "aria-hidden": "true" }, el("span")),
    ...cutTags(atHigh ?? atLow, mustHaveText),
    note ? el("span", { class: "option-note", text: note }) : null,
  );
  card.dataset.id = categoryId;
  card.style.setProperty("--dot", colorOf(categoryId));
  return card;
}

/**
 * A card with no category behind it, such as raising the budget.
 * @param {string} id Its id in the choice.
 * @param {string} title What it does.
 * @param {() => void} onToggle Called when it is chosen or unchosen.
 * @returns {HTMLElement} The card.
 */
export function plainCard(id, title, onToggle) {
  const card = el(
    "button",
    { type: "button", class: "option", "aria-pressed": "false", onclick: onToggle },
    el(
      "span",
      { class: "option-head" },
      el("span", { class: "option-dot", "aria-hidden": "true" }),
      title,
      el("span", { class: "option-state" }),
    ),
    el("span", { class: "option-figures" }),
  );
  card.dataset.id = id;
  return card;
}
