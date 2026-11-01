import { api } from "./api.js";
import { renderBudget } from "./budgetChart.js";
import { announce, announceError, clear, el, formatMoney } from "./dom.js";
import { generation, isCurrent } from "./session.js";
import { optionCard, plainCard } from "./gapCards.js";
import { optionCost, planOf, previewOf } from "./gapPlan.js";

const $ = (id) => document.getElementById(id);
const SUGGESTIONS = [
  "What if 50 more guests come?",
  "How much have we spent so far?",
  "Move ₹50,000 from gifting to food",
  "Can we afford a live band?",
];

export const hideConsequences = () => ($("consequences").hidden = true);

/**
 * Wires "Ask Huddle": sends any question or change to the Budget agent and shows the answer, or the
 * consequences with cuts to choose from. Nothing changes until the manager applies it.
 * @param {object} event The event.
 * @param {{currentBudget: () => object, onApplied: (notices: number) => Promise<void>}} hooks The
 *   budget on screen, and what to do once the server has applied a change.
 * @returns {{show: (text: string, data: object) => void}} `show` displays any proposed change,
 *   such as accepting a quote, in the same panel.
 */
export function setUpWhatIf(event, { currentBudget, onApplied }) {
  let changeId = null;
  let chosen = [];
  let raise = false;
  let useBuffer = false;
  let result = null;
  const send = $("what-if-send");
  const money = (minor) => formatMoney(minor, currentBudget().currency);
  const nameOf = (id) => currentBudget().categories.find((item) => item.id === id)?.name ?? id;
  const mustHaveText = (id) => event.mustHaves.find((item) => item.id === id)?.text ?? id;

  function drawFigures(card, { plan, open, gap, buffer, options }) {
    const { id } = card.dataset;
    const figures = card.querySelector(".option-figures");
    if (id === "buffer") {
      figures.textContent = `Uses ${money(Math.min(gap, buffer))} of the ${money(buffer)} left. No category changes.`;
      return;
    }
    if (id === "raise") {
      figures.textContent = `Adds ${money(raise ? plan.left : open)} to the total. No category changes.`;
      return;
    }
    const cost = optionCost(options.find(({ categoryId }) => categoryId === id));
    const take = plan.taken.get(id) ?? Math.min(open, cost);
    figures.textContent = take
      ? `${money(cost)} to ${money(cost - take)}, ${Math.round((take / cost) * 100)}% less`
      : `Stays at ${money(cost)}. The gap is already covered.`;
    card
      .querySelector(".option-bar span")
      .style.setProperty("--fill", `${Math.round(((cost - take) / cost) * 100)}%`);
  }

  function updateChoice() {
    const { options, shortfall, bufferAvailableMinor: buffer } = result.consequences;
    const gap = shortfall.highMinor;
    const plan = planOf(options, gap, chosen, useBuffer ? buffer : 0);
    const closed = gap - plan.left + (raise ? plan.left : 0);
    const open = gap - closed;
    $("gap-meter").max = gap;
    $("gap-meter").value = closed;
    $("gap-status").textContent = open
      ? `${money(closed)} of ${money(gap)} covered, ${money(open)} still open`
      : `The ${money(gap)} gap is covered`;
    for (const card of document.querySelectorAll("#options .option")) {
      const { id } = card.dataset;
      const special = { raise, buffer: useBuffer };
      const on = id in special ? special[id] : chosen.includes(id);
      card.setAttribute("aria-pressed", String(on));
      card.querySelector(".option-state").textContent = on ? "Chosen" : "Choose";
      drawFigures(card, { plan, open, gap, buffer, options });
    }
    const names = chosen.map(nameOf);
    const parts = [];
    if (useBuffer) parts.push("use the buffer");
    if (names.length) parts.push(`cut ${names.join(" and ")}`);
    if (raise) parts.push("raise the budget");
    $("result-apply").textContent = parts.length
      ? `Apply and ${parts.join(", ")}`
      : "Apply and stay over budget";
    renderBudget(previewOf(result, currentBudget(), plan, raise), { preview: true });
  }

  function drawAnswer(text, data) {
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
  }

  function drawOptions(data) {
    const list = $("options");
    clear(list);
    const item = (card) => list.append(el("li", {}, card));
    if (data.consequences.bufferAvailableMinor > 0)
      item(
        plainCard("buffer", "Use the contingency buffer", () => {
          useBuffer = !useBuffer;
          updateChoice();
        }),
      );
    for (const option of data.consequences.options) {
      const { categoryId } = option;
      const toggle = () => {
        chosen = chosen.includes(categoryId)
          ? chosen.filter((id) => id !== categoryId)
          : [...chosen, categoryId];
        updateChoice();
      };
      const note = data.insight?.optionNotes?.[categoryId];
      item(optionCard(option, { nameOf, mustHaveText, note }, toggle));
    }
    item(
      plainCard("raise", "Raise the budget", () => {
        raise = !raise;
        updateChoice();
      }),
    );
  }

  function show(text, data) {
    result = data;
    changeId = data.changeId;
    chosen = [];
    raise = false;
    useBuffer = false;
    $("consequences").classList.remove("is-loading");
    drawAnswer(text, data);
    const hasGap = (data.consequences?.shortfall.highMinor ?? 0) > 0 && Boolean(changeId);
    $("gap").hidden = !hasGap;
    if (hasGap) drawOptions(data);
    else clear($("options"));
    $("result-apply").hidden = !changeId;
    $("result-discard").textContent = changeId ? "Discard" : "Close";
    $("result-apply").textContent = "Apply this change";
    $("consequences").hidden = false;
    $("consequences").focus();
    if (hasGap) updateChoice();
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
      announceError(err.message);
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
    const label = button.textContent;
    button.disabled = true;
    button.textContent = "Applying…";
    try {
      const { noticesPosted } = await api.acceptChange(event.id, changeId, {
        cuts: chosen,
        raise,
        useBuffer,
      });
      await onApplied(noticesPosted);
    } catch (err) {
      announceError(err.message);
    } finally {
      button.disabled = false;
      button.textContent = label;
    }
  };
  return { show };
}
