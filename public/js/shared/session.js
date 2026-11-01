/**
 * A slow AI answer may come back after the person has switched to someone else. Each reload bumps
 * this counter, and an answer that started under an older one is dropped.
 */
let current = 0;

/**
 * Marks a new view of the app, such as after switching person.
 * @returns {number} The new counter.
 */
export const bump = () => (current += 1);

/**
 * The counter now.
 * @returns {number} To compare with `isCurrent` once an answer returns.
 */
export const generation = () => current;

/**
 * Whether nothing has changed since `started` was read.
 * @param {number} started What `generation` gave before the wait.
 * @returns {boolean} True when the answer is still wanted.
 */
export const isCurrent = (started) => started === current;
