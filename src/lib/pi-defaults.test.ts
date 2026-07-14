import { describe, expect, it } from "vitest";
import {
  effectiveModel,
  effectiveThinking,
  emptyPiDefaults,
  emptyWorkspaceChat,
  type PiDefaults,
  type WorkspaceChat,
} from "../state/store";

const catalog = [
  { id: "qwen-local", provider: "ollama", contextWindow: 128_000, reasoning: true },
  { id: "claude-sonnet-4", provider: "anthropic", contextWindow: 200_000 },
];

const defaults = (patch: Partial<PiDefaults> = {}): PiDefaults => ({
  ...emptyPiDefaults(),
  provider: "ollama",
  model: "qwen-local",
  thinkingLevel: "minimal",
  catalog,
  ...patch,
});

const ws = (patch: Partial<WorkspaceChat> = {}): WorkspaceChat => ({ ...emptyWorkspaceChat(), ...patch });

describe("effectiveModel — выбор модели до старта агента", () => {
  it("uses pi defaults from models.json before any agent exists", () => {
    // главное: на чистом заходе поле модели не пустое
    expect(effectiveModel(ws(), defaults())).toMatchObject({ id: "qwen-local", provider: "ollama", contextWindow: 128_000 });
  });

  it("prefers the live agent model once it is running", () => {
    const live = ws({ agentState: { model: { id: "claude-sonnet-4", provider: "anthropic" } } });
    expect(effectiveModel(live, defaults())).toMatchObject({ id: "claude-sonnet-4" });
  });

  it("shows the pre-spawn pick over the pi default", () => {
    const picked = ws({ pendingModel: { provider: "anthropic", id: "claude-sonnet-4" } });
    expect(effectiveModel(picked, defaults())).toMatchObject({ id: "claude-sonnet-4", provider: "anthropic", contextWindow: 200_000 });
  });

  it("still resolves a model missing from the catalog", () => {
    const picked = ws({ pendingModel: { provider: "x", id: "unlisted" } });
    expect(effectiveModel(picked, defaults())).toEqual({ id: "unlisted", provider: "x" });
  });

  it("returns null when pi has no default configured", () => {
    expect(effectiveModel(ws(), emptyPiDefaults())).toBeNull();
  });
});

describe("effectiveThinking — уровень до старта агента", () => {
  it("falls back through live → pre-spawn pick → pi default → high", () => {
    expect(effectiveThinking(ws(), defaults())).toBe("minimal");
    expect(effectiveThinking(ws({ pendingThinking: "xhigh" }), defaults())).toBe("xhigh");
    expect(effectiveThinking(ws({ agentState: { thinkingLevel: "low" }, pendingThinking: "xhigh" }), defaults())).toBe("low");
    expect(effectiveThinking(ws(), emptyPiDefaults())).toBe("high");
  });
});
