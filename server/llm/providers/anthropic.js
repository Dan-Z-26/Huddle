/** The Anthropic adapter: translates one model turn, and nothing else. */
const MAX_TOKENS = 4096;
const clients = new Map();

async function clientFor(apiKey) {
  if (!clients.has(apiKey)) {
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    clients.set(apiKey, new Anthropic({ apiKey }));
  }
  return clients.get(apiKey);
}

const fileBlock = ({ mime, buffer }) => {
  const source = { type: "base64", media_type: mime, data: buffer.toString("base64") };
  return mime === "application/pdf" ? { type: "document", source } : { type: "image", source };
};

/**
 * Converts neutral messages to Anthropic messages.
 * @param {object[]} messages Neutral messages.
 * @param {Array<{mime: string, buffer: Buffer}>} files Files attached to the first user message.
 * @returns {object[]} Anthropic messages.
 */
export function toMessages(messages, files = []) {
  const converted = messages.map((message) => {
    if (message.role === "tool") {
      const content = message.results.map(({ id, result }) => ({
        type: "tool_result",
        tool_use_id: id,
        content: JSON.stringify(result),
      }));
      return { role: "user", content };
    }
    if (message.toolCalls) {
      const content = message.toolCalls.map(({ id, name, args }) => ({
        type: "tool_use",
        id,
        name,
        input: args,
      }));
      return { role: "assistant", content };
    }
    return { role: message.role, content: [{ type: "text", text: message.content }] };
  });
  const first = converted.find(({ role }) => role === "user");
  if (first && files.length > 0) first.content = [...files.map(fileBlock), ...first.content];
  return converted;
}

/**
 * Runs one Anthropic turn. The final JSON shape is requested in the system prompt and checked by
 * the adapter, which keeps this provider as small as the Gemini one.
 * @param {object} request See the contract at the top of server/llm/index.js.
 * @returns {Promise<{text: string, toolCalls: object[]}>} Text and tool calls.
 */
export async function step({ model, apiKey, system, messages, tools, jsonSchema, files, signal }) {
  const client = await clientFor(apiKey);
  const schemaRule = jsonSchema
    ? `\n\nReply with ONLY a JSON object matching this JSON Schema, with no prose and no code fences:\n${JSON.stringify(jsonSchema)}`
    : "";
  const response = await client.messages.create(
    {
      model,
      max_tokens: MAX_TOKENS,
      system: system + schemaRule,
      messages: toMessages(messages, files),
      ...(tools.length > 0 && {
        tools: tools.map(({ name, description, parameters }) => ({
          name,
          description,
          input_schema: parameters,
        })),
      }),
    },
    { signal },
  );
  const toolCalls = response.content
    .filter((block) => block.type === "tool_use")
    .map(({ id, name, input }) => ({ id, name, args: input }));
  const text = response.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");
  return { text, toolCalls };
}
