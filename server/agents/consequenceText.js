import { wholeMoney } from "../core/money.js";

const range = (low, high, currency) =>
  low === high
    ? wholeMoney(low, currency)
    : `${wholeMoney(low, currency)} to ${wholeMoney(high, currency)}`;

function changeLine(deltas, nameOf, currency) {
  return deltas
    .map(
      (d) =>
        `${nameOf(d.categoryId)}: ${wholeMoney(d.beforeMinor, currency)} to ${wholeMoney(d.afterMinor, currency)}`,
    )
    .join("; ");
}

function optionLine(option, nameOf, mustHaves, currency) {
  const cut = option.atHigh ?? option.atLow;
  const name = nameOf(option.categoryId);
  const rank = option.rank === null ? "not ranked" : `your #${option.rank} priority`;
  const parts = [`If the cut comes from ${name} (${rank}): `];
  if (cut.removedEntirely) parts.push(`${name} is removed entirely.`);
  else {
    parts.push(`${name} drops ${cut.pctDrop}%, to ${wholeMoney(cut.newTotalMinor, currency)}`);
    const changed = cut.tierBefore && cut.tierBefore.id !== cut.tierAfter?.id;
    parts.push(
      changed
        ? `, from the '${cut.tierBefore.label}' level to '${cut.tierAfter?.label ?? "below the lowest level"}'.`
        : ".",
    );
  }
  if (!cut.coversShortfall) parts.push(` This alone does not cover the gap.`);
  for (const id of cut.mustHaveConflicts) {
    const text = mustHaves.find((item) => item.id === id)?.text ?? id;
    parts.push(` This touches your must-have '${text}'.`);
  }
  return parts.join("");
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
  const nameOf = (id) => template.categories.find((category) => category.id === id)?.name ?? id;
  const { shortfall, surplusMinor, deltas, options, increaseBudget } = consequences;
  const lines = [];
  if (deltas.length) lines.push(`Costs change: ${changeLine(deltas, nameOf, currency)}.`);
  if (shortfall.highMinor === 0) {
    lines.push(`You are within budget, with ${wholeMoney(surplusMinor, currency)} to spare.`);
    return lines.join("\n");
  }
  lines.push(`You are ${range(shortfall.lowMinor, shortfall.highMinor, currency)} over budget.`);
  for (const option of options) lines.push(optionLine(option, nameOf, profile.mustHaves, currency));
  if (increaseBudget) {
    lines.push(
      `If the budget increases instead: +${range(increaseBudget.lowMinor, increaseBudget.highMinor, currency)} required.`,
    );
  }
  return lines.join("\n");
}
