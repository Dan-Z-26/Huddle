/** Keeps model calls under a free-tier key's per-minute limit, because going over fails the call. */
import { MINUTE_MS } from "../core/time.js";

const DEFAULT_PER_MINUTE = 14;
const MAX_PACE_WAIT_MS = 45000;
const callSlots = new Map();

/**
 * Takes the next free slot for a model, waiting for it if this minute's calls are used up.
 * shortcut: counts this process only, so another server on the same key can still hit the limit.
 * @param {string} model The model.
 * @param {Record<string, string | undefined>} env Environment; LLM_MAX_PER_MINUTE sets the rate.
 * @returns {Promise<boolean>} True when the call may go; false when the wait would be too long to be
 *   worth it, so the agent's plain rules can take over.
 */
export async function takeCallSlot(model, env) {
  const perMinute = Number(env.LLM_MAX_PER_MINUTE) || DEFAULT_PER_MINUTE;
  const now = Date.now();
  const slots = (callSlots.get(model) ?? []).filter((at) => at > now - MINUTE_MS);
  const at = slots.length < perMinute ? now : slots[slots.length - perMinute] + MINUTE_MS;
  if (at - now > MAX_PACE_WAIT_MS) return false;
  callSlots.set(model, [...slots, at]);
  if (at > now) await new Promise((done) => setTimeout(done, at - now));
  return true;
}
