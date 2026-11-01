/** The system prompt every agent shares. */
import { UNTRUSTED_RULE } from "./untrusted.js";

/**
 * Builds an agent's system prompt from the frame every agent shares: private step-by-step
 * reasoning, JSON-only output with a short user-facing rationale, and the untrusted-text rule.
 * @param {{role: string, steps: string[], rules?: string[]}} parts Who the agent is, the steps it
 *   reasons through, and its own rules.
 * @returns {string} The system prompt.
 */
export function agentPrompt({ role, steps, rules = [] }) {
  return [
    role,
    `Work privately in these steps and never show them: ${steps.join(" -> ")}.`,
    ...(rules.length ? ["Rules:", ...rules.map((rule) => `- ${rule}`)] : []),
    "Return ONLY JSON matching the schema, with a one-sentence rationale for the user.",
    UNTRUSTED_RULE,
  ].join("\n");
}
