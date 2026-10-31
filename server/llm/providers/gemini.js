const MAX_OUTPUT_TOKENS = 4096;
const clients = new Map();

async function clientFor(apiKey) {
  if (!clients.has(apiKey)) {
    const { GoogleGenAI } = await import("@google/genai");
    clients.set(apiKey, new GoogleGenAI({ apiKey }));
  }
  return clients.get(apiKey);
}

/**
 * Converts neutral messages to Gemini contents. A model turn that made tool calls is replayed from
 * its raw content, because Gemini needs the thought signatures it contains.
 * @param {object[]} messages Neutral messages.
 * @param {Array<{mime: string, buffer: Buffer}>} files Files attached to the first user message.
 * @returns {object[]} Gemini contents.
 */
export function toContents(messages, files = []) {
  const contents = messages.map((message) => {
    if (message.role === "tool") {
      const parts = message.results.map(({ name, result }) => ({
        functionResponse: { name, response: { result } },
      }));
      return { role: "user", parts };
    }
    if (message.toolCalls) {
      const parts = message.toolCalls.map(({ name, args }) => ({ functionCall: { name, args } }));
      return message.raw ?? { role: "model", parts };
    }
    return {
      role: message.role === "assistant" ? "model" : "user",
      parts: [{ text: message.content }],
    };
  });
  const first = contents.find(({ role }) => role === "user");
  if (first && files.length > 0) {
    const attachments = files.map(({ mime, buffer }) => ({
      inlineData: { mimeType: mime, data: buffer.toString("base64") },
    }));
    first.parts = [...attachments, ...first.parts];
  }
  return contents;
}

/**
 * Runs one Gemini turn.
 * @param {object} request See the contract at the top of server/llm/index.js.
 * @returns {Promise<{text: string, toolCalls: object[], raw: object}>} Text and tool calls.
 */
export async function step({ model, apiKey, system, messages, tools, jsonSchema, files, signal }) {
  const ai = await clientFor(apiKey);
  const config = {
    systemInstruction: system,
    maxOutputTokens: MAX_OUTPUT_TOKENS,
    abortSignal: signal,
  };
  if (tools.length > 0) {
    config.tools = [
      {
        functionDeclarations: tools.map(({ name, description, parameters }) => ({
          name,
          description,
          parametersJsonSchema: parameters,
        })),
      },
    ];
  }
  if (jsonSchema) {
    config.responseMimeType = "application/json";
    config.responseJsonSchema = jsonSchema;
  }
  const response = await ai.models.generateContent({
    model,
    contents: toContents(messages, files),
    config,
  });
  const toolCalls = (response.functionCalls ?? []).map((call, index) => ({
    id: call.id ?? `call-${index}`,
    name: call.name,
    args: call.args ?? {},
  }));
  return {
    text: toolCalls.length > 0 ? "" : (response.text ?? ""),
    toolCalls,
    raw: response.candidates?.[0]?.content,
  };
}
