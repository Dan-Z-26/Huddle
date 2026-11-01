/** Runs the tools a model asks for, with a hard cap per turn. */
const MAX_TOOL_CALLS = 4;

const shortMessage = (err) => String(err?.message ?? "tool failed").slice(0, 200);

/**
 * Runs the tools a model (or a demo heuristic) asks for, with a hard cap per turn. Arguments are
 * checked against each tool's zod schema, and a failing tool returns an error result instead of
 * throwing, so the model can recover.
 * @param {Array<{name: string, parameters: import("zod").ZodType, handler: Function}>} tools Tools.
 * @param {number} [max] Most calls allowed.
 * @returns {{calls: Array<{name: string, args: object, result: *}>, remaining: () => number,
 *   run: (call: {name: string, args?: object}) => Promise<*>}} The runner and its call log.
 */
export function createToolRunner(tools, max = MAX_TOOL_CALLS) {
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  const calls = [];
  let attempts = 0;

  async function run({ name, args = {} }) {
    // Every attempt counts, including unknown tool names, so a looping model cannot run forever.
    if (attempts >= max) return { error: "tool call limit reached" };
    attempts += 1;
    const tool = byName.get(name);
    if (!tool) return { error: "unknown tool" };
    const parsed = tool.parameters.safeParse(args);
    let result;
    if (!parsed.success) result = { error: "invalid arguments" };
    else {
      try {
        result = await tool.handler(parsed.data);
      } catch (err) {
        result = { error: shortMessage(err) };
      }
    }
    calls.push({ name, args, result });
    return result;
  }

  return { calls, remaining: () => max - attempts, run };
}
