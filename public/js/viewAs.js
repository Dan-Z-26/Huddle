import { api } from "./api.js";
import { announce, clear, el } from "./dom.js";

/** Fills the "Viewing as" switcher and calls `onChange(name)` once the server accepts a new user. */
export async function setUpViewAs(selected, onChange) {
  const select = document.getElementById("view-as");
  const { users } = await api.users();
  clear(select);
  for (const user of users) {
    select.append(
      el("option", {
        value: user.id,
        selected: user.id === selected,
        text: `${user.name}, ${user.roleName}`,
      }),
    );
  }
  // The view changes only on the button, not as the list is being browsed with the arrow keys.
  document.getElementById("view-switch").onclick = async () => {
    const name = select.selectedOptions[0].textContent;
    try {
      await api.viewAs(select.value);
      await onChange(name);
    } catch (err) {
      select.value = selected;
      announce(err.message);
    }
  };
}
