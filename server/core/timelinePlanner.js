const MS_PER_DAY = 86400000;

function utcDay(iso) {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) throw new RangeError(`invalid date: ${iso}`);
  return Math.floor(ms / MS_PER_DAY);
}

const isoFromDay = (day) => new Date(day * MS_PER_DAY).toISOString();

function schedule(eventDay, daysBefore, today, isDone) {
  const dueDay = eventDay - daysBefore;
  const isClamped = !isDone && dueDay < today;
  return { dueDate: isoFromDay(isClamped ? today : dueDay), atRisk: isClamped };
}

/**
 * Plans tasks backward from the event date; past due dates clamp to today and flag at risk.
 * @param {string} eventDateIso Event date.
 * @param {Array<{id: string, title: string, daysBefore: number, ownerGroupSlug: string}>}
 *   milestones Template milestones.
 * @param {string} nowIso Current time.
 * @param {Record<string, string>} groupIdBySlug Group ids by slug; unknown slugs give a null owner.
 * @returns {object[]} Tasks.
 */
export function planTimeline(eventDateIso, milestones, nowIso, groupIdBySlug) {
  const eventDay = utcDay(eventDateIso);
  const today = utcDay(nowIso);
  return milestones.map((milestone) => ({
    id: `task-${milestone.id}`,
    title: milestone.title,
    ownerGroupId: groupIdBySlug[milestone.ownerGroupSlug] ?? null,
    ownerUserId: null,
    ...schedule(eventDay, milestone.daysBefore, today, false),
    status: "todo",
    source: "milestone",
    daysBefore: milestone.daysBefore,
  }));
}

/**
 * Refreshes risk flags: done is never at risk, late is at risk, anything else keeps its flag.
 * @param {object[]} tasks Tasks.
 * @param {string} nowIso Current time.
 * @returns {object[]} New tasks with updated atRisk values.
 */
export function flagAtRisk(tasks, nowIso) {
  const today = utcDay(nowIso);
  return tasks.map((task) => {
    if (task.status === "done") return { ...task, atRisk: false };
    return utcDay(task.dueDate) < today ? { ...task, atRisk: true } : { ...task };
  });
}

/**
 * Moves milestone and vendor tasks to a new event date, keeping status and every other task.
 * @param {object[]} tasks Tasks.
 * @param {string} newEventDateIso New event date.
 * @param {string} nowIso Current time.
 * @returns {object[]} Rescheduled tasks with refreshed risk flags.
 */
export function replanTimeline(tasks, newEventDateIso, nowIso) {
  const eventDay = utcDay(newEventDateIso);
  const today = utcDay(nowIso);
  const moved = tasks.map((task) =>
    task.source === "milestone" || task.source === "vendor"
      ? { ...task, ...schedule(eventDay, task.daysBefore, today, task.status === "done") }
      : task,
  );
  return flagAtRisk(moved, nowIso);
}

/**
 * Turns a directive into a timeline task, owned by its addressee when there is exactly one.
 * @param {{id: string, addressedUserIds: string[]}} directive Directive.
 * @param {{title: string, ownerGroupId: string, dueDate: string}} details Task details.
 * @returns {object} Task.
 */
export function taskFromDirective(directive, { title, ownerGroupId, dueDate }) {
  const addressed = directive.addressedUserIds ?? [];
  return {
    id: `task-${directive.id}`,
    title,
    ownerGroupId,
    ownerUserId: addressed.length === 1 ? addressed[0] : null,
    dueDate,
    status: "todo",
    atRisk: false,
    source: "directive",
    daysBefore: null,
  };
}
