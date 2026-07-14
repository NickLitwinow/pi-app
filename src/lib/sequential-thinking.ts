export interface SequentialThought {
  thought: string;
  thoughtNumber: number;
  totalThoughts: number;
  nextThoughtNeeded: boolean;
  isRevision: boolean;
  revisesThought: number | null;
  branchFromThought: number | null;
  branchId: string | null;
  needsMoreThoughts: boolean;
}

function record(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function parseJsonRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "string") return record(value);
  try {
    return record(JSON.parse(value));
  } catch {
    return null;
  }
}

function number(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(1, Math.floor(value)) : fallback;
}

/** Supports both pi-mcp-adapter proxy calls and prefixed MCP direct tools. */
export function parseSequentialThought(toolName: string, rawArgs: unknown): SequentialThought | null {
  const outer = record(rawArgs);
  if (!outer) return null;
  const normalizedName = toolName.toLowerCase().replace(/[^a-z0-9]/g, "");
  const proxyTarget = typeof outer.tool === "string" ? outer.tool.toLowerCase().replace(/[^a-z0-9]/g, "") : "";
  const direct = normalizedName.includes("sequentialthinking");
  const proxy = normalizedName === "mcp" && proxyTarget.includes("sequentialthinking");
  if (!direct && !proxy) return null;

  const args = proxy ? parseJsonRecord(outer.args) : outer;
  if (!args || typeof args.thought !== "string" || !args.thought.trim()) return null;
  const thoughtNumber = number(args.thoughtNumber, 1);
  const totalThoughts = Math.max(thoughtNumber, number(args.totalThoughts, thoughtNumber));
  return {
    thought: args.thought.trim(),
    thoughtNumber,
    totalThoughts,
    nextThoughtNeeded: args.nextThoughtNeeded === true,
    isRevision: args.isRevision === true,
    revisesThought: typeof args.revisesThought === "number" ? number(args.revisesThought, 1) : null,
    branchFromThought: typeof args.branchFromThought === "number" ? number(args.branchFromThought, 1) : null,
    branchId: typeof args.branchId === "string" && args.branchId.trim() ? args.branchId.trim() : null,
    needsMoreThoughts: args.needsMoreThoughts === true,
  };
}
