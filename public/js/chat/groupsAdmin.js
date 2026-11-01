/** The manager's "Manage groups" dialog: rename, choose who is in each, remove, or add one. */
import { api } from "../shared/api.js";
import { $, clear, el } from "../shared/dom.js";

const MAX_NAME = "30";
// Called again after every reload, so an open dialog redraws from the latest groups.
let admin = null;

// Messages go inside the dialog: the rest of the page is inert while it is open.
const say = (text) => ($("groups-status").textContent = text);

const checkedValues = (box) => [...box.querySelectorAll("input:checked")].map(({ value }) => value);

function roleBoxes(chosen, name) {
  return admin.choosable.map((role) =>
    el(
      "label",
      { class: "check" },
      el("input", { type: "checkbox", name, value: role.id, checked: chosen.includes(role.id) }),
      role.name,
    ),
  );
}

async function run(work, done) {
  say("");
  try {
    await work();
    await admin.onChanged();
    render();
    say(done);
    $("groups-title").focus();
  } catch (err) {
    say(err.message);
  }
}

// Removing takes two presses, because a group's messages go with it.
function removeButton(group) {
  const label = `Remove ${group.name}`;
  let armed = false;
  const button = el("button", {
    type: "button",
    class: "button",
    text: "Remove",
    "aria-label": label,
    onblur: () => {
      armed = false;
      button.textContent = "Remove";
      button.setAttribute("aria-label", label);
    },
    onclick: () => {
      if (armed) {
        run(() => api.deleteGroup(group.id), `${group.name} removed.`);
        return;
      }
      armed = true;
      button.textContent = `Click again to remove ${group.name} and its messages`;
      button.removeAttribute("aria-label");
      say(`Press Remove again to delete ${group.name} and its messages.`);
    },
  });
  return button;
}

function adminRow(group) {
  const everyone = group.kind === "announcements";
  const name = el("input", {
    type: "text",
    maxlength: MAX_NAME,
    value: group.name,
    "aria-label": `Name of ${group.name}`,
  });
  const boxes = el(
    "fieldset",
    { class: "musts" },
    el("legend", { text: `Who is in ${group.name}` }),
    ...(everyone
      ? [el("p", { class: "muted", text: "Everyone is always in this group." })]
      : roleBoxes(group.memberRoleIds, group.id)),
  );
  const save = el("button", {
    type: "button",
    class: "button primary",
    text: "Save",
    onclick: () =>
      run(
        () =>
          api.patchGroup(group.id, {
            name: name.value,
            ...(everyone ? {} : { memberRoleIds: checkedValues(boxes) }),
          }),
        `${group.name} saved.`,
      ),
  });
  const mustStay = everyone || group.slug === "core-team";
  return el(
    "li",
    { class: "admin-row" },
    el("label", { class: "admin-name" }, "Name", name),
    boxes,
    el("div", { class: "admin-actions" }, save, mustStay ? null : removeButton(group)),
  );
}

function render() {
  const list = $("groups-admin");
  clear(list);
  list.append(...admin.groups.map(adminRow));
  $("group-new-people").replaceChildren(
    el("legend", { text: "Who is in it?" }),
    ...roleBoxes([], "new"),
  );
  $("group-new-error").textContent = "";
}

async function addGroup(e) {
  e.preventDefault();
  try {
    await api.createGroup(admin.event.id, {
      name: $("group-new-name").value,
      memberRoleIds: checkedValues($("group-new-people")),
    });
    $("group-new-name").value = "";
    await admin.onChanged();
    render();
    say("Group added.");
  } catch (err) {
    $("group-new-error").textContent = err.message;
    $("group-new-name").setAttribute("aria-describedby", "group-new-error");
    $("group-new-name").focus();
  }
}

/**
 * Wires the dialog.
 * @param {{event: object, groups: object[], roles: Array<{id: string, name: string, kind: string}>,
 *   onChanged: () => Promise<void>}} context The event, its groups, the roles that can be chosen
 *   (the manager and AI members are always in), and what to do after a change.
 */
export function setUpGroupsAdmin(context) {
  admin = { ...context, choosable: context.roles.filter(({ kind }) => kind === "core") };
  const dialog = $("groups-dialog");
  if (dialog.open) render();
  $("manage-groups").hidden = false;
  $("manage-groups").onclick = () => {
    render();
    dialog.showModal();
  };
  $("groups-close").onclick = () => dialog.close();
  $("group-new").onsubmit = addGroup;
}
