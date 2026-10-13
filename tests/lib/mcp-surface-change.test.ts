import { describe, expect, it } from "vitest";
import { classifyMcpChange, type RecordedMcpSurface } from "../../scripts/surface-change.ts";

const tool = { name: "read", description: "Read", inputSchema: { type: "object" } };
const mcp: RecordedMcpSurface = { tools: [tool] };

describe("MCP recorded change classification", () => {
  it.each([
    { label: "identical tools", current: mcp, kind: "none" },
    { label: "new tool name", current: { tools: [tool, { ...tool, name: "write" }] }, kind: "additive" },
    { label: "removed tool", current: { tools: [] }, kind: "breaking" },
    { label: "changed description", current: { tools: [{ ...tool, description: "Changed" }] }, kind: "breaking" },
    { label: "extended schema", current: { tools: [{ ...tool, inputSchema: { type: "object", properties: { id: { type: "string" } } } }] }, kind: "breaking" },
    { label: "new entry field", current: { tools: [{ ...tool, extra: true }] }, kind: "breaking" },
    { label: "renamed tool", current: { tools: [{ ...tool, name: "renamed" }] }, kind: "breaking" },
  ])("classifies $label as $kind", ({ current, kind }) => {
    expect(classifyMcpChange(mcp, current).kind).toBe(kind);
  });

  it("compares tools by name and object fields by value", () => {
    expect(classifyMcpChange({ tools: [tool, { ...tool, name: "second" }] }, {
      tools: [{ name: "second", inputSchema: { type: "object" }, description: "Read" }, tool],
    })).toEqual({ kind: "none", reasons: [] });
  });

  it("names removed and changed entries in breaking reasons", () => {
    expect(classifyMcpChange({ tools: [tool, { ...tool, name: "second" }] }, {
      tools: [{ ...tool, description: "Changed" }],
    }).reasons).toEqual(["tool changed: read", "tool removed: second"]);
  });
});
