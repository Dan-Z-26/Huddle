/** Small tools for drawing the page and formatting what it shows. */

const KB = 1024;
const MB = KB * KB;
const DAY_MS = 86400000;
const NOTICE_MS = 8000;

/**
 * The element with this id.
 * @param {string} id The id.
 * @returns {HTMLElement} The element.
 */
export const $ = (id) => document.getElementById(id);

/**
 * Builds an element. Text is always set with textContent, never as HTML, so user and AI text can
 * not inject markup.
 * @param {string} tag The tag name.
 * @param {Record<string, *>} [props] Attributes; `class`, `text` and `on...` handlers are special.
 * @param {...(Node | string | null)} children What goes inside; empty ones are skipped.
 * @returns {HTMLElement} The element.
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

/**
 * Empties an element.
 * @param {Element} node The element.
 */
export const clear = (node) => node.replaceChildren();

let noticeTimer = null;

/**
 * Shows a short status message for a few seconds. The region stays in the page so screen readers
 * announce it.
 * @param {string} text The message, or "" to clear it.
 * @param {{keep?: boolean}} [options] `keep` leaves it up until dismissed.
 */
export function announce(text, { keep = false } = {}) {
  $("notice").textContent = text;
  $("notice-close").hidden = !keep;
  clearTimeout(noticeTimer);
  if (text && !keep) noticeTimer = setTimeout(() => announce(""), NOTICE_MS);
}

/** Shows an error, which stays until dismissed so nobody has to read it against a clock. */
export const announceError = (text) => announce(text, { keep: true });

/**
 * A file's size, under 100 KB in KB and otherwise in MB.
 * @param {number} bytes The size.
 * @returns {string} For example "12 KB".
 */
export const formatSize = (bytes) =>
  bytes < KB * 100 ? `${Math.max(1, Math.round(bytes / KB))} KB` : `${(bytes / MB).toFixed(1)} MB`;

/**
 * The first letters of someone's first two names.
 * @param {string} name The name.
 * @returns {string} For example "AM".
 */
export const initials = (name) =>
  name
    .split(/\s+/)
    .map((word) => word[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();

/**
 * A date in full.
 * @param {string} iso An ISO date.
 * @returns {string} For example "13 January 2027".
 */
export const formatDate = (iso) =>
  new Date(iso).toLocaleDateString("en-IN", { dateStyle: "long", timeZone: "UTC" });

/**
 * A date for short lists.
 * @param {string} iso An ISO date.
 * @returns {string} For example "13 Jan".
 */
export const formatShortDate = (iso) =>
  new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: "UTC" });

/**
 * A time of day, in the viewer's own time zone.
 * @param {string} iso An ISO date.
 * @returns {string} For example "5:12 pm".
 */
export const formatTime = (iso) =>
  new Date(iso).toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit" });

/**
 * The line between one day's messages and the next.
 * @param {string} iso An ISO date.
 * @returns {string} "Today", "Yesterday", or the date.
 */
export function formatDay(iso) {
  const day = new Date(iso).toDateString();
  if (day === new Date().toDateString()) return "Today";
  if (day === new Date(Date.now() - DAY_MS).toDateString()) return "Yesterday";
  return new Date(iso).toLocaleDateString("en-IN", { dateStyle: "long" });
}

/**
 * Today's date, in the form date inputs use.
 * @returns {string} For example "2027-01-13".
 */
export const today = () => new Date().toISOString().slice(0, 10);

/**
 * How long until the event.
 * @param {string} [iso] The event date.
 * @returns {string} "75 days to go", "Tomorrow", "Today" or "Event date has passed".
 */
export function countdown(iso) {
  if (!iso) return "";
  const days = Math.ceil((Date.parse(iso) - Date.parse(today())) / DAY_MS);
  if (days > 1) return `${days} days to go`;
  if (days === 1) return "Tomorrow";
  return days === 0 ? "Today" : "Event date has passed";
}

/**
 * Money in whole units, for the page. Figures come from the server; this only shows them.
 * @param {number} minor Amount in minor units (paise).
 * @param {string} [currency] ISO 4217 code.
 * @returns {string} For example "₹1,20,000".
 */
export const formatMoney = (minor, currency = "INR") =>
  new Intl.NumberFormat("en-IN", { style: "currency", currency, maximumFractionDigits: 0 }).format(
    minor / 100,
  );

/**
 * Draws a hiring brief from its plain text: blank lines separate the parts, a part's first line is
 * its heading, and lines starting "- " are a list. Text with no parts stays a paragraph.
 * @param {HTMLElement} box Where to draw it.
 * @param {string} text The brief.
 */
export function drawBriefDoc(box, text) {
  clear(box);
  for (const block of text.split(/\n{2,}/).filter(Boolean)) {
    const [first, ...rest] = block.split("\n");
    if (rest.length === 0) {
      box.append(el("p", { class: "brief-doc-title", text: first }));
      continue;
    }
    box.append(el("h4", { text: first }));
    box.append(
      rest.every((line) => line.startsWith("- "))
        ? el("ul", {}, ...rest.map((line) => el("li", { text: line.slice(2) })))
        : el("p", { text: rest.join("\n") }),
    );
  }
}

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
  const safeKey = CSS.escape(key);
  (
    document.querySelector(`[data-focus-key="${safeKey}"]`) ??
    document.querySelector(`[data-focus-after="${safeKey}"]`)
  )?.focus();
}

/**
 * Copies text and says whether it worked.
 * @param {string} text What to copy.
 * @returns {Promise<void>} Resolves once it is announced; it never rejects.
 */
export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    announce("Copied.");
  } catch {
    announce("Couldn't reach the clipboard. Please select the text and copy it.");
  }
}

/**
 * Runs some work with a button saying it is busy, and puts the button back whatever happens.
 * @param {HTMLButtonElement} button The button.
 * @param {string} busyText What it says meanwhile.
 * @param {() => Promise<*>} work The work.
 * @returns {Promise<*>} What the work returned; a failure is passed on to the caller.
 */
export async function whileBusy(button, busyText, work) {
  const label = button.textContent;
  button.disabled = true;
  button.textContent = busyText;
  try {
    return await work();
  } finally {
    button.disabled = false;
    button.textContent = label;
  }
}
