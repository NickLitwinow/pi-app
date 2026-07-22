import { describe, expect, it } from "vitest";
import { resolveAppIconStyle } from "./theme";

describe("resolveAppIconStyle", () => {
  it("maps the main appearance to a matching icon family in auto mode", () => {
    expect(resolveAppIconStyle({ appIconStyle: "auto", appearancePreset: "chatgpt" })).toBe("liquid-glass");
    expect(resolveAppIconStyle({ appIconStyle: "auto", appearancePreset: "gemini" })).toBe("aurora");
    expect(resolveAppIconStyle({ appIconStyle: "auto", appearancePreset: "claude" })).toBe("graphite");
  });

  it("keeps an explicit icon family independent from the main appearance", () => {
    expect(resolveAppIconStyle({ appIconStyle: "graphite", appearancePreset: "gemini" })).toBe("graphite");
    expect(resolveAppIconStyle({ appIconStyle: "aurora", appearancePreset: "claude" })).toBe("aurora");
  });

  it("falls back safely when an old or hand-edited config contains an unknown value", () => {
    expect(resolveAppIconStyle({ appIconStyle: "future" as never, appearancePreset: "gemini" })).toBe("aurora");
  });
});
