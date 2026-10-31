import { api } from "./api.js";
import { colorOf, renderBudget } from "./budgetChart.js";
import { announce, clear, el, formatMoney } from "./dom.js";
import { generation, isCurrent } from "./session.js";
import { optionCost, planOf, previewOf } from "./gapPlan.js";

const $ = (id) => document.getElementById(id);
const SUGGESTIONS = [
  "What if 50 more guests come?",
  "Move ₹50,000 from gifting to food",
  "How much are we spending per guest?",
  "Can we afford a live band?",
];

export const hideConsequences = () => ($("consequences").hidden = true);

/**
 * Wires "Ask Huddle": sends any question or change to the Budget agent and shows the answer, or the
 * consequences with cuts to choose from. Nothing changes until the manager applies it.
 * @param {object} event The event.
 * @param {{currentBudget: () => object, onApplied: (notices: number) => Promise<void>}} hooks The
 *   budget on screen, and what to do once the server has applied a change.
 */
export function setUpWhatIf(event, { currentBudget, onApplied }) {
  let changeId = null;
  let chosen = [];
  let raise = false;
  let result = null;
  const send = $("what-if-send");
  const money = (minor) => formatMoney(minor, currentBudget().currency);
  const nameOf = (id) => currentBudget().categories.find((item) => item.id === id)?.name ?? id;
  const mustHaveText = (id) => event.mustHaves.find((item) => item.id === id)?.text ?? id;

  function updateChoice() {
    const { options, shortfall } = result.consequences;
    const gap = shortfall.highMinor;
    const plan = planOf(options, gap, chosen);
    const closed = gap - plan.left + (raise ? plan.left : 0);
    const open = gap - closed;
    $("gap-meter").max = gap;
    $("gap-meter").value = closed;
    $("gap-status").textContent = open
      ? `${money(closed)} of ${money(gap)} covered, ${money(open)} still open`
      : `The ${money(gap)} gap is covered`;
    for (const card of document.querySelectorAll("#options .option")) {
      const { id } = card.dataset;
      const on = id === "raise" ? raise : chosen.includes(id);
      card.setAttribute("aria-pressed", String(on));
      card.querySelector(".option-state").textContent = on ? "Chosen" : "Choose";
      if (id === "raise") {
        card.querySelector(".option-figures").textContent =
          `Adds ${money(raise ? plan.left : open)} to the total. No category changes.`;
        continue;
      }
      const option = options.find(({ categoryId }) => categoryId === id);
      const cost = optionCost(option);
      const take = plan.taken.get(id) ?? Math.min(open, cost);
      card.querySelector(".option-figures").textContent = take
        ? `${money(cost)} to ${money(cost - take)}, ${Math.round((take / cost) * 100)}% less`
        : `Stays at ${money(cost)}. The gap is already covered.`;
      card
        .querySelector(".option-bar span")
        .style.setProperty("--fill", `${Math.round(((cost - take) / cost) * 100)}%`);
    }
    const names = chosen.map(nameOf);
    const parts = [];
    if (names.length) parts.push(`cut ${names.join(" and ")}`);
    if (raise) parts.push("raise the budget");
    $("result-apply").textContent = parts.length
      ? `Apply and ${parts.join(", ")}`
      : "Apply and stay over budget";
    renderBudget(previewOf(result, currentBudget(), plan, raise), { preview: true });
  }

  function optionCard(option) {
    const { categoryId, rank, atHigh, atLow } = option;
    const cut = atHigh ?? atLow;
    const tags = [];
    if (cut.removedEntirely)
      tags.push(el("span", { class: "tag warn", text: "Removes it entirely" }));
    else if (cut.tierBefore && cut.tierBefore.id !== cut.tierAfter?.id)
      tags.push(
        el("span", {
          class: "tag note",
          text: `${cut.tierBefore.label} to ${cut.tierAfter?.label ?? "below the lowest level"}`,
        }),
      );
    else tags.push(el("span", { class: "tag", text: "Keeps its current level" }));
    for (const id of cut.mustHaveConflicts)
      tags.push(el("span", { class: "tag warn", text: `Touches must-have: ${mustHaveText(id)}` }));
    if (!cut.coversShortfall)
      tags.push(el("span", { class: "tag note", text: "Can't cover the whole gap alone" }));
    const note = result.insight?.optionNotes?.[categoryId];
    const card = el(
      "button",
      {
        type: "button",
        class: "option",
        "aria-pressed": "false",
        onclick: () => {
          chosen = chosen.includes(categoryId)
            ? chosen.filter((id) => id !== categoryId)
            : [...chosen, categoryId];
          updateChoice();
        },
      },
      el(
        "span",
        { class: "option-head" },
        el("span", { class: "option-dot", "aria-hidden": "true" }),
        nameOf(categoryId),
        rank ? el("small", { class: "muted", text: `priority ${rank}` }) : null,
        el("span", { class: "option-state" }),
      ),
      el("span", { class: "option-figures" }),
      el("span", { class: "option-bar", "aria-hidden": "true" }, el("span")),
      ...tags,
      note ? el("span", { class: "option-note", text: note }) : null,
    );
    card.dataset.id = categoryId;
    card.style.setProperty("--dot", colorOf(categoryId));
    return card;
  }

  function raiseCard() {
    const card = el(
      "button",
      {
        type: "button",
        class: "option",
        "aria-pressed": "false",
        onclick: () => {
          raise = !raise;
          updateChoice();
        },
      },
      el(
        "span",
        { class: "option-head" },
        el("span", { class: "option-dot", "aria-hidden": "true" }),
        "Raise the budget",
        el("span", { class: "option-state" }),
      ),
      el("span", { class: "option-figures" }),
    );
    card.dataset.id = "raise";
    return card;
  }

  function show(text, data) {
    result = data;
    changeId = data.changeId;
    chosen = [];
    raise = false;
    $("consequences").classList.remove("is-loading");
    $("result-request").textContent = `You asked: ${text}`;
    $("result-title").textContent =
      data.answer || data.clarifyingQuestion || data.insight?.headline || "";
    $("result-offline").hidden = !data.offline;
    $("result-insight").textContent = data.insight?.insight ?? "";
    const points = $("result-points");
    clear(points);
    for (const point of data.insight?.points ?? []) points.append(el("li", { text: point }));
    if (data.consequences && data.clarifyingQuestion)
      points.append(el("li", { text: data.clarifyingQuestion }));
    $("result-estimate").hidden = !data.estimates?.length;
    const gap = data.consequences?.shortfall.highMinor ?? 0;
    $("gap").hidden = !(gap > 0 && changeId);
    const list = $("options");
    clear(list);
    if (gap > 0 && changeId) {
      for (const option of data.consequences.options) list.append(el("li", {}, optionCard(option)));
      list.append(el("li", {}, raiseCard()));
    }
    $("result-apply").hidden = !changeId;
    $("result-discard").textContent = changeId ? "Discard" : "Close";
    $("result-apply").textContent = "Apply this change";
    $("consequences").hidden = false;
    $("consequences").focus();
    if (gap > 0 && changeId) updateChoice();
    else if (changeId) {
      const preview = { taken: new Map(), left: 0 };
      renderBudget(previewOf(data, currentBudget(), preview, false), { preview: true });
    }
  }

  async function ask(text) {
    if (!text || send.disabled) return;
    announce("");
    send.disabled = true;
    send.textContent = "Thinking…";
    $("consequences").classList.add("is-loading");
    renderBudget(currentBudget());
    const started = generation();
    try {
      const data = await api.proposeChange(event.id, text);
      if (!isCurrent(started)) return;
      show(text, data);
      $("what-if-text").value = "";
    } catch (err) {
      $("consequences").classList.remove("is-loading");
      announce(err.message);
    } finally {
      send.disabled = false;
      send.textContent = "Ask";
    }
  }

  const suggestions = $("ask-suggestions");
  clear(suggestions);
  for (const text of SUGGESTIONS) {
    suggestions.append(
      el("button", {
        type: "button",
        class: "chip",
        text,
        onclick: () => {
          $("what-if-text").value = text;
          ask(text);
        },
      }),
    );
  }
  $("what-if").onsubmit = (e) => {
    e.preventDefault();
    ask($("what-if-text").value.trim());
  };
  $("result-discard").onclick = () => {
    hideConsequences();
    renderBudget(currentBudget());
    $("what-if-text").focus();
  };
  $("result-apply").onclick = async () => {
    const button = $("result-apply");
    button.disabled = true;
    try {
      const { noticesPosted } = await api.acceptChange(event.id, changeId, { cuts: chosen, raise });
      await onApplied(noticesPosted);
    } catch (err) {
      announce(err.message);
    } finally {
      button.disabled = false;
    }
  };
}
