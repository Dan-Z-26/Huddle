import { z } from "zod";
import { resolveAgent } from "./config.js";
import { runDemo } from "./demo.js";
import { createToolRunner } from "./toolRunner.js";

export { wrapUntrusted, UNTRUSTED_RULE } from "./untrusted.js";

/*
 * Two stages per request, because a model cannot be relied on to call tools and also answer in a
 * fixed JSON shape in one request: (1) a tool turn without a schema, at most MAX_TOOL_CALLS calls,
 * then (2) one final turn with the schema and no tools. Providers only translate one step:
 *   step({ model, apiKey, system, messages, tools, jsonSchema, files, signal }) -> { text, toolCalls, raw }
 * Neutral messages: { role: "user" | "assistant", content } | { role: "assistant", toolCalls, raw }
 * | { role: "tool", results: [{ id, name, result }] }. Tools are [{ name, description, parameters }].
 */
const LOADERS = {
  gemini: () => import("./providers/gemini.js"),
  anthropic: () => import("./providers/anthropic.js"),
};
const DEFAULT_TIMEOUT_MS = 30000;

/**
 * Builds the error thrown when a model call fails or keeps returning invalid output.
 * @param {string} message Safe description; never include prompt or response text.
 * @param {{status?: number, cause?: unknown}} [details] Extra context.
 * @returns {Error} The error, named "LlmError".
 */
export function LlmError(message, { status, cause } = {}) {
  return Object.assign(new Error(message), { name: "LlmError", status, cause });
}

function toJsonSchema(schema) {
  const json = z.toJSONSchema(schema);
  delete json.$schema;
  return json;
}

function parseJson(text) {
  if (typeof text !== "string") return undefined;
  try {
    return JSON.parse(text.trim().replace(/^```(?:json)?\s*|\s*```$/g, ""));
  } catch {
    return undefined;
  }
}

const isRetryable = (err) =>
  err?.status === 429 || err?.status >= 500 || err?.name === "TimeoutError";

async function finalAnswer({ call, history, schema, jsonSchema }) {
  let problem = "";
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const hint = problem
      ? [
          {
            role: "user",
            content: `Your last reply was invalid (${problem}). Reply with only JSON that matches the schema.`,
          },
        ]
      : [];
    const { text } = await call({ messages: [...history, ...hint], tools: [], jsonSchema });
    const parsed = schema ? parseJson(text) : text;
    if (!schema) return parsed;
    const result = schema.safeParse(parsed);
    if (result.success) return result.data;
    problem =
      parsed === undefined ? "not JSON" : `bad field ${result.error.issues[0].path.join(".")}`;
  }
  throw LlmError("model output failed validation twice");
}

async function toolStage({ call, history, runner }) {
  while (runner.remaining() > 0) {
    const step = await call({ messages: history });
    if (!step.toolCalls?.length) {
      if (step.text) history.push({ role: "assistant", content: step.text });
      return;
    }
    const calls = step.toolCalls.slice(0, runner.remaining());
    history.push({ role: "assistant", toolCalls: calls, raw: step.raw });
    const results = [];
    for (const toolCall of calls) {
      results.push({ id: toolCall.id, name: toolCall.name, result: await runner.run(toolCall) });
    }
    history.push({ role: "tool", results });
  }
}

async function runLive(request, target, providers) {
  const { system, messages, schema, tools = [], files = [], env = process.env } = request;
  const provider = providers[target.provider] ?? (await LOADERS[target.provider]());
  const timeoutMs = Number(env.LLM_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS;
  const declared = tools.map(({ name, description, parameters }) => ({
    name,
    description,
    parameters: toJsonSchema(parameters),
  }));
  const call = (extra) =>
    provider.step({
      model: target.model,
      apiKey: target.apiKey,
      system,
      files,
      tools: declared,
      signal: AbortSignal.timeout(timeoutMs),
      ...extra,
    });

  const history = [...messages];
  const runner = createToolRunner(tools);
  if (tools.length) await toolStage({ call, history, runner });
  const jsonSchema = schema ? toJsonSchema(schema) : undefined;
  const data = await finalAnswer({ call, history, schema, jsonSchema });
  return {
    data,
    toolCalls: runner.calls,
    provider: target.provider,
    model: target.model,
    demo: false,
  };
}

/**
 * Asks a model (or, with no key, the agent's demo heuristic) for a validated answer.
 * @param {object} request
 * @param {string} request.agent Agent name; picks the provider and model from env.
 * @param {string} request.system System prompt.
 * @param {Array<object>} request.messages Conversation so far.
 * @param {import("zod").ZodType} [request.schema] Shape of the final answer, validated before use.
 * @param {Array<{name: string, description: string, parameters: import("zod").ZodType,
 *   handler: Function}>} [request.tools] Tools the model may call, at most 4 times.
 * @param {Array<{mime: string, buffer: Buffer, name: string}>} [request.files] Files to read.
 * @param {Function} [request.demo] The agent's offline heuristic, used when no key is set.
 * @param {Record<string, string | undefined>} [request.env] Environment, for tests.
 * @param {object} [request.providers] Provider modules by name, for tests.
 * @returns {Promise<{data: *, toolCalls: object[], provider: string, model: string, demo: boolean}>}
 *   The validated answer and the tool calls made.
 * @throws {Error} LlmError when the model fails or keeps returning invalid output.
 */
export async function generate(request) {
  const { agent, env = process.env, providers = {} } = request;
  const route = resolveAgent(agent, env);
  if (!route.live) return runDemo(request);
  try {
    return await runLive(request, route, providers);
  } catch (err) {
    if (route.fallback && isRetryable(err)) {
      return runLive(request, route.fallback, providers).catch((second) => {
        throw LlmError("model call failed on the primary and fallback providers", {
          status: second?.status,
        });
      });
    }
    if (err.name === "LlmError") throw err;
    throw LlmError("model call failed", { status: err?.status });
  }
}
