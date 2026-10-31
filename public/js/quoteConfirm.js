import { api } from "./api.js";
import { clear, el, formatMoney } from "./dom.js";

const $ = (id) => document.getElementById(id);
const ANSWERS = [
  ["staffing", "confirm-staffing"],
  ["setupHours", "confirm-setup"],
  ["cancellationTerms", "confirm-cancel"],
  ["dietary", "confirm-dietary"],
];

const priceText = (minor) => (minor ? formatMoney(minor) : "");

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
  for (const warning of warnings) list.append(el("li", { text: warning }));
  $("confirm-vendor").value = quote.vendorName ?? "";
  $("confirm-per-guest").value = priceText(quote.perGuestMinor);
  $("confirm-fixed").value = priceText(quote.fixedMinor);
  $("confirm-tax").value = quote.taxBps ? String(quote.taxBps / 100) : "";
  $("confirm-includes").value = (quote.includes ?? []).join(", ");
  for (const [key, id] of ANSWERS) $(id).value = quote.answers?.[key] ?? "";

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

  $("confirm-cancel").onclick = () => dialog.close();
  $("confirm-form").onsubmit = async (e) => {
    e.preventDefault();
    const field = (id) => $(id).value.trim();
    const answers = Object.fromEntries(ANSWERS.map(([key, id]) => [key, field(id) || null]));
    const tax = field("confirm-tax");
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
        mustHaveIdsMet: [...musts.querySelectorAll("input:checked")].map((box) => box.value),
        answers,
      });
      dialog.close();
      await onConfirmed();
    } catch (err) {
      const box = $("confirm-error");
      box.textContent = err.message;
      $("confirm-per-guest").setAttribute("aria-describedby", "confirm-error");
      $("confirm-per-guest").focus();
    }
  };
  dialog.showModal();
}
