import { api } from "./api.js";
import { announce, announceError, clear, el, formatMoney } from "./dom.js";
import { openConfirm } from "./quoteConfirm.js";

const $ = (id) => document.getElementById(id);
const FIELD_LABEL = {
  staffing: "staffing",
  setupHours: "setup and teardown time",
  cancellationTerms: "cancellation terms",
  dietary: "dietary handling",
  price: "a price",
  tax: "taxes",
};
const STATUS = {
  extracted: "Read from the quote. Check it first",
  confirmed: "Confirmed",
  accepted: "Accepted. It sets this category's budget",
};
const STATUS_TONE = { extracted: " warn", confirmed: " note", accepted: "" };

const missingText = (fields) => fields.map((field) => FIELD_LABEL[field] ?? field).join(", ");

function gapText(flag, event) {
  const [kind, id] = flag.split(":");
  const text = event.mustHaves.find((item) => item.id === id)?.text ?? "a must-have";
  if (kind === "absolute_must_have_unmet")
    return `Does not meet your one absolute must-have: ${text}`;
  if (kind === "must_have_unmet") return `Does not meet: ${text}`;
  return kind === "no_price" ? "No price given" : flag;
}

/**
 * Runs an action behind a busy button, announcing any failure and keeping focus somewhere sensible.
 * @param {HTMLButtonElement} button The button pressed.
 * @param {string} busyText What it says meanwhile.
 * @param {() => Promise<void>} work The action.
 * @returns {Promise<void>} Resolves once it is done; it never rejects.
 */
export async function guarded(button, busyText, work) {
  const label = button.textContent;
  button.disabled = true;
  button.textContent = busyText;
  announce("");
  try {
    await work();
  } catch (err) {
    announceError(err.message);
  } finally {
    button.disabled = false;
    button.textContent = label;
    if (document.activeElement === document.body && !$("confirm-dialog").open)
      (button.offsetParent ? button : $("vendors-title")).focus();
  }
}

function quoteCard(quote, page) {
  const { currency, isManager, booked, mustHaves, onChanged, showProposal } = page;
  const actions = [];
  if (quote.status !== "accepted")
    actions.push(
      el("button", {
        type: "button",
        class: "button",
        text: quote.status === "extracted" ? "Check and confirm" : "Edit",
        "aria-label": `${quote.status === "extracted" ? "Check and confirm" : "Edit"} the ${quote.vendorName} quote`,
        onclick: () => openConfirm(quote, { mustHaves: mustHaves(), onConfirmed: onChanged }),
      }),
    );
  if (quote.sourceFileId)
    actions.push(
      el("a", {
        class: "button",
        href: `/api/files/${encodeURIComponent(quote.sourceFileId)}`,
        download: "",
        text: "Download the file",
        "aria-label": `Download the file for the ${quote.vendorName} quote`,
      }),
    );
  if (isManager && quote.status === "confirmed")
    actions.push(
      el("button", {
        type: "button",
        class: "button primary",
        text: "See what accepting does",
        "aria-label": `See what accepting does: ${quote.vendorName}`,
        onclick: (e) =>
          guarded(e.target, "Working it out…", async () => {
            showProposal(`Accept the ${quote.vendorName} quote`, await api.acceptQuote(quote.id));
          }),
      }),
    );
  const declined = el("p", { class: "brief-text", hidden: true });
  if (booked && quote.status === "confirmed")
    actions.push(
      el("button", {
        type: "button",
        class: "button",
        text: "Draft a polite decline",
        "aria-label": `Draft a polite decline for ${quote.vendorName}`,
        onclick: (e) =>
          guarded(e.target, "Drafting…", async () => {
            const { text } = await api.declineDraft(quote.id);
            declined.textContent = text;
            declined.hidden = false;
            await navigator.clipboard?.writeText(text).catch(() => {});
            announce(`Decline for ${quote.vendorName} drafted. It's ready to copy.`);
          }),
      }),
    );
  const total = quote.totalMinor ? formatMoney(quote.totalMinor, currency) : "No price yet";
  return el(
    "li",
    { class: `quote quote-${quote.status}` },
    el(
      "div",
      { class: "quote-head" },
      el("strong", { text: quote.vendorName }),
      el("span", { class: "quote-total", text: total }),
    ),
    el("span", {
      class: `tag${STATUS_TONE[quote.status]}`,
      text: STATUS[quote.status],
    }),
    quote.missing.length
      ? el("p", { class: "muted", text: `Not answered yet: ${missingText(quote.missing)}` })
      : null,
    el("div", { class: "quote-actions" }, ...actions),
    declined,
  );
}

/**
 * Draws the category's quotes.
 * @param {object[]} quotes The quotes.
 * @param {object} page What the cards need: currency, who is looking, whether a vendor is booked,
 *   the category's must-haves, how to redraw, and how to show a proposed change.
 */
export function drawQuotes(quotes, page) {
  const list = $("quote-list");
  clear(list);
  if (quotes.length === 0)
    list.append(
      el("li", {
        class: "muted",
        text: "No quotes for this category yet. Add the first one above.",
      }),
    );
  else list.append(...quotes.map((quote) => quoteCard(quote, page)));
}

/**
 * Draws the comparison table: every figure and flag comes from the server's scoring.
 * @param {object[]} rows The rows, best fit first.
 * @param {{event: object, currency: string}} page The event, and how to show money.
 */
export function drawComparison(rows, { event, currency }) {
  $("compare").hidden = rows.length === 0;
  const body = $("compare-rows");
  clear(body);
  for (const row of rows) {
    const gaps = [
      ...row.reasons,
      ...row.warnings,
      ...row.riskFlags.map((flag) => gapText(flag, event)),
      ...(row.missing.length ? [`Not answered: ${missingText(row.missing)}`] : []),
    ];
    body.append(
      el(
        "tr",
        {},
        el("th", { scope: "row", text: row.vendorName }),
        el("td", { class: "num", text: formatMoney(row.totalMinor, currency) }),
        el("td", { class: "num", text: `${row.mustHaveFit}%` }),
        el("td", { class: "num" }, el("strong", { text: String(row.score) })),
        el("td", { class: "compare-notes" }, ...gaps.map((text) => el("span", { text }))),
      ),
    );
  }
}
