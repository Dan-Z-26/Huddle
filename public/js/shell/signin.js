/** The demo sign-in: the event's people, one tap each. */
import { api } from "../shared/api.js";
import { $, announceError, clear, el } from "../shared/dom.js";

/**
 * Shows the demo sign-in: the event's people, one tap each. Whoever signs in is held by a
 * server-side session, and the server works out what they may do from it on every request.
 * @param {() => Promise<void>} onSignedIn Draws the workspace for the new person.
 */
export async function showSignIn(onSignedIn) {
  const leave = (visible) => {
    $("signin").hidden = !visible;
    document.querySelector(".app").hidden = visible;
    document.querySelector(".skip-link").hidden = visible;
  };
  leave(true);
  const list = $("signin-list");
  clear(list);
  try {
    const { people, eventName, isDemo, startWithNew } = await api.people();
    $("signin-event").textContent = eventName;
    $("signin-demo").hidden = isDemo;
    for (const person of people)
      list.append(
        el(
          "li",
          {},
          el(
            "button",
            {
              type: "button",
              class: "person",
              onclick: async () => {
                try {
                  await api.signIn(person.id);
                  leave(false);
                  await onSignedIn();
                } catch (err) {
                  announceError(err.message);
                }
              },
            },
            el("strong", { text: person.name }),
            el("span", { class: "muted", text: person.roleName }),
          ),
        ),
      );
    list.querySelector("button")?.focus();
    if (startWithNew) $("signin-new").click();
  } catch (err) {
    announceError(err.message);
  }
  $("signin-demo").onclick = async () => {
    await api.signOut();
    await showSignIn(onSignedIn);
  };
}
