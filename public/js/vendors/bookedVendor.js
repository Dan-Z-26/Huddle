/** What follows a booking: deliverables, the vendor's invite link, and asking for a revised quote. */
import { api } from "../shared/api.js";
import { $, clear, copyText, el, formatShortDate } from "../shared/dom.js";

/**
 * Draws what follows a booking: the vendor's deliverables, their invite link and asking for a
 * revised quote.
 * @param {{vendor?: object}} row The chosen category's row.
 * @param {(button: HTMLElement, busy: string, work: () => Promise<*>, done?: string) => Promise<void>}
 *   act Runs an action behind a busy button, then redraws the page.
 */
export function drawBooked(row, act) {
  const { vendor } = row;
  $("booked-box").hidden = !vendor;
  if (!vendor) return;
  $("booked-name").textContent = vendor.name;
  const done = vendor.deliverables.filter((item) => item.done).length;
  $("booked-progress").textContent =
    `${done} of ${vendor.deliverables.length} deliverables handed over`;
  const list = $("booked-deliverables");
  clear(list);
  for (const item of vendor.deliverables)
    list.append(el("li", { text: `${item.done ? "Handed over" : "Waiting"}: ${item.text}` }));
  $("invite-status").textContent = vendor.inviteExpiresAt
    ? `A link is active until ${formatShortDate(vendor.inviteExpiresAt)}.`
    : "No invite link yet. They can't sign in on their own until you make one.";
  $("invite-revoke").hidden = !vendor.inviteExpiresAt;
  $("invite-create").textContent = vendor.inviteExpiresAt ? "Replace the link" : "Create a link";
  $("invite-create").onclick = (e) =>
    act(
      e.target,
      "Creating…",
      async () => {
        const { path } = await api.createInvite(vendor.id);
        $("invite-link").value = `${location.origin}${path}`;
        $("invite-link-box").hidden = false;
      },
      "Invite link created. It's ready to copy.",
    ).then(() => $("invite-link").focus());
  $("invite-revoke").onclick = (e) =>
    act(
      e.target,
      "Revoking…",
      async () => {
        await api.revokeInvite(vendor.id);
        $("invite-link-box").hidden = true;
      },
      "Invite link revoked.",
    );
  $("invite-copy").onclick = () => copyText($("invite-link").value);
  $("revision-ask").onclick = (e) =>
    act(
      e.target,
      "Asking…",
      () => api.requestRevision(vendor.quoteId),
      `Asked ${vendor.name} for a revised quote.`,
    );
}
