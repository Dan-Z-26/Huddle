/** Runs an agent's plain rules in place of a model, so everything works with no key and no network. */
import { createToolRunner } from "./toolRunner.js";

/**
 * Runs an agent's deterministic heuristic in place of a model, so the app and its tests work with
 * no API key and no network. The heuristic calls the same tools through the same runner (with the
 * same cap and argument checks), and its output goes through the same schema as a model's.
 * @param {{demo?: Function, schema?: import("zod").ZodType, messages: object[], tools?: object[],
 *   files?: object[]}} request The generate request.
 * @returns {Promise<{data: *, toolCalls: object[], provider: string, model: string, demo: true}>}
 *   The result, shaped like a live one.
 * @throws {Error} When the agent supplied no heuristic.
 */
export async function runDemo({ demo, schema, messages, tools = [], files = [] }) {
  if (typeof demo !== "function") throw new Error("this agent has no demo heuristic");
  const runner = createToolRunner(tools);
  const data = await demo({ messages, files, callTool: runner.run });
  return {
    data: schema ? schema.parse(data) : data,
    toolCalls: runner.calls,
    provider: "demo",
    model: "demo",
    demo: true,
  };
}
