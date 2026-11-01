/** "Ask Huddle": any question or change goes to the Budget agent; its consequences are shown here. */
import { api } from "../shared/api.js";
import { $, announce, announceError, clear, el, whileBusy } from "../shared/dom.js";
import { generation, isCurrent } from "../shared/session.js";
import { renderBudget } from "./budgetChart.js";
import { drawOptions, updateChoice } from "./gapChoice.js";
import { previewOf } from "./gapPlan.js";

const SUGGESTIONS = [
  "What if 50 more guests come?",
  "How much have we spent so far?",
  "Move ₹50,000 from gifting to food",
  "Can we afford a live band?",
];

/** Hides the consequences panel. */
export const hideConsequences = () => ($("consequences").hidden = true);

function drawAnswer(text, data) {
  const { consequences, clarifyingQuestion, answer } = data;
  const insight = data.insight ?? {};
  $("result-request").textContent = `You asked: ${text}`;
  $("result-title").textContent = answer || clarifyingQuestion || insight.headline || "";
  $("result-offline").hidden = !data.offline;
  $("result-insight").textContent = insight.insight ?? "";
  const points = $("result-points");
  clear(points);
  for (const point of insight.points ?? []) points.append(el("li", { text: point }));
  if (consequences && clarifyingQuestion) points.append(el("li", { text: clarifyingQuestion }));
  $("result-estimate").hidden = !data.estimates?.length;
}

function show(text, data, panel) {
  Object.assign(panel, {
    result: data,
    changeId: data.changeId,
    chosen: [],
    raise: false,
    useBuffer: false,
  });
  const { changeId } = data;
  $("consequences").classList.remove("is-loading");
  drawAnswer(text, data);
  const hasGap = (data.consequences?.shortfall.highMinor ?? 0) > 0 && Boolean(changeId);
  $("gap").hidden = !hasGap;
  if (hasGap) drawOptions(data, panel);
  else clear($("options"));
  $("result-apply").hidden = !changeId;
  $("result-discard").textContent = changeId ? "Discard" : "Close";
  $("result-apply").textContent = "Apply this change";
  $("consequences").hidden = false;
  $("consequences").focus();
  if (hasGap) updateChoice(panel);
  else if (changeId) {
    const preview = { taken: new Map(), left: 0 };
    renderBudget(previewOf(data, panel.currentBudget(), preview, false), { preview: true });
  }
}

async function ask(text, panel) {
  const send = $("what-if-send");
  if (!text || send.disabled) return;
  announce("");
  send.disabled = true;
  send.textContent = "Thinking…";
  $("consequences").classList.add("is-loading");
  renderBudget(panel.currentBudget());
  const started = generation();
  try {
    const data = await api.proposeChange(panel.event.id, text);
    if (!isCurrent(started)) return;
    show(text, data, panel);
    $("what-if-text").value = "";
  } catch (err) {
    $("consequences").classList.remove("is-loading");
    announceError(err.message);
  } finally {
    send.disabled = false;
    send.textContent = "Ask";
  }
}

function drawSuggestions(panel) {
  const suggestions = $("ask-suggestions");
  clear(suggestions);
  for (const text of SUGGESTIONS)
    suggestions.append(
      el("button", {
        type: "button",
        class: "chip",
        text,
        onclick: () => {
          $("what-if-text").value = text;
          ask(text, panel);
        },
      }),
    );
}

async function applyChange({ currentTarget: button }, panel) {
  const { event, changeId, chosen: cuts, raise, useBuffer, onApplied } = panel;
  try {
    await whileBusy(button, "Applying…", async () => {
      const { noticesPosted } = await api.acceptChange(event.id, changeId, {
        cuts,
        raise,
        useBuffer,
      });
      await onApplied(noticesPosted);
    });
  } catch (err) {
    announceError(err.message);
  }
}

/**
 * Wires "Ask Huddle". Nothing changes until the manager applies it.
 * @param {object} event The event.
 * @param {{currentBudget: () => object, onApplied: (notices: number) => Promise<void>}} hooks The
 *   budget on screen, and what to do once the server has applied a change.
 * @returns {{show: (text: string, data: object) => void}} `show` displays any proposed change,
 *   such as accepting a quote, in the same panel.
 */
export function setUpWhatIf(event, { currentBudget, onApplied }) {
  const panel = {
    event,
    currentBudget,
    onApplied,
    result: null,
    changeId: null,
    chosen: [],
    raise: false,
    useBuffer: false,
    nameOf: (id) => currentBudget().categories.find((item) => item.id === id)?.name ?? id,
    mustHaveText: (id) => event.mustHaves.find((item) => item.id === id)?.text ?? id,
  };
  drawSuggestions(panel);
  $("what-if").onsubmit = (e) => {
    e.preventDefault();
    ask($("what-if-text").value.trim(), panel);
  };
  $("result-discard").onclick = () => {
    hideConsequences();
    renderBudget(currentBudget());
    $("what-if-text").focus();
  };
  $("result-apply").onclick = (e) => applyChange(e, panel);
  return { show: (text, data) => show(text, data, panel) };
}
