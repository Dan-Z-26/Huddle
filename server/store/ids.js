import { randomUUID } from "node:crypto";

/**
 * Makes an id for a stored record. Ids only name things: every read still checks who is asking.
 * @param {string} prefix What kind of record it is.
 * @returns {string} The id.
 */
export const newId = (prefix) => `${prefix}-${randomUUID().slice(0, 8)}`;
