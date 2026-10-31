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

/** Shows a short status message. The region stays in the page so screen readers announce it. */
export function announce(text) {
  document.getElementById("notice").textContent = text;
}

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
  new Date(iso).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" });

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
