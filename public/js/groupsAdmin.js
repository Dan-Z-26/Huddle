import { api } from "./api.js";
import { clear, el } from "./dom.js";

const $ = (id) => document.getElementById(id);
let state = null;
const say = (text) => ($("groups-status").textContent = text);

function roleBoxes(roles, chosen, name) {
  return roles.map((role) =>
    el(
      "label",
      { class: "check" },
      el("input", { type: "checkbox", name, value: role.id, checked: chosen.includes(role.id) }),
      role.name,
    ),
  );
}

/**
 * The manager's "Manage groups" dialog: rename, choose who is in each group, remove, or add one.
 * @param {{event: object, groups: object[], roles: Array<{id: string, name: string, kind: string}>,
 *   onChanged: () => Promise<void>}} context The event, its groups, the roles that can be chosen
 *   (the manager and AI members are always in), and what to do after a change.
 */
export function setUpGroupsAdmin(context) {
  // Called again after every reload, so an open dialog redraws from the latest groups.
  state = context;
  const { event, roles, onChanged } = context;
  const dialog = $("groups-dialog");
  const choosable = roles.filter(({ kind }) => kind === "core");
  if (dialog.open) render();
  $("manage-groups").hidden = false;
  $("manage-groups").onclick = () => {
    render();
    dialog.showModal();
  };
  $("groups-close").onclick = () => dialog.close();

  // Messages go inside the dialog: the rest of the page is inert while it is open.
  async function run(work, done) {
    say("");
    try {
      await work();
      await onChanged();
      render();
      say(done);
      $("groups-title").focus();
    } catch (err) {
      say(err.message);
    }
  }

  function row(group) {
    const fixed = group.kind === "announcements";
    const name = el("input", {
      type: "text",
      maxlength: "30",
      value: group.name.replace(/^#/, ""),
      "aria-label": `Name of ${group.name}`,
    });
    const boxes = el(
      "fieldset",
      { class: "musts" },
      el("legend", { text: `Who is in ${group.name}` }),
      ...(fixed
        ? [el("p", { class: "muted", text: "Everyone is always in this group." })]
        : roleBoxes(choosable, group.memberRoleIds, group.id)),
    );
    let armed = false;
    const remove = el("button", {
      type: "button",
      class: "button",
      text: "Remove",
      "aria-label": `Remove ${group.name}`,
      onblur: () => {
        armed = false;
        remove.textContent = "Remove";
        remove.setAttribute("aria-label", `Remove ${group.name}`);
      },
      onclick: () => {
        if (!armed) {
          armed = true;
          remove.textContent = `Click again to remove ${group.name} and its messages`;
          remove.removeAttribute("aria-label");
          say(`Press Remove again to delete ${group.name} and its messages.`);
          return;
        }
        run(() => api.deleteGroup(group.id), `${group.name} removed.`);
      },
    });
    const save = el("button", {
      type: "button",
      class: "button primary",
      text: "Save",
      onclick: () =>
        run(
          () =>
            api.patchGroup(group.id, {
              name: name.value,
              ...(fixed
                ? {}
                : {
                    memberRoleIds: [...boxes.querySelectorAll("input:checked")].map(
                      (box) => box.value,
                    ),
                  }),
            }),
          `${group.name} saved.`,
        ),
    });
    const keep = fixed || group.slug === "core-team";
    return el(
      "li",
      { class: "admin-row" },
      el("label", { class: "admin-name" }, "Name", name),
      boxes,
      el("div", { class: "admin-actions" }, save, keep ? null : remove),
    );
  }

  function render() {
    const list = $("groups-admin");
    clear(list);
    list.append(...state.groups.map(row));
    const people = $("group-new-people");
    people.replaceChildren(
      el("legend", { text: "Who is in it?" }),
      ...roleBoxes(choosable, [], "new"),
    );
    $("group-new-error").textContent = "";
  }

  $("group-new").onsubmit = async (e) => {
    e.preventDefault();
    try {
      await api.createGroup(event.id, {
        name: $("group-new-name").value,
        memberRoleIds: [...$("group-new-people").querySelectorAll("input:checked")].map(
          (box) => box.value,
        ),
      });
      $("group-new-name").value = "";
      await onChanged();
      render();
      say("Group added.");
    } catch (err) {
      $("group-new-error").textContent = err.message;
      $("group-new-name").setAttribute("aria-describedby", "group-new-error");
      $("group-new-name").focus();
    }
  };
}
