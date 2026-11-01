/** Writes a change's consequences in plain, neutral words. Options are listed, never recommended. */
import { wholeMoney } from "../core/money.js";
import { categoryName } from "../core/templates.js";

const range = (low, high, currency) =>
  low === high
    ? wholeMoney(low, currency)
    : `${wholeMoney(low, currency)} to ${wholeMoney(high, currency)}`;

function changeLine(deltas, nameOf, currency) {
  return deltas
    .map(
      ({ categoryId, beforeMinor, afterMinor }) =>
        `${nameOf(categoryId)}: ${wholeMoney(beforeMinor, currency)} to ${wholeMoney(afterMinor, currency)}`,
    )
    .join("; ");
}

// What the cut does to the category's level, when it changes it.
function levelChange({ tierBefore, tierAfter }) {
  if (!tierBefore || tierBefore.id === tierAfter?.id) return ".";
  const below = tierAfter?.label ?? "below the lowest level";
  return `, from the '${tierBefore.label}' level to '${below}'.`;
}

function optionLine(option, nameOf, mustHaves, currency) {
  const cut = option.atHigh ?? option.atLow;
  const name = nameOf(option.categoryId);
  const rank = option.rank === null ? "not ranked" : `your #${option.rank} priority`;
  const effect = cut.removedEntirely
    ? `${name} is removed entirely.`
    : `${name} drops ${cut.pctDrop}%, to ${wholeMoney(cut.newTotalMinor, currency)}${levelChange(cut)}`;
  const touched = cut.mustHaveConflicts.map((id) => {
    const text = mustHaves.find((item) => item.id === id)?.text ?? id;
    return ` This touches your must-have '${text}'.`;
  });
  return [
    `If the cut comes from ${name} (${rank}): `,
    effect,
    cut.coversShortfall ? "" : " This alone does not cover the gap.",
    ...touched,
  ].join("");
}

/**
 * Writes the consequences of a change in plain, neutral words, from the exact figures the core
 * engine returned. Options follow the user's priority order and nothing is recommended.
 * @param {object} consequences Result of computeConsequences.
 * @param {{profile: object, template: object, currency: string}} context The profile (must-haves),
 *   the template (category names) and the currency to show.
 * @returns {string} Lines separated by newlines.
 */
export function consequenceText(consequences, { profile, template, currency }) {
  const nameOf = (id) => categoryName(template, id);
  const { shortfall, surplusMinor, deltas, options, increaseBudget, bufferAvailableMinor } =
    consequences;
  const lines = [];
  if (deltas.length) lines.push(`Costs change: ${changeLine(deltas, nameOf, currency)}.`);
  if (shortfall.highMinor === 0) {
    lines.push(`You are within budget, with ${wholeMoney(surplusMinor, currency)} to spare.`);
    return lines.join("\n");
  }
  lines.push(`You are ${range(shortfall.lowMinor, shortfall.highMinor, currency)} over budget.`);
  if (bufferAvailableMinor > 0)
    lines.push(
      `Your contingency buffer holds ${wholeMoney(bufferAvailableMinor, currency)}, which could go towards this.`,
    );
  for (const option of options) lines.push(optionLine(option, nameOf, profile.mustHaves, currency));
  if (increaseBudget) {
    lines.push(
      `If the budget increases instead: +${range(increaseBudget.lowMinor, increaseBudget.highMinor, currency)} required.`,
    );
  }
  return lines.join("\n");
}
