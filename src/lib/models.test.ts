import { describe, expect, it } from "vitest";
import { modelAliasKey, modelDisplayName, modelIdDisplayName } from "./models";

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
