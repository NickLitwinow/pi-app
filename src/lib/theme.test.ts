import { describe, expect, it } from "vitest";
import { appIconForeground, DEFAULT_APP_ICON_BACKGROUND, resolveAppIconBackground } from "./theme";

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
