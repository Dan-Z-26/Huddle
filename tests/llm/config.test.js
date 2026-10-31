import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolveAgent } from "../../server/llm/config.js";

const KEYS = {
  GEMINI_API_KEY: "g-key",
  GEMINI_FAST_MODEL: "fast-model",
  GEMINI_SMART_MODEL: "smart-model",
};

describe("resolveAgent", () => {
  it("runs in demo mode with no key", () => {
    assert.deepEqual(resolveAgent("budget", {}), { live: false, fallback: null });
  });

  it("runs in demo mode with a key but no model, rather than guessing a model id", () => {
    assert.equal(resolveAgent("budget", { GEMINI_API_KEY: "k" }).live, false);
  });

  it("uses the fast model for intent and wording agents and the smart model for reasoning", () => {
    for (const agent of ["planner", "discovery", "timeline", "notices"]) {
      assert.equal(resolveAgent(agent, KEYS).model, "fast-model", agent);
    }
    for (const agent of ["budget", "vendor", "ideas"]) {
      assert.equal(resolveAgent(agent, KEYS).model, "smart-model", agent);
    }
  });

  it("lets <AGENT>_MODEL override the tier model", () => {
    const route = resolveAgent("budget", { ...KEYS, BUDGET_MODEL: "special" });
    assert.equal(route.model, "special");
    assert.equal(route.provider, "gemini");
  });

  it("lets one agent use another provider", () => {
    const env = {
      ...KEYS,
      ANTHROPIC_API_KEY: "a-key",
      ANTHROPIC_SMART_MODEL: "claude-model",
      VENDOR_PROVIDER: "anthropic",
    };
    const route = resolveAgent("vendor", env);
    assert.deepEqual(
      [route.live, route.provider, route.model, route.apiKey],
      [true, "anthropic", "claude-model", "a-key"],
    );
    assert.equal(resolveAgent("budget", env).provider, "gemini");
  });

  it("goes to demo mode when the chosen provider has no key, even if another does", () => {
    const route = resolveAgent("vendor", { ...KEYS, VENDOR_PROVIDER: "anthropic" });
    assert.equal(route.live, false);
  });

  it("ignores an unknown provider name", () => {
    assert.equal(resolveAgent("budget", { ...KEYS, LLM_PROVIDER: "openai" }).live, false);
  });

  it("offers a fallback only when its key and model exist", () => {
    const withFallback = {
      ...KEYS,
      FALLBACK_PROVIDER: "anthropic",
      ANTHROPIC_API_KEY: "a-key",
      FALLBACK_MODEL: "fb-model",
    };
    assert.deepEqual(resolveAgent("budget", withFallback).fallback, {
      provider: "anthropic",
      model: "fb-model",
      apiKey: "a-key",
    });
    assert.equal(
      resolveAgent("budget", { ...KEYS, FALLBACK_PROVIDER: "anthropic" }).fallback,
      null,
    );
  });
});

describe("resolveAgent: falling back within a provider", () => {
  const ENV = { GEMINI_API_KEY: "k", GEMINI_FAST_MODEL: "fast", GEMINI_SMART_MODEL: "smart" };

  it("uses the other model tier when no second provider is set", () => {
    assert.equal(resolveAgent("budget", ENV).fallback.model, "fast");
    assert.equal(resolveAgent("planner", ENV).fallback.model, "smart");
  });

  it("has no fallback when both tiers are the same model", () => {
    assert.equal(resolveAgent("budget", { ...ENV, GEMINI_FAST_MODEL: "smart" }).fallback, null);
  });
});
