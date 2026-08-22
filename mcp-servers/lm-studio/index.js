import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod/v4-mini";

const LM_STUDIO_URL = process.env.LM_STUDIO_URL || "http://localhost:1234";
const MODEL = process.env.LM_STUDIO_MODEL || "mistralai/ministral-3-3b";

async function callLMStudio(messages, options = {}) {
  const body = {
    model: MODEL,
    messages,
    temperature: options.temperature ?? 0.2,
    max_tokens: options.max_tokens ?? 2048,
    ...options.extra,
  };

  const res = await fetch(`${LM_STUDIO_URL}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`LM Studio error ${res.status}: ${err}`);
  }

  return res.json();
}

// Calls LM Studio requesting JSON output.
// Order: json_schema (works on ministral-3-3b) → json_object (legacy) → text fallback.
// Each failed attempt is caught and the next format is tried — no wasted retries on success.
async function callLMStudioJSON(messages, temperature = 0.1) {
  const formats = [
    { type: "json_schema", json_schema: { name: "output", strict: false, schema: { type: "object" } } },
    { type: "json_object" },
    null, // prompt-only fallback: model must produce JSON via system instruction
  ];

  for (const fmt of formats) {
    const extra = fmt ? { response_format: fmt } : {};
    const body = {
      model: MODEL,
      messages,
      temperature,
      max_tokens: 2048,
      ...extra,
    };

    const res = await fetch(`${LM_STUDIO_URL}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const err = await res.text();
      // 4xx format errors → try next mode; other errors are fatal
      if ((res.status === 400 || res.status === 422) && fmt !== null) continue;
      throw new Error(`LM Studio error ${res.status}: ${err}`);
    }

    const data = await res.json();
    const raw = data.choices[0].message.content ?? "";

    // Strip markdown code fences that text-mode models often add
    const stripped = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/m, "").trim();

    try {
      return JSON.parse(stripped);
    } catch {
      // Structured mode returned bad JSON → try next format
      if (fmt !== null) continue;
      throw new Error(`Model returned invalid JSON: ${stripped.slice(0, 200)}`);
    }
  }

  throw new Error("All response_format modes failed");
}

const server = new McpServer({ name: "lm-studio", version: "1.0.0" });

server.registerTool("ask_expert", {
  description: "Ask Mistral 3B a question and get a detailed answer. Use for analysis, explanations, code review, second opinions.",
  inputSchema: {
    prompt: z.string(),
    system: z.optional(z.string()),
  },
}, async ({ prompt, system }) => {
  const messages = [];
  if (system) messages.push({ role: "system", content: system });
  messages.push({ role: "user", content: prompt });

  const data = await callLMStudio(messages);
  const answer = data.choices[0].message.content;

  return { content: [{ type: "text", text: answer }] };
});

server.registerTool("generate_json", {
  description: "Generate structured JSON output from Mistral 3B. Tries json_schema → json_object → text fallback automatically.",
  inputSchema: {
    prompt: z.string(),
    schema_description: z.string(),
    system: z.optional(z.string()),
  },
}, async ({ prompt, schema_description, system }) => {
  const systemPrompt =
    `You are a JSON generator. Respond with valid JSON only — no markdown fences, no explanation, no text before or after the JSON object.\n` +
    `Required schema: ${schema_description}\n` +
    (system ?? "");

  const messages = [
    { role: "system", content: systemPrompt },
    { role: "user", content: prompt },
  ];

  const parsed = await callLMStudioJSON(messages, 0.1);

  return { content: [{ type: "text", text: JSON.stringify(parsed, null, 2) }] };
});

server.registerTool("function_call", {
  description: "Call Mistral 3B with native function calling. Model will choose which tool(s) to invoke and return structured tool_calls.",
  inputSchema: {
    prompt: z.string(),
    tools: z.array(z.object({
      name: z.string(),
      description: z.string(),
      parameters: z.unknown(),
    })),
    system: z.optional(z.string()),
  },
}, async ({ prompt, tools, system }) => {
  const messages = [];
  if (system) messages.push({ role: "system", content: system });
  messages.push({ role: "user", content: prompt });

  const openaiTools = tools.map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));

  const data = await callLMStudio(messages, {
    extra: { tools: openaiTools, tool_choice: "auto" },
  });

  const choice = data.choices[0];
  const toolCalls = choice.message.tool_calls ?? [];
  const textContent = choice.message.content ?? "";

  const result = {
    finish_reason: choice.finish_reason,
    text: textContent,
    tool_calls: toolCalls.map((tc) => ({
      id: tc.id,
      name: tc.function.name,
      arguments: (() => {
        try {
          return JSON.parse(tc.function.arguments);
        } catch {
          return tc.function.arguments;
        }
      })(),
    })),
  };

  return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
});

const transport = new StdioServerTransport();
await server.connect(transport);
