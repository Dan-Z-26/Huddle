import { api } from "./api.js";
import { announce, announceError, clear, el } from "./dom.js";
import { setUpHiring } from "./hiring.js";
import { openConfirm } from "./quoteConfirm.js";
import { drawComparison, drawQuotes, guarded } from "./quoteCards.js";
import { generation, isCurrent } from "./session.js";

const $ = (id) => document.getElementById(id);

/**
 * The Vendors screen: a checklist and questions per category, quotes added as text, a file or
 * typed details, a confirm step, a comparison, and accepting one through the budget's own flow.
 * @param {{event: object, categories: Array<{id: string, name: string}>, startOn?: string,
 *   isManager: boolean, showProposal: (text: string, data: object) => void}} context The event, the
 *   categories this person works on, the one to open first, and how to show the consequences of
 *   accepting a quote.
 */
export function setUpVendors({ event, categories, startOn, isManager, showProposal }) {
  const select = $("vendor-category");
  // A live reload lands here too, and mustn't move someone off the category they are working on.
  const was = select.value;
  clear(select);
  for (const { id, name } of categories) select.append(el("option", { value: id, text: name }));
  const opening = was || startOn;
  if (categories.some(({ id }) => id === opening)) select.value = opening;
  const currency = event.budget?.currency ?? event.currency;
  const category = () => select.value;
  const mustHaves = () => event.mustHaves.filter((item) => item.categoryId === category());
  let booked = false;
  let refreshNow = async () => {};
  const hiring = setUpHiring({
    event,
    isManager,
    category,
    onSelect: (id) => {
      select.value = id;
      select.onchange();
      $("vendor-category").focus();
    },
    onChanged: () => refreshNow(),
  });

  async function refresh() {
    const started = generation();
    const [row, { quotes }, { rows }] = await Promise.all([
      hiring.refresh(),
      api.quotes(event.id, category()),
      api.comparison(event.id, category()),
    ]);
    if (!isCurrent(started)) return;
    booked = Boolean(row.vendor);
    renderSamples(row);
    const page = {
      event,
      currency,
      isManager,
      booked,
      mustHaves,
      onChanged: refresh,
      showProposal,
    };
    drawQuotes(quotes, page);
    drawComparison(rows, page);
  }
  refreshNow = refresh;

  // The demo's sample quotes go through the same upload as any file the lead would pick.
  function renderSamples({ samples, brief }) {
    const box = $("sample-quotes");
    clear(box);
    box.hidden = !samples.length || brief?.status !== "approved";
    for (const { file, vendorName } of samples)
      box.append(
        el("button", {
          type: "button",
          class: "chip",
          text: `Use sample: ${vendorName}`,
          onclick: (e) =>
            guarded(e.target, "Reading…", async () => {
              const bytes = await (await fetch(`/samples/${file}`)).blob();
              const form = new FormData();
              form.set("categoryId", category());
              form.set("file", new File([bytes], file, { type: "application/pdf" }));
              await addQuote(form);
            }),
        }),
      );
  }

  async function addQuote(form) {
    const started = generation();
    const result = await api.addQuote(event.id, form);
    if (!isCurrent(started)) return;
    await refresh();
    if (result.quote.status === "extracted") {
      openConfirm(result.quote, {
        warnings: [
          ...(result.offline
            ? [
                "No AI was reachable, so this came from a stored reading. Please check every figure.",
              ]
            : []),
          ...result.warnings,
        ],
        mustHaves: mustHaves(),
        onConfirmed: refresh,
      });
    } else announce("Quote added.");
  }

  $("rfq-get").onclick = () =>
    guarded($("rfq-get"), "Preparing…", async () => {
      const started = generation();
      const rfq = await api.rfq(event.id, category());
      if (!isCurrent(started)) return;
      for (const [id, items] of [
        ["rfq-checklist", rfq.checklist],
        ["rfq-questions", rfq.rfqQuestions],
      ]) {
        const list = $(id);
        clear(list);
        list.append(...items.map((text) => el("li", { text })));
      }
      $("rfq-offline").hidden = !rfq.offline;
      $("rfq-posted").textContent = rfq.message ? "Posted in the category's group." : "";
      $("rfq-result").hidden = false;
      $("rfq-result").focus();
    });

  $("quote-form").onsubmit = (e) => {
    e.preventDefault();
    const text = $("quote-text").value.trim();
    const file = $("quote-file").files[0];
    const typed = [$("quote-vendor"), $("quote-per-guest"), $("quote-fixed")].some((input) =>
      input.value.trim(),
    );
    const error = $("quote-error");
    error.textContent = "";
    if (!text && !file && !typed) {
      error.textContent = "Paste the quote, upload a file or type the details first.";
      $("quote-text").setAttribute("aria-describedby", "quote-error");
      $("quote-text").focus();
      return;
    }
    const form = new FormData();
    form.set("categoryId", category());
    if (text) form.set("text", text);
    if (file) form.set("file", file);
    for (const [name, id] of [
      ["vendorName", "quote-vendor"],
      ["perGuestText", "quote-per-guest"],
      ["fixedText", "quote-fixed"],
      ["taxPercent", "quote-tax"],
      ["includes", "quote-includes"],
    ])
      if ($(id).value.trim()) form.set(name, $(id).value.trim());
    guarded($("quote-send"), file ? `Uploading and reading ${file.name}…` : "Adding…", async () => {
      announce(file ? `Uploading and reading ${file.name}.` : "Adding the quote.");
      await addQuote(form);
      $("quote-form").reset();
    });
  };

  select.onchange = () => {
    $("rfq-result").hidden = true;
    $("invite-link-box").hidden = true;
    refresh().catch((err) => announceError(err.message));
  };
  return refresh;
}
