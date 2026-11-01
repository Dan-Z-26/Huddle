/** How stored records are named. Ids only name things: every read still checks who is asking. */
import { randomUUID } from "node:crypto";

/** The group everyone is in, and the one where the core team talks budgets. */
export const ANNOUNCEMENTS = "announcements";
export const CORE_TEAM = "core-team";

/**
 * A short random id.
 * @returns {string} Eight hexadecimal characters.
 */
export const shortId = () => randomUUID().slice(0, 8);

/**
 * Makes an id for a new record.
 * @param {string} prefix What kind of record it is.
 * @returns {string} The id.
 */
export const newId = (prefix) => `${prefix}-${shortId()}`;

/**
 * The id of an event's group.
 * @param {string} eventId The event.
 * @param {string} slug The group's slug.
 * @returns {string} The id.
 */
export const groupIdFor = (eventId, slug) => `g-${eventId}-${slug}`;

/**
 * The id of an AI member on an event.
 * @param {string} agent planner, budget, vendor or timeline.
 * @param {string} eventId The event.
 * @returns {string} The id.
 */
export const agentIdFor = (agent, eventId) => `agent-${agent}@${eventId}`;

/**
 * Whether a role id belongs to a booked vendor.
 * @param {string} roleId The role id.
 * @returns {boolean} Whether it does.
 */
export const isVendorRole = (roleId) => roleId.startsWith("vendor-");

/**
 * Whether a role id belongs to an AI member.
 * @param {string} roleId The role id.
 * @returns {boolean} Whether it does.
 */
export const isAgentRole = (roleId) => roleId.startsWith("agent-");
