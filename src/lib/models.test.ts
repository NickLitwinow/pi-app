import { describe, expect, it } from "vitest";
import { modelAliasKey, modelDisplayName, modelForProvider, modelIdDisplayName, providerDraftError } from "./models";

describe("model display aliases", () => {
  it("keeps runtime identity separate from the display name", () => {
    const id = "Qwen3.6-35B-A3B-Claude-4.7-Opus-Reasoning-Distilled-oQ4e-mtp";
    const aliases = { [modelAliasKey("omlx", id)]: "Claude Opus 4.7" };
    expect(modelDisplayName({ provider: "omlx", id }, aliases)).toBe("Claude Opus 4.7");
    expect(modelIdDisplayName(id, aliases)).toBe("Claude Opus 4.7");
    expect(modelAliasKey("omlx", id)).toContain(id);
  });

  it("falls back to provider name and then model id", () => {
    expect(modelDisplayName({ provider: "x", id: "raw", name: "Friendly" }, {})).toBe("Friendly");
    expect(modelDisplayName({ provider: "x", id: "raw" }, {})).toBe("raw");
  });
});

describe("custom provider validation", () => {
  const valid = { name: "local-vllm", baseUrl: "http://127.0.0.1:8000/v1", models: "qwen-32b", contextWindow: "131072" };

  it("accepts a complete unique endpoint", () => {
    expect(providerDraftError(valid, ["ollama"])).toBeNull();
  });

  it("rejects duplicates, unsafe URLs, missing models and invalid context", () => {
    expect(providerDraftError(valid, ["local-vllm"])).toContain("уже существует");
    expect(providerDraftError({ ...valid, baseUrl: "file:///tmp/model" })).toContain("http");
    expect(providerDraftError({ ...valid, models: "" })).toContain("хотя бы одну");
    expect(providerDraftError({ ...valid, models: "qwen,qwen" })).toContain("повторяться");
    expect(providerDraftError({ ...valid, contextWindow: "-1" })).toContain("1024");
    expect(providerDraftError({ ...valid, name: "__proto__" })).toContain("Имя провайдера");
    expect(providerDraftError({ ...valid, name: "bad/name" })).toContain("Имя провайдера");
    expect(providerDraftError({ ...valid, baseUrl: "https://secret@example.com/v1" })).toContain("логин");
    expect(providerDraftError({ ...valid, contextWindow: "999999999" })).toContain("10 000 000");
  });
});

describe("provider/model consistency", () => {
  const catalog = {
    ollama: { models: [{ id: "qwen-local" }] },
    anthropic: { models: [{ id: "claude-sonnet" }, { id: "claude-opus" }] },
  };

  it("selects the provider's first model when the current id is invalid", () => {
    expect(modelForProvider(catalog, "anthropic", "qwen-local")).toBe("claude-sonnet");
  });

  it("keeps a valid shared model and does not erase unknown provider settings", () => {
    expect(modelForProvider(catalog, "anthropic", "claude-opus")).toBe("claude-opus");
    expect(modelForProvider(catalog, "custom", "runtime-model")).toBe("runtime-model");
  });
});
