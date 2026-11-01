/** Which provider and model each agent uses, from environment variables only. */
const KEY_VARS = { gemini: "GEMINI_API_KEY", anthropic: "ANTHROPIC_API_KEY" };
// Small fast models for intent and wording; stronger ones for budget and vendor reasoning.
const FAST_AGENTS = new Set(["PLANNER", "DISCOVERY", "TIMELINE", "NOTICES"]);

function target(provider, model, env) {
  const keyVar = KEY_VARS[provider];
  const apiKey = keyVar ? env[keyVar] : undefined;
  return apiKey && model ? { provider, model, apiKey } : null;
}

/**
 * Works out which provider and model an agent uses, from environment variables only.
 * Model ids are never hard-coded: set `<AGENT>_MODEL`, or `<PROVIDER>_FAST_MODEL` and
 * `<PROVIDER>_SMART_MODEL`. An agent without a usable key and model runs in demo mode.
 * @param {string} agent Agent name, such as "budget".
 * @param {Record<string, string | undefined>} [env] Environment variables.
 * @returns {{live: boolean, provider?: string, model?: string, apiKey?: string,
 *   fallback: {provider: string, model: string, apiKey: string} | null}} The route to take.
 */
export function resolveAgent(agent, env = process.env) {
  const name = agent.toUpperCase();
  const tier = FAST_AGENTS.has(name) ? "FAST" : "SMART";
  const tierModel = (provider) => env[`${provider.toUpperCase()}_${tier}_MODEL`];

  const provider = (env[`${name}_PROVIDER`] || env.LLM_PROVIDER || "gemini").toLowerCase();
  const primary = target(provider, env[`${name}_MODEL`] || tierModel(provider), env);

  const fallbackProvider = env.FALLBACK_PROVIDER?.toLowerCase();
  // With no second provider, the provider's other model tier: one model can be overloaded while
  // the other is fine, and a busy model should not push the app onto its offline rules.
  const otherTier = env[`${provider.toUpperCase()}_${tier === "FAST" ? "SMART" : "FAST"}_MODEL`];
  const hasOtherTier = primary && otherTier && otherTier !== primary.model;
  const secondProvider = () =>
    target(fallbackProvider, env.FALLBACK_MODEL || tierModel(fallbackProvider), env);
  const otherTierTarget = () => (hasOtherTier ? target(provider, otherTier, env) : null);
  const fallback = fallbackProvider ? secondProvider() : otherTierTarget();

  return primary ? { live: true, ...primary, fallback } : { live: false, fallback: null };
}
