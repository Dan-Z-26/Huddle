import { api } from "./api.js";
import { announce, announceError, clear, el, keepFocus, drawBriefDoc } from "./dom.js";

const $ = (id) => document.getElementById(id);

/** Draws what a booked vendor sees beside their group: the brief, and what to hand over. */
export async function renderVendorHome() {
  const { brief, deliverables } = await api.vendorHome();
  drawBriefDoc($("vendor-brief"), brief ?? "");
  const done = deliverables.filter((item) => item.done).length;
  $("vendor-progress").textContent = `${done} of ${deliverables.length} handed over`;
  keepFocus(() => {
    const list = $("vendor-deliverables");
    clear(list);
    for (const item of deliverables)
      list.append(
        el(
          "li",
          {},
          el(
            "label",
            { class: "check" },
            el("input", {
              type: "checkbox",
              checked: item.done,
              "data-focus-key": `deliverable:${item.id}`,
              onchange: async (e) => {
                try {
                  await api.setDeliverable(item.id, e.target.checked);
                  await renderVendorHome();
                  announce($("vendor-progress").textContent);
                } catch (err) {
                  e.target.checked = !e.target.checked;
                  announceError(err.message);
                }
              },
            }),
            item.text,
          ),
        ),
      );
  });
}
