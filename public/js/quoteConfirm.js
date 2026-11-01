import { api } from "./api.js";
import { announce, clear, el } from "./dom.js";

const $ = (id) => document.getElementById(id);
const ANSWERS = [
  ["staffing", "confirm-staffing"],
  ["setupHours", "confirm-setup"],
  ["cancellationTerms", "confirm-cancellation"],
  ["dietary", "confirm-dietary"],
];

const LABEL = {
  staffing: "staffing",
  setupHours: "setup time",
  cancellationTerms: "cancellation terms",
  dietary: "dietary handling",
};

// The exact figure: confirming a quote unchanged mustn't round its price.
const priceText = (minor) => (minor ? String(minor / 100) : "");

/**
 * Opens the "check this quote" dialog, prefilled with what was read. Nothing from a document is
 * used until the person confirms it here. Calls `onConfirmed` once the server has saved it.
 * @param {object} quote The quote as read.
 * @param {{warnings?: string[], mustHaves: object[], onConfirmed: () => Promise<void>}} context
 *   Anything the reader couldn't make out, the category's must-haves, and what to do afterwards.
 */
export function openConfirm(quote, { warnings = [], mustHaves, onConfirmed }) {
  const dialog = $("confirm-dialog");
  $("confirm-source").textContent =
    quote.status === "extracted"
      ? "This was read from the quote. Please check every figure against the original."
      : "Change anything that is wrong, then confirm.";
  const list = $("confirm-warnings");
  clear(list);
  const notStated = [
    ...(quote.taxStated === false ? ["taxes"] : []),
    ...ANSWERS.filter(([key]) => quote.answers && !quote.answers[key]).map(([key]) => LABEL[key]),
  ];
  const shown = [
    ...warnings,
    ...(quote.status === "extracted" && notStated.length
      ? [`Not stated in the quote: ${notStated.join(", ")}`]
      : []),
  ];
  for (const warning of shown) list.append(el("li", { text: warning }));
  const sources = Object.entries(quote.sources ?? {}).filter(([, text]) => text);
  $("confirm-sources-box").hidden = sources.length === 0;
  $("confirm-sources-box").open = sources.length > 0;
  const quoted = $("confirm-sources");
  clear(quoted);
  for (const [key, text] of sources) quoted.append(el("li", { text: `${key}: "${text}"` }));
  $("confirm-vendor").value = quote.vendorName ?? "";
  $("confirm-per-guest").value = priceText(quote.perGuestMinor);
  $("confirm-fixed").value = priceText(quote.fixedMinor);
  // A stated 0% stays stated; only silence leaves this empty.
  $("confirm-tax").value = quote.taxBps || quote.taxStated ? String(quote.taxBps / 100) : "";
  $("confirm-includes").value = (quote.includes ?? []).join(", ");
  for (const [key, id] of ANSWERS) $(id).value = quote.answers?.[key] ?? "";
  $("confirm-exclusions").value = (quote.exclusions ?? []).join(", ");
  $("confirm-min-guests").value = quote.minGuests ?? "";
  $("confirm-valid").value = quote.validUntil ?? "";

  const musts = $("confirm-musts");
  musts.replaceChildren(musts.querySelector("legend"));
  musts.hidden = mustHaves.length === 0;
  for (const { id, text } of mustHaves) {
    const box = el("input", {
      type: "checkbox",
      value: id,
      checked: quote.mustHaveIdsMet?.includes(id),
    });
    musts.append(el("label", { class: "check" }, box, text));
  }
  $("confirm-error").textContent = "";

  dialog.onclose = () => {
    if (document.activeElement === document.body) $("vendors-title").focus();
  };
  $("confirm-cancel").onclick = () => dialog.close();
  $("confirm-form").onsubmit = async (e) => {
    e.preventDefault();
    const field = (id) => $(id).value.trim();
    const answers = Object.fromEntries(ANSWERS.map(([key, id]) => [key, field(id) || null]));
    const tax = field("confirm-tax");
    const minGuests = Number(field("confirm-min-guests"));
    try {
      await api.confirmQuote(quote.id, {
        vendorName: field("confirm-vendor"),
        perGuestText: field("confirm-per-guest") || undefined,
        fixedText: field("confirm-fixed") || undefined,
        ...(tax ? { taxPercent: Number(tax) } : {}),
        includes: field("confirm-includes")
          .split(",")
          .map((item) => item.trim())
          .filter(Boolean),
        exclusions: field("confirm-exclusions")
          .split(",")
          .map((item) => item.trim())
          .filter(Boolean),
        ...(Number.isInteger(minGuests) && minGuests > 0 ? { minGuests } : {}),
        validUntil: field("confirm-valid"),
        mustHaveIdsMet: [...musts.querySelectorAll("input:checked")].map((box) => box.value),
        answers,
      });
      dialog.close();
      await onConfirmed();
      announce("Quote confirmed.");
      $("vendors-title").focus();
    } catch (err) {
      const box = $("confirm-error");
      box.textContent = err.message;
      box.focus();
    }
  };
  dialog.showModal();
}
