import { api } from "./api.js";
import { clear, el } from "./dom.js";

const $ = (id) => document.getElementById(id);

/**
 * Opens the "pin as a directive" dialog for a message: the manager picks who should tap "Got it".
 * @param {object} message The message to pin.
 * @param {{group: object, members: object[]}} context The group on screen and the event's people.
 * @param {() => void} onPinned Called once the server has pinned it.
 */
export function openPin(message, { group, members }, onPinned) {
  const dialog = $("pin-dialog");
  $("pin-text").textContent = message.text;
  $("pin-error").textContent = "";
  const people = $("pin-people");
  clear(people);
  people.append(el("legend", { text: 'Who should tap "Got it"?' }));
  // People in this group other than the manager; roles are what the group's membership is built on.
  const inGroup = members.filter(
    (member) =>
      member.kind !== "agent" &&
      member.kind !== "manager" &&
      group.memberRoleIds.includes(member.roleId),
  );
  for (const person of inGroup)
    people.append(
      el(
        "label",
        { class: "check" },
        el("input", { type: "checkbox", value: person.id, checked: true }),
        person.name,
      ),
    );
  $("pin-cancel").onclick = () => dialog.close();
  $("pin-form").onsubmit = async (e) => {
    e.preventDefault();
    const chosen = [...people.querySelectorAll("input:checked")].map((box) => box.value);
    const button = $("pin-send");
    if (chosen.length === 0) {
      $("pin-error").textContent = "Choose at least one person.";
      return;
    }
    button.disabled = true;
    button.textContent = "Pinning…";
    try {
      await api.pinDirective(message.id, chosen);
      dialog.close();
      onPinned();
    } catch (err) {
      $("pin-error").textContent = err.message;
    } finally {
      button.disabled = false;
      button.textContent = "Pin it";
    }
  };
  dialog.showModal();
}
