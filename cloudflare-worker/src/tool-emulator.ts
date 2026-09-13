export interface ToolDefinition {
  type: string;
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, any>;
  };
}

// กำหนด Schema สำหรับ 4 tools หลักหาก Client ไม่ได้ส่ง parameters ละเอียดมา
export const SUPPORTED_TOOLS: Record<string, ToolDefinition> = {
  terminal: {
    type: "function",
    function: {
      name: "terminal",
      description: "Execute a shell command in the local environment",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "The command line to execute" }
        },
        required: ["command"]
      }
    }
  },
  git: {
    type: "function",
    function: {
      name: "git",
      description: "Execute git operations (status, diff, add, commit, push)",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "Git subcommand and arguments, e.g. 'status' or 'commit -m ...'" }
        },
        required: ["command"]
      }
    }
  },
  read_file: {
    type: "function",
    function: {
      name: "read_file",
      description: "Read content of a file from disk",
      parameters: {
        type: "object",
        properties: {
          file_path: { type: "string", description: "Absolute path to the file" }
        },
        required: ["file_path"]
      }
    }
  },
  write_file: {
    type: "function",
    function: {
      name: "write_file",
      description: "Write content to a file",
      parameters: {
        type: "object",
        properties: {
          file_path: { type: "string", description: "Absolute path to the file" },
          content: { type: "string", description: "Content to write" }
        },
        required: ["file_path", "content"]
      }
    }
  }
};

/**
 * 1. ตรวจสอบและดึง Tools จาก Header หรือ Request Body
 */
export function extractTools(request: Request | { headers?: any }, body: any): ToolDefinition[] {
  if (body?.tools !== undefined) {
    if (!Array.isArray(body.tools)) throw new Error("tools must be an array");
    return body.tools;
  }
  let headerTools: string | null = null;
  if (request && "headers" in request) {
    if (typeof request.headers?.get === "function") {
      headerTools = request.headers.get("x-hermes-tools");
    } else if (request.headers && typeof request.headers === "object") {
      headerTools = request.headers["x-hermes-tools"] || request.headers["X-Hermes-Tools"] || null;
    }
  }

  if (headerTools) {
    try {
      const parsed = JSON.parse(headerTools);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      // หากส่งเป็น comma-separated เช่น "terminal,git,read_file,write_file"
      return headerTools
        .split(",")
        .map(t => t.trim())
        .filter(Boolean)
        .map(t => SUPPORTED_TOOLS[t] || {
          type: "function",
          function: {
            name: t,
            description: `Execute tool ${t}`,
            parameters: { type: "object", properties: {} }
          }
        });
    }
  }

  if (body?.tools && Array.isArray(body.tools)) {
    return body.tools;
  }

  return [];
}

/**
 * 2. สร้าง Prompt Injection สำหรับบอกให้ Gemini รู้จักและเรียกใช้ Tools
 */
export function buildToolSystemPrompt(tools: ToolDefinition[]): string {
  if (!tools || tools.length === 0) return "";

  const toolSchemas = tools.map(t => JSON.stringify(t.function, null, 2)).join("\n");

  return `
# CLIENT TOOL-CALL PROTOCOL
The client application can execute the functions below. You do not execute them
yourself and do not have direct access to a terminal or local files. Your task is
to return a structured function request for the client to validate and execute.
Available client functions:
${toolSchemas}

CRITICAL EXECUTION RULES:
1. When an available function is needed, return a function request using the format below.
2. A function request is text for the client, not a claim that you executed anything.
3. Wait for the client to supply a tool result before reporting successful execution.
4. When invoking a tool, you MUST format your output strictly as:
<tool_call>
{"name": "tool_name", "arguments": {"arg1": "value1"}}
</tool_call>
5. Do not wrap the <tool_call> tag in markdown codeblocks.
6. If no tool execution is required, respond with standard conversational text.
`;
}

// Buffer each completion so malformed later calls cannot partially execute a batch.
export function resolveToolPolicy(request: Request, body: any) {
  const tools = extractTools(request, body);
  if (!tools.every(t => t?.type === "function" && typeof t.function?.name === "string" && t.function.name)) {
    throw new Error("tools must contain named function definitions");
  }
  const choice = body.tool_choice ?? "auto";
  const forced = typeof choice === "object" && choice?.type === "function" ? choice.function?.name : undefined;
  if (!["auto", "none", "required"].includes(choice) && !forced) throw new Error("Invalid tool_choice");
  if (forced && !tools.some(t => t.function.name === forced)) throw new Error("Unknown forced tool");
  if (choice === "required" && !tools.length) throw new Error("tool_choice required needs tools");
  return { tools: choice === "none" ? [] : forced ? tools.filter(t => t.function.name === forced) : tools,
    required: choice === "required" || Boolean(forced), parallel: body.parallel_tool_calls !== false };
}

type Policy = { tools: ToolDefinition[]; required: boolean; parallel: boolean };

// Common JSON Schema constraints used by tool definitions. Execution remains Hermes' responsibility.
function validate(value: any, schema: any, path = "arguments") {
  if (!schema || schema === true) return;
  if (schema === false) throw new Error(`${path} is forbidden`);
  const types = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
  const matches = (t: string) => t === "object" ? value !== null && typeof value === "object" && !Array.isArray(value)
    : t === "array" ? Array.isArray(value) : t === "integer" ? Number.isInteger(value)
    : t === "null" ? value === null : typeof value === t;
  if (types.length && !types.some(matches)) throw new Error(`${path}: invalid type`);
  if (schema.enum && !schema.enum.some((v: any) => JSON.stringify(v) === JSON.stringify(value))) throw new Error(`${path}: invalid enum`);
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const key of schema.required || []) if (!Object.hasOwn(value, key)) throw new Error(`${path}.${key} is required`);
    for (const [key, child] of Object.entries(value)) {
      if (Object.hasOwn(schema.properties || {}, key)) validate(child, schema.properties[key], `${path}.${key}`);
      else if (schema.additionalProperties !== undefined) validate(child, schema.additionalProperties, `${path}.${key}`);
    }
  }
  if (Array.isArray(value) && schema.items) value.forEach((v, i) => validate(v, schema.items, `${path}[${i}]`));
}

export function parseToolCompletion(text: string, policy: Policy) {
  const calls: any[] = [];
  let content = text;
  if (policy.tools.length) {
    content = text.replace(/<tool_call>([\s\S]*?)<\/tool_call>/g, (_match, raw) => {
      const parsed = JSON.parse(raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, ""));
      const name = parsed.name ?? parsed.function?.name ?? parsed.tool;
      const tool = policy.tools.find(t => t.function.name === name);
      if (!tool) throw new Error(`Unknown or disallowed tool: ${name}`);
      const rawArgs = parsed.arguments ?? parsed.function?.arguments ?? parsed.parameters ?? {};
      const args = typeof rawArgs === "string" ? JSON.parse(rawArgs) : rawArgs;
      if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("Tool arguments must be an object");
      validate(args, tool.function.parameters);
      calls.push({ id: `call_${crypto.randomUUID()}`, type: "function", function: { name, arguments: JSON.stringify(args) } });
      return "";
    });
    if (content.includes("<tool_call>") || content.includes("</tool_call>")) throw new Error("Incomplete tool call");
  }
  if (policy.required && !calls.length) throw new Error("Model did not produce the required tool call");
  if (!policy.parallel && calls.length > 1) throw new Error("Parallel tool calls are disabled");
  return { message: { role: "assistant", content: content || (calls.length ? null : ""), ...(calls.length ? { tool_calls: calls } : {}) },
    finishReason: calls.length ? "tool_calls" : "stop" };
}

export function createToolCallTransformer(id: string, model: string, policy: Policy): TransformStream<string, string> {
  let text = "";
  return new TransformStream({
    transform(chunk) { text += chunk; },
    flush(controller) {
      try {
        const { message, finishReason } = parseToolCompletion(text, policy);
        const emit = (delta: any, finish_reason: string | null = null) => controller.enqueue(`data: ${JSON.stringify({
          id, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model,
          choices: [{ index: 0, delta, finish_reason }]
        })}\n\n`);
        emit({ role: "assistant" });
        if (message.content) emit({ content: message.content });
        message.tool_calls?.forEach((call: any, index: number) => emit({ tool_calls: [{ ...call, index }] }));
        emit({}, finishReason);
      } catch (err: any) {
        controller.enqueue(`data: ${JSON.stringify({ error: { message: err.message, type: "server_error", code: "invalid_tool_response" } })}\n\n`);
      }
      controller.enqueue("data: [DONE]\n\n");
    }
  });
}
