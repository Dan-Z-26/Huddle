/** A booked vendor's own page. */
import { api } from "../shared/api.js";
import { $, announce, announceError, clear, el, keepFocus, drawBriefDoc } from "../shared/dom.js";

async function tickDeliverable(e, item) {
  try {
    await api.setDeliverable(item.id, e.target.checked);
    await renderVendorHome();
    announce($("vendor-progress").textContent);
  } catch (err) {
    e.target.checked = !e.target.checked;
    announceError(err.message);
  }
}

function deliverableItem(item) {
  return el(
    "li",
    {},
    el(
      "label",
      { class: "check" },
      el("input", {
        type: "checkbox",
        checked: item.done,
        "data-focus-key": `deliverable:${item.id}`,
        onchange: (e) => tickDeliverable(e, item),
      }),
      item.text,
    ),
  );
}

/**
 * Draws what a booked vendor sees beside their group: the brief, and what to hand over.
 * @returns {Promise<void>} Resolves once it is drawn.
 */
export async function renderVendorHome() {
  const { brief, deliverables } = await api.vendorHome();
  drawBriefDoc($("vendor-brief"), brief ?? "");
  const done = deliverables.filter((item) => item.done).length;
  $("vendor-progress").textContent = `${done} of ${deliverables.length} handed over`;
  keepFocus(() => {
    const list = $("vendor-deliverables");
    clear(list);
    list.append(...deliverables.map(deliverableItem));
  });
}
