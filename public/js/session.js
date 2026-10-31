// A slow AI answer may come back after the person has switched to someone else. Each reload bumps
// this counter, and an answer that started under an older one is dropped.
let current = 0;

/** Marks a new view of the app, such as after switching "Viewing as". */
export const bump = () => (current += 1);

/** @returns {number} The counter now, to compare with `isCurrent` once an answer returns. */
export const generation = () => current;

/** @returns {boolean} Whether nothing has changed since `started` was read. */
export const isCurrent = (started) => started === current;
