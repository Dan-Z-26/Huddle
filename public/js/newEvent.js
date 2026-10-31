import { api } from "./api.js";
import { announceError, el } from "./dom.js";

const TYPE_ABOUT = {
  corporate_launch: "Product launches, conferences and company events",
  wedding: "Ceremonies, receptions and family functions",
  birthday: "Milestone birthdays and celebrations",
  community: "Festivals, fundraisers and neighbourhood gatherings",
};

/**
 * Wires "Start a new event": choose the event type, then setup begins.
 * @param {(options: {focusIntake: boolean}) => Promise<void>} load Redraws the workspace.
 */
export function setUpNewEvent(load) {
  const dialog = document.getElementById("new-event-dialog");
  const list = dialog.querySelector(".type-list");
  const open = async () => {
    let eventTypes;
    try {
      ({ eventTypes } = await api.eventTypes());
    } catch (err) {
      announceError(err.message);
      return;
    }
    list.replaceChildren(list.querySelector("legend"));
    eventTypes.forEach(({ eventType, label }, i) => {
      list.append(
        el(
          "label",
          { class: "type-option" },
          el("input", { type: "radio", name: "eventType", value: eventType, checked: i === 0 }),
          el("span", { text: label }),
          el("small", { text: TYPE_ABOUT[eventType] ?? "" }),
        ),
      );
    });
    dialog.showModal();
  };
  document.getElementById("new-event").onclick = open;
  document.getElementById("signin-new").onclick = open;
  document.getElementById("new-event-cancel").onclick = () => dialog.close();
  document.getElementById("new-event-form").onsubmit = async (e) => {
    e.preventDefault();
    const chosen = dialog.querySelector("input[name=eventType]:checked");
    dialog.close();
    try {
      await api.createEvent(chosen.value);
      await load({ focusIntake: true });
    } catch (err) {
      announceError(err.message);
    }
  };
}
