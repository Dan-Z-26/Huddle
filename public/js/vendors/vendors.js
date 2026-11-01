/**
 * The Vendors screen: a checklist and questions per category, quotes added as text, a file or typed
 * details, a confirm step, a comparison, and accepting one through the budget's own flow.
 */
import { api } from "../shared/api.js";
import { $, announce, announceError, clear, el } from "../shared/dom.js";
import { generation, isCurrent } from "../shared/session.js";
import { setUpHiring } from "./hiring.js";
import { drawComparison, drawQuotes, guarded } from "./quoteCards.js";
import { openConfirm } from "./quoteConfirm.js";

const TYPED_FIELDS = [
  ["vendorName", "quote-vendor"],
  ["perGuestText", "quote-per-guest"],
  ["fixedText", "quote-fixed"],
  ["taxPercent", "quote-tax"],
  ["includes", "quote-includes"],
];

const mustHavesIn = (page) =>
  page.event.mustHaves.filter((item) => item.categoryId === page.category());

async function addQuote(form, page) {
  const started = generation();
  const result = await api.addQuote(page.event.id, form);
  if (!isCurrent(started)) return;
  await page.refresh();
  if (result.quote.status !== "extracted") {
    announce("Quote added.");
    return;
  }
  const noAi =
    "No AI was reachable, so this came from a stored reading. Please check every figure.";
  openConfirm(result.quote, {
    warnings: [...(result.offline ? [noAi] : []), ...result.warnings],
    mustHaves: mustHavesIn(page),
    onConfirmed: page.refresh,
  });
}

// The demo's sample quotes go through the same upload as any file the lead would pick.
async function useSample(file, page) {
  const bytes = await (await fetch(`/samples/${file}`)).blob();
  const form = new FormData();
  form.set("categoryId", page.category());
  form.set("file", new File([bytes], file, { type: "application/pdf" }));
  await addQuote(form, page);
}

function drawSamples({ samples, brief }, page) {
  const box = $("sample-quotes");
  clear(box);
  box.hidden = !samples.length || brief?.status !== "approved";
  for (const { file, vendorName } of samples)
    box.append(
      el("button", {
        type: "button",
        class: "chip",
        text: `Use sample: ${vendorName}`,
        onclick: (e) => guarded(e.target, "Reading…", () => useSample(file, page)),
      }),
    );
}

async function refresh(page) {
  const started = generation();
  const [row, { quotes }, { rows }] = await Promise.all([
    page.hiring.refresh(),
    api.quotes(page.event.id, page.category()),
    api.comparison(page.event.id, page.category()),
  ]);
  if (!isCurrent(started)) return;
  drawSamples(row, page);
  const view = {
    event: page.event,
    currency: page.currency,
    isManager: page.isManager,
    booked: Boolean(row.vendor),
    mustHaves: () => mustHavesIn(page),
    onChanged: page.refresh,
    showProposal: page.showProposal,
  };
  drawQuotes(quotes, view);
  drawComparison(rows, view);
}

async function getRfq(page) {
  const started = generation();
  const rfq = await api.rfq(page.event.id, page.category());
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
}

function submitQuote(e, page) {
  e.preventDefault();
  const text = $("quote-text").value.trim();
  const file = $("quote-file").files[0];
  const typed = ["quote-vendor", "quote-per-guest", "quote-fixed"].some((id) => $(id).value.trim());
  const error = $("quote-error");
  error.textContent = "";
  if (!text && !file && !typed) {
    error.textContent = "Paste the quote, upload a file or type the details first.";
    $("quote-text").setAttribute("aria-describedby", "quote-error");
    $("quote-text").focus();
    return;
  }
  const form = new FormData();
  form.set("categoryId", page.category());
  if (text) form.set("text", text);
  if (file) form.set("file", file);
  for (const [name, id] of TYPED_FIELDS) if ($(id).value.trim()) form.set(name, $(id).value.trim());
  guarded($("quote-send"), file ? `Uploading and reading ${file.name}…` : "Adding…", async () => {
    announce(file ? `Uploading and reading ${file.name}.` : "Adding the quote.");
    await addQuote(form, page);
    $("quote-form").reset();
  });
}

// A live reload lands here too, and mustn't move someone off the category they are working on.
function fillCategories(select, categories, startOn) {
  const was = select.value;
  clear(select);
  for (const { id, name } of categories) select.append(el("option", { value: id, text: name }));
  const opening = was || startOn;
  if (categories.some(({ id }) => id === opening)) select.value = opening;
}

/**
 * Wires the Vendors screen.
 * @param {{event: object, categories: Array<{id: string, name: string}>, startOn?: string,
 *   isManager: boolean, showProposal: (text: string, data: object) => void}} context The event, the
 *   categories this person works on, the one to open first, and how to show the consequences of
 *   accepting a quote.
 * @returns {() => Promise<void>} Fetches and draws the page.
 */
export function setUpVendors({ event, categories, startOn, isManager, showProposal }) {
  const select = $("vendor-category");
  fillCategories(select, categories, startOn);
  const page = {
    event,
    isManager,
    showProposal,
    currency: event.budget?.currency ?? event.currency,
    category: () => select.value,
    refresh: () => refresh(page),
  };
  page.hiring = setUpHiring({
    event,
    isManager,
    category: page.category,
    onSelect: (id) => {
      select.value = id;
      select.onchange();
      select.focus();
    },
    onChanged: page.refresh,
  });
  $("rfq-get").onclick = () => guarded($("rfq-get"), "Preparing…", () => getRfq(page));
  $("quote-form").onsubmit = (e) => submitQuote(e, page);
  select.onchange = () => {
    $("rfq-result").hidden = true;
    $("invite-link-box").hidden = true;
    page.refresh().catch((err) => announceError(err.message));
  };
  return page.refresh;
}
