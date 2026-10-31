/**
 * Builds an element. Text is always set with textContent, never as HTML, so user and AI text can
 * not inject markup.
 */
export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else if (value === true) node.setAttribute(key, "");
    else if (value !== false && value != null) node.setAttribute(key, value);
  }
  // list-style: none can make some screen readers drop list semantics.
  if ((tag === "ul" || tag === "ol") && !props.role) node.setAttribute("role", "list");
  node.append(...children.filter(Boolean));
  return node;
}

export const clear = (node) => node.replaceChildren();

let noticeTimer = null;

/**
 * Shows a short status message for a few seconds. The region stays in the page so screen readers
 * announce it.
 * @param {string} text The message, or "" to clear it.
 * @param {{keep?: boolean}} [options] `keep` leaves it up until dismissed.
 */
export function announce(text, { keep = false } = {}) {
  const notice = document.getElementById("notice");
  notice.textContent = text;
  document.getElementById("notice-close").hidden = !keep;
  clearTimeout(noticeTimer);
  if (text && !keep) noticeTimer = setTimeout(() => announce(""), 8000);
}

/** Shows an error, which stays until dismissed so nobody has to read it against a clock. */
export const announceError = (text) => announce(text, { keep: true });

/** Under 100 KB in KB, otherwise in MB. */
export const formatSize = (bytes) =>
  bytes < 1024 * 100
    ? `${Math.max(1, Math.round(bytes / 1024))} KB`
    : `${(bytes / 1048576).toFixed(1)} MB`;

export const initials = (name) =>
  name
    .split(/\s+/)
    .map((word) => word[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();

export const formatDate = (iso) =>
  new Date(iso).toLocaleDateString("en-IN", { dateStyle: "long", timeZone: "UTC" });

export const formatShortDate = (iso) =>
  new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: "UTC" });

export const formatTime = (iso) =>
  new Date(iso).toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit" });

/** "Today", "Yesterday", or the date, for the line between one day's messages and the next. */
export function formatDay(iso) {
  const day = new Date(iso).toDateString();
  if (day === new Date().toDateString()) return "Today";
  if (day === new Date(Date.now() - 86400000).toDateString()) return "Yesterday";
  return new Date(iso).toLocaleDateString("en-IN", { dateStyle: "long" });
}

export const formatMoney = (minor, currency = "INR") =>
  new Intl.NumberFormat("en-IN", { style: "currency", currency, maximumFractionDigits: 0 }).format(
    minor / 100,
  );

/**
 * Runs a redraw and puts keyboard focus back afterwards. A control marked `data-focus-key` is
 * found again by its key; if it is gone (a "Got it" that was pressed), the element marked
 * `data-focus-after` with the same key takes focus, so focus is never dropped to the page.
 * @param {() => void} redraw Rebuilds part of the screen.
 */
export function keepFocus(redraw) {
  const key = document.activeElement?.dataset?.focusKey;
  redraw();
  if (!key) return;
  const q = CSS.escape(key);
  (
    document.querySelector(`[data-focus-key="${q}"]`) ??
    document.querySelector(`[data-focus-after="${q}"]`)
  )?.focus();
}
