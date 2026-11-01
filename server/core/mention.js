/** The @huddle mention, which is what brings the Planner into a room. */
const MENTION = /@huddle\b/gi;

/**
 * Whether a message calls the Planner.
 * @param {string} text The message.
 * @returns {boolean} Whether it mentions @huddle.
 */
export const mentionsHuddle = (text) => text.search(MENTION) !== -1;

/**
 * A message without the mention, which is what the Planner reads.
 * @param {string} text The message.
 * @returns {string} The rest of it.
 */
export const withoutMention = (text) => text.replaceAll(MENTION, "");
