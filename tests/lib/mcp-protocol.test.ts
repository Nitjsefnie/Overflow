import { describe, expect, it } from "vitest";
import {
  dispatchJsonRpc,
  type ToolDefinition,
} from "@/lib/mcp/protocol";

const echoTool: ToolDefinition = {
  name: "echo",
  description: "Echoes its input back as text.",
  inputSchema: { type: "object", properties: { value: { type: "string" } } },
  async call(args) {
    return { content: [{ type: "text", text: `echo:${String(args.value)}` }] };
  },
};

const boomTool: ToolDefinition = {
  name: "boom",
  description: "Always throws.",
  inputSchema: { type: "object" },
  async call() {
    throw new Error("kaboom");
  },
};

const tools = [echoTool, boomTool] as const;

function rpc(id: number | string, method: string, params?: object): string {
  return JSON.stringify({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) });
}

describe("dispatchJsonRpc framing", () => {
  it("parses and dispatches a valid single request", async () => {
    const response = await dispatchJsonRpc(rpc(1, "ping"), tools);
    expect(response).toEqual({
      status: 200,
      body: { jsonrpc: "2.0", id: 1, result: {} },
    });
  });

  it("answers unparseable text with a parse error and null id", async () => {
    const response = await dispatchJsonRpc("not json", tools);
    expect(response).toEqual({
      status: 200,
      body: {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "Parse error" },
      },
    });
  });

  it("rejects a top-level array as an unsupported batch", async () => {
    const response = await dispatchJsonRpc("[1,2]", tools);
    expect(response).toEqual({
      status: 200,
      body: {
        jsonrpc: "2.0",
        id: null,
        error: {
          code: -32600,
          message: "Batch requests are not supported.",
        },
      },
    });
  });

  it("rejects a request whose jsonrpc field is missing or wrong", async () => {
    for (const raw of [
      JSON.stringify({ id: 1, method: "ping" }),
      JSON.stringify({ jsonrpc: "1.0", id: 1, method: "ping" }),
    ]) {
      const response = await dispatchJsonRpc(raw, tools);
      expect(response).toMatchObject({
        status: 200,
        body: { id: 1, error: { code: -32600, message: "Invalid Request" } },
      });
    }
  });

  it("rejects a request whose method is missing or not a string", async () => {
    for (const raw of [
      JSON.stringify({ jsonrpc: "2.0", id: 1 }),
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: 42 }),
    ]) {
      const response = await dispatchJsonRpc(raw, tools);
      expect(response).toMatchObject({
        status: 200,
        body: { id: 1, error: { code: -32600, message: "Invalid Request" } },
      });
    }
  });
});

describe("dispatchJsonRpc methods", () => {
  it("answers initialize with the pinned server metadata", async () => {
    const response = await dispatchJsonRpc(rpc(2, "initialize"), tools);
    expect(response).toEqual({
      status: 200,
      body: {
        jsonrpc: "2.0",
        id: 2,
        result: {
          protocolVersion: "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "overflow", version: "0.1.0" },
        },
      },
    });
  });

  it("answers ping with an empty result", async () => {
    const response = await dispatchJsonRpc(rpc("a", "ping"), tools);
    expect(response).toEqual({
      status: 200,
      body: { jsonrpc: "2.0", id: "a", result: {} },
    });
  });

  it("returns null for notifications, known and unknown", async () => {
    expect(await dispatchJsonRpc(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }), tools)).toBeNull();
    expect(await dispatchJsonRpc(JSON.stringify({ jsonrpc: "2.0", method: "some/unknown-notification" }), tools)).toBeNull();
  });

  it("answers an unknown method with method-not-found naming it", async () => {
    const response = await dispatchJsonRpc(rpc(3, "frobnicate"), tools);
    expect(response).toEqual({
      status: 200,
      body: {
        jsonrpc: "2.0",
        id: 3,
        error: { code: -32601, message: "Method not found: frobnicate" },
      },
    });
  });

  it("lists the registered tools with their names, descriptions and schemas", async () => {
    const response = await dispatchJsonRpc(rpc(4, "tools/list"), tools);
    expect(response).toEqual({
      status: 200,
      body: {
        jsonrpc: "2.0",
        id: 4,
        result: {
          tools: [
            {
              name: "echo",
              description: "Echoes its input back as text.",
              inputSchema: { type: "object", properties: { value: { type: "string" } } },
            },
            {
              name: "boom",
              description: "Always throws.",
              inputSchema: { type: "object" },
            },
          ],
        },
      },
    });
  });
});

describe("dispatchJsonRpc tools/call", () => {
  it("rejects an unknown tool name with invalid-parameters", async () => {
    const response = await dispatchJsonRpc(rpc(5, "tools/call", { name: "nope" }), tools);
    expect(response).toMatchObject({
      status: 200,
      body: { id: 5, error: { code: -32602, message: "Invalid parameters: Unknown tool: nope" } },
    });
  });

  it("rejects a non-string or missing tool name with invalid-parameters", async () => {
    for (const [index, params] of [undefined, { name: 42 }, {}].entries()) {
      const raw = params === undefined ? rpc(6, "tools/call") : rpc(6, "tools/call", params);
      const response = await dispatchJsonRpc(raw, tools);
      const message =
        index === 0
          ? "Invalid parameters: params must be an object"
          : "Invalid parameters: name must be a string";
      expect(response).toMatchObject({
        status: 200,
        body: { id: 6, error: { code: -32602, message } },
      });
    }
  });

  it("rejects non-object arguments and passes {} when arguments are omitted", async () => {
    for (const arguments_ of ["nope", 7, null, [1, 2]]) {
      const response = await dispatchJsonRpc(
        rpc(7, "tools/call", { name: "echo", arguments: arguments_ }),
        tools,
      );
      expect(response).toMatchObject({
        status: 200,
        body: { id: 7, error: { code: -32602, message: "Invalid parameters: arguments must be an object" } },
      });
    }

    const called: unknown[] = [];
    const probe: ToolDefinition = {
      ...echoTool,
      name: "probe",
      async call(args) {
        called.push(args);
        return { content: [{ type: "text", text: "ok" }] };
      },
    };
    await dispatchJsonRpc(rpc(8, "tools/call", { name: "probe" }), [probe]);
    expect(called).toEqual([{}]);
  });

  it("maps a throwing tool to an isError result carrying the message", async () => {
    const response = await dispatchJsonRpc(rpc(9, "tools/call", { name: "boom" }), tools);
    expect(response).toEqual({
      status: 200,
      body: {
        jsonrpc: "2.0",
        id: 9,
        result: { content: [{ type: "text", text: "kaboom" }], isError: true },
      },
    });
  });

  it("returns the tool's mapped content on the happy path", async () => {
    const response = await dispatchJsonRpc(
      rpc(10, "tools/call", { name: "echo", arguments: { value: "hi" } }),
      tools,
    );
    expect(response).toEqual({
      status: 200,
      body: {
        jsonrpc: "2.0",
        id: 10,
        result: { content: [{ type: "text", text: "echo:hi" }] },
      },
    });
  });
});
