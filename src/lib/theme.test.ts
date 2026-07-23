import { describe, expect, it } from "vitest";
import { appIconForeground, DEFAULT_APP_ICON_BACKGROUND, paletteFromPiColors, resolveAppIconBackground, safeThemeColor } from "./theme";

describe("app icon colors", () => {
  it("normalizes custom colors independently from the interface theme", () => {
    expect(resolveAppIconBackground({ appIconBackground: "#4a62ff" })).toBe("#4A62FF");
    expect(resolveAppIconBackground({ appIconBackground: "invalid" })).toBe(DEFAULT_APP_ICON_BACKGROUND);
  });

  it("migrates every legacy icon family", () => {
    expect(resolveAppIconBackground({ appIconStyle: "auto" })).toBe(DEFAULT_APP_ICON_BACKGROUND);
    expect(resolveAppIconBackground({ appIconStyle: "liquid-glass" })).toBe(DEFAULT_APP_ICON_BACKGROUND);
    expect(resolveAppIconBackground({ appIconStyle: "aurora" })).toBe("#4057E8");
    expect(resolveAppIconBackground({ appIconStyle: "graphite" })).toBe("#34363D");
  });

  it("uses a contrasting glyph on both dark and light backgrounds", () => {
    expect(appIconForeground("#171A24")).toBe("#FFFFFF");
    expect(appIconForeground("#F3F1EA")).toBe("#17191F");
  });
});

describe("community theme colors", () => {
  it("accepts modern color syntax", () => {
    expect(safeThemeColor("#69b1ffcc", "#000000")).toBe("#69b1ffcc");
    expect(safeThemeColor("color(display-p3 0.3 0.6 1 / 0.8)", "#000000"))
      .toBe("color(display-p3 0.3 0.6 1 / 0.8)");
  });

  it("rejects active or malformed CSS from untrusted theme packages", () => {
    expect(safeThemeColor("url(https://tracker.invalid/pixel)", "#123456")).toBe("#123456");
    expect(safeThemeColor("red; background:url(https://tracker.invalid)", "#123456")).toBe("#123456");
    expect(paletteFromPiColors("unsafe", { toolPendingBg: "url(https://tracker.invalid)" }).background).toBe("#111113");
  });
});
