import { api } from "./api.js";
import { announce, announceError, el } from "./dom.js";

async function acknowledge(id) {
  try {
    await api.ack(id);
    announce("Acknowledged. Thank you.");
  } catch (err) {
    announceError(err.message);
  }
}

/**
 * Draws a directive's status: who is still pending for the manager, "Got it" for those it names.
 * @param {object} directive The directive.
 * @param {string} where Where this copy of the card is, so focus can return to the same one.
 * @param {{me: object, isManager: boolean, nameOf: (id: string) => string}} who The person looking.
 * @returns {HTMLElement} The card.
 */
export function directiveCard(directive, where, { me, isManager, nameOf }) {
  const status = directive.status;
  const mine = directive.addressedUserIds.includes(me.id);
  const acked = directive.acks.some(({ userId }) => userId === me.id);
  const card = el(
    "div",
    { class: "directive" },
    el("strong", { text: "Directive" }),
    el("span", {
      class: "directive-status",
      tabindex: "-1",
      "data-focus-after": `ack:${directive.id}:${where}`,
      text: status.label,
    }),
  );
  if (isManager && status.pending.length)
    card.append(
      el("span", { class: "muted", text: `Waiting for ${status.pending.map(nameOf).join(", ")}` }),
    );
  if (mine && !acked)
    card.append(
      el("button", {
        type: "button",
        class: "button primary small",
        text: "Got it",
        "aria-label": `Got it: ${directive.text ?? "this directive"}`.slice(0, 120),
        "data-focus-key": `ack:${directive.id}:${where}`,
        onclick: () => acknowledge(directive.id),
      }),
    );
  if (mine && acked) card.append(el("span", { class: "tag", text: "You've acknowledged this" }));
  return card;
}
