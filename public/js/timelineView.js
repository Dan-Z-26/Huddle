const monthOf = (iso) =>
  new Date(iso).toLocaleDateString("en-IN", { month: "long", year: "numeric", timeZone: "UTC" });

/**
 * What the flow band shows. Only milestones go on the rail: directive tasks can be many, and they
 * are listed on the Timeline page and in "Needs my attention".
 * @param {object[]} tasks Tasks in date order.
 * @returns {{steps: object[], next: object | null, nextStepId: string | null, progress: string}}
 *   The rail, the next open task of any kind, the rail step to highlight, and the counts.
 */
export function flowOf(tasks) {
  const open = (task) => task.status !== "done";
  const steps = tasks.filter(({ source }) => source === "milestone");
  const done = tasks.length - tasks.filter(open).length;
  const atRisk = tasks.filter((task) => open(task) && task.atRisk).length;
  return {
    steps,
    next: tasks.find(open) ?? null,
    nextStepId: steps.find(open)?.id ?? null,
    progress: `${done} of ${tasks.length} done${atRisk ? `, ${atRisk} at risk` : ""}`,
  };
}

/**
 * Splits tasks into calendar months for the Timeline page.
 * @param {object[]} tasks Tasks in date order.
 * @returns {Array<{label: string, tasks: object[]}>} Months in the same order.
 */
export function groupByMonth(tasks) {
  const groups = [];
  for (const task of tasks) {
    const label = monthOf(task.dueDate);
    if (groups.at(-1)?.label !== label) groups.push({ label, tasks: [] });
    groups.at(-1).tasks.push(task);
  }
  return groups;
}
