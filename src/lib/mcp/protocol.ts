/**
 * Pure JSON-RPC 2.0 framing and MCP method dispatch. Knows nothing about
 * HTTP, sessions, or persistence: the transport layer hands it raw request
 * text and receives either a JSON-RPC response body or null, which the
 * transport maps to HTTP 202 for notifications.
 */

export const MCP_PROTOCOL_VERSION = "2025-06-18";
export const MCP_SERVER_NAME = "overflow";
export const MCP_SERVER_VERSION = "0.1.0";

export interface ToolCallResult {
  content: { type: "text"; text: string }[];
  isError?: boolean;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  call: (args: Record<string, unknown>) => Promise<ToolCallResult>;
}

export interface JsonRpcErrorShape {
  code: number;
  message: string;
  data?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: JsonRpcErrorShape;
}

type DispatchOutcome = { status: 200; body: JsonRpcResponse } | { status: 202 } | null;

export async function dispatchJsonRpc(
  raw: string,
  tools: readonly ToolDefinition[],
): Promise<DispatchOutcome> {
  let message: unknown;
  try {
    message = JSON.parse(raw);
  } catch {
    // Without a parse we cannot recover an id, so the error carries null.
    return respond(null, { code: -32700, message: "Parse error" });
  }

  if (Array.isArray(message)) {
    // Batches are refused outright rather than partially served so a client
    // never mistakes a split response for the whole exchange.
    return respond(null, {
      code: -32600,
      message: "Batch requests are not supported.",
    });
  }

  if (!isObject(message)) {
    return respond(null, { code: -32600, message: "Invalid Request" });
  }

  if (message.jsonrpc !== "2.0") {
    return respond(extractId(message), { code: -32600, message: "Invalid Request" });
  }

  if (typeof message.method !== "string") {
    return respond(extractId(message), { code: -32600, message: "Invalid Request" });
  }

  // A message without an id member is a notification: it gets no response
  // regardless of its method, so unknown ones are silently dropped.
  if (!("id" in message)) {
    return null;
  }

  const id = extractId(message);
  const method = message.method;

  switch (method) {
    case "initialize":
      return respond(id, null, {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
      });
    case "ping":
      return respond(id, null, {});
    case "tools/list":
      return respond(id, null, {
        tools: tools.map(({ name, description, inputSchema }) => ({
          name,
          description,
          inputSchema,
        })),
      });
    case "tools/call": {
      const outcome = await callTool(message.params, tools);
      // A JsonRpcErrorShape always carries code and never content; a tool
      // result is the reverse, so the key test tells the two apart.
      return "code" in outcome ? respond(id, outcome) : respond(id, null, outcome);
    }
  }

  return respond(id, { code: -32601, message: `Method not found: ${method}` });
}

async function callTool(
  params: unknown,
  tools: readonly ToolDefinition[],
): Promise<ToolCallResult | JsonRpcErrorShape> {
  if (!isObject(params)) {
    return { code: -32602, message: "Invalid parameters: params must be an object" };
  }

  const { name } = params;
  if (typeof name !== "string") {
    return { code: -32602, message: "Invalid parameters: name must be a string" };
  }

  const tool = tools.find((candidate) => candidate.name === name);
  if (tool === undefined) {
    return { code: -32602, message: `Invalid parameters: Unknown tool: ${name}` };
  }

  const rawArguments = params.arguments;
  if (rawArguments !== undefined && !isObject(rawArguments)) {
    return { code: -32602, message: "Invalid parameters: arguments must be an object" };
  }

  const args = (rawArguments === undefined ? {} : rawArguments) as Record<string, unknown>;

  try {
    return await tool.call(args);
  } catch (error) {
    // Tool failures stay in-band as tool results rather than transport
    // errors, so a client renders the message instead of a broken pipe.
    return {
      content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
      isError: true,
    };
  }
}

function respond(
  id: string | number | null,
  error: JsonRpcErrorShape | null,
  result?: unknown,
): DispatchOutcome {
  const body: JsonRpcResponse = { jsonrpc: "2.0", id };
  if (error !== null) {
    body.error = error;
  } else {
    body.result = result;
  }
  return { status: 200, body };
}

function extractId(message: Record<string, unknown>): string | number | null {
  const id = message.id;
  return typeof id === "string" || typeof id === "number" ? id : null;
}

// JSON arrays are objects in JavaScript terms, but neither JSON-RPC params
// nor tool arguments accept them, so both checks reject arrays outright.
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
