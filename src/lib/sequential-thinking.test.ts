import { describe, expect, it } from "vitest";
import { parseSequentialThought } from "./sequential-thinking";

describe("parseSequentialThought", () => {
  it("parses pi-mcp-adapter proxy calls", () => {
    expect(parseSequentialThought("mcp", {
      tool: "sequential-thinking_sequentialthinking",
      args: JSON.stringify({ thought: "Compare both designs", thoughtNumber: 3, totalThoughts: 7, nextThoughtNeeded: true }),
    })).toMatchObject({ thought: "Compare both designs", thoughtNumber: 3, totalThoughts: 7, nextThoughtNeeded: true });
  });

  it("parses prefixed direct tools and revision metadata", () => {
    expect(parseSequentialThought("sequential_thinking_sequentialthinking", {
      thought: "The earlier assumption was wrong",
      thoughtNumber: 5,
      totalThoughts: 4,
      nextThoughtNeeded: false,
      isRevision: true,
      revisesThought: 2,
      branchFromThought: 3,
      branchId: "alternative",
    })).toEqual({
      thought: "The earlier assumption was wrong",
      thoughtNumber: 5,
      totalThoughts: 5,
      nextThoughtNeeded: false,
      isRevision: true,
      revisesThought: 2,
      branchFromThought: 3,
      branchId: "alternative",
      needsMoreThoughts: false,
    });
  });

  it("ignores ordinary MCP calls and malformed arguments", () => {
    expect(parseSequentialThought("mcp", { tool: "context7_get-library-docs", args: "{}" })).toBeNull();
    expect(parseSequentialThought("mcp", { tool: "sequentialthinking", args: "not json" })).toBeNull();
  });
});
