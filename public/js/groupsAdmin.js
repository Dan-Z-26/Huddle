import { api } from "./api.js";
import { announce, clear, el } from "./dom.js";

const $ = (id) => document.getElementById(id);

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
export function setUpGroupsAdmin({ event, groups, roles, onChanged }) {
  const dialog = $("groups-dialog");
  const choosable = roles.filter(({ kind }) => kind === "core");
  $("manage-groups").hidden = false;
  $("manage-groups").onclick = () => {
    render();
    dialog.showModal();
  };
  $("groups-close").onclick = () => dialog.close();

  async function run(work, done) {
    announce("");
    try {
      await work();
      await onChanged();
      announce(done);
      render();
    } catch (err) {
      announce(err.message);
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
      onclick: () => {
        if (!armed) {
          armed = true;
          remove.textContent = `Click again to remove ${group.name} and its messages`;
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
    list.append(...groups.map(row));
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
      announce("Group added.");
      render();
    } catch (err) {
      $("group-new-error").textContent = err.message;
      $("group-new-name").setAttribute("aria-describedby", "group-new-error");
      $("group-new-name").focus();
    }
  };
}
