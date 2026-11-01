import { api } from "./api.js";
import { announce, announceError, clear, el, formatMoney } from "./dom.js";
import { setUpHiring } from "./hiring.js";
import { openConfirm } from "./quoteConfirm.js";
import { generation, isCurrent } from "./session.js";

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

/**
 * The Vendors screen: a checklist and questions per category, quotes added as text, a file or
 * typed details, a confirm step, a comparison, and accepting one through the budget's own flow.
 * @param {{event: object, categories: Array<{id: string, name: string}>, isManager: boolean,
 *   showProposal: (text: string, data: object) => void}} context The event, the categories this
 *   person works on, and how to show the consequences of accepting a quote.
 */
export function setUpVendors({ event, categories, isManager, showProposal }) {
  const select = $("vendor-category");
  // A live reload lands here too, and mustn't move someone off the category they are working on.
  const was = select.value;
  clear(select);
  for (const { id, name } of categories) select.append(el("option", { value: id, text: name }));
  if (categories.some(({ id }) => id === was)) select.value = was;
  const currency = event.budget?.currency ?? event.currency;
  const category = () => select.value;
  const mustHaves = () => event.mustHaves.filter((item) => item.categoryId === category());
  const gapText = (flag) => {
    const [kind, id] = flag.split(":");
    const text = event.mustHaves.find((item) => item.id === id)?.text ?? "a must-have";
    if (kind === "absolute_must_have_unmet")
      return `Does not meet your one absolute must-have: ${text}`;
    if (kind === "must_have_unmet") return `Does not meet: ${text}`;
    return kind === "no_price" ? "No price given" : flag;
  };
  const missingText = (fields) => fields.map((field) => FIELD_LABEL[field] ?? field).join(", ");

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
    renderQuotes(quotes);
    renderComparison(rows);
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

  function quoteCard(quote) {
    const actions = [];
    if (quote.status !== "accepted")
      actions.push(
        el("button", {
          type: "button",
          class: "button",
          text: quote.status === "extracted" ? "Check and confirm" : "Edit",
          "aria-label": `${quote.status === "extracted" ? "Check and confirm" : "Edit"} the ${quote.vendorName} quote`,
          onclick: () => openConfirm(quote, { mustHaves: mustHaves(), onConfirmed: refresh }),
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
        class: `tag${quote.status === "extracted" ? " warn" : quote.status === "accepted" ? "" : " note"}`,
        text: STATUS[quote.status],
      }),
      quote.missing.length
        ? el("p", { class: "muted", text: `Not answered yet: ${missingText(quote.missing)}` })
        : null,
      el("div", { class: "quote-actions" }, ...actions),
      declined,
    );
  }

  function renderQuotes(quotes) {
    const list = $("quote-list");
    clear(list);
    if (quotes.length === 0)
      list.append(
        el("li", {
          class: "muted",
          text: "No quotes for this category yet. Add the first one above.",
        }),
      );
    else list.append(...quotes.map(quoteCard));
  }

  function renderComparison(rows) {
    $("compare").hidden = rows.length === 0;
    const body = $("compare-rows");
    clear(body);
    for (const row of rows) {
      const gaps = [
        ...row.reasons,
        ...row.warnings,
        ...row.riskFlags.map(gapText),
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

  async function guarded(button, busyText, work) {
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
