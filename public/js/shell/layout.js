/** The page's frame: who is signed in, which event this is, and which parts are showing. */
import { $, countdown, el, formatDate, initials } from "../shared/dom.js";

/** Shows or hides one element by id. */
export const show = (id, visible) => ($(id).hidden = !visible);

/**
 * Shows one page of the main area and marks its link in the sidebar.
 * @param {string | null} name overview, group, vendors, ask, timeline or budget; null for none.
 */
export function showView(name) {
  show("overview", name === "overview");
  show("group-view", name === "group");
  show("vendors-view", name === "vendors");
  show("ask-view", name === "ask");
  show("timeline-view", name === "timeline");
  show("budget-view", name === "budget");
  show("flow-open", name !== "timeline");
  for (const page of ["brief", "vendors", "ask", "timeline", "budget"]) {
    const current = name === (page === "brief" ? "overview" : page);
    $(`${page}-nav`).setAttribute("aria-current", String(current));
  }
}

/**
 * Draws who is signed in and which event this is.
 * @param {{user: object, invited: boolean}} me The person.
 * @param {object} event The event.
 * @param {{label: string}} template The event type.
 * @param {() => void} switchPerson What "Switch person" does.
 */
export function drawHeader(me, event, template, switchPerson) {
  $("signed-in").replaceChildren(
    me.user.name,
    el("span", { class: "viewer-role", text: me.user.roleName }),
  );
  $("viewer-avatar").textContent = initials(me.user.name);
  show("switch-person", !me.invited);
  show("new-event", me.user.kind !== "vendor");
  $("switch-person").onclick = switchPerson;
  const title = event.name || template.label;
  $("event-title").textContent = title;
  document.title = `${title} · Huddle`;
  $("event-countdown").textContent = countdown(event.date);
  $("event-meta").textContent = [
    event.date && formatDate(event.date),
    event.city,
    event.guests?.confirmed && `${event.guests.confirmed} guests`,
  ]
    .filter(Boolean)
    .join(", ");
}

/**
 * Lays out the page for this person. Groups and vendors don't exist during setup, so setup shows
 * only what it needs; afterwards the brief has a page of its own.
 * @param {{settingUp: boolean, isManager: boolean, isVendor: boolean}} who The event's state, and
 *   who is looking.
 */
export function setLayout({ settingUp, isManager, isVendor }) {
  show("intake", settingUp && isManager);
  document.querySelector(".side").classList.toggle("is-setup", settingUp);
  if (settingUp) {
    showView(null);
    show("ask-nav", false);
  }
  const working = !settingUp && !isVendor;
  show("budget-panel", working);
  show("vendor-panel", isVendor);
  show("brief-details", settingUp && !isVendor);
  for (const id of ["brief-nav", "timeline-nav", "budget-nav", "flow"]) show(id, working);
  $("brief-details").open = settingUp;
}
