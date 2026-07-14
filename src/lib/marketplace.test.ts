import { describe, expect, it } from "vitest";
import {
  isPackageResourceEnabled,
  packageNameFromSpec,
  setPackageResourceEnabled,
} from "../components/Marketplace";

describe("packageNameFromSpec", () => {
  it.each([
    ["npm:pi-web-access", "pi-web-access"],
    ["npm:pi-web-access@2.1.0", "pi-web-access"],
    ["npm:@gotgenes/pi-permission-system", "@gotgenes/pi-permission-system"],
    ["npm:@gotgenes/pi-permission-system@0.5.0", "@gotgenes/pi-permission-system"],
    ["git:https://example.com/package.git", null],
  ])("normalizes %s", (source, expected) => {
    expect(packageNameFromSpec(source)).toBe(expected);
  });

  it("normalizes object-form package filters", () => {
    expect(packageNameFromSpec({ source: "npm:@scope/pkg@2.0.0", extensions: [] })).toBe("@scope/pkg");
  });
});

describe("package resource filters", () => {
  it("disables one resource kind without affecting the others", () => {
    const [next] = setPackageResourceEnabled(["npm:multi-tool"], "multi-tool", "skill", false);
    expect(next).toEqual({ source: "npm:multi-tool", skills: [] });
    expect(isPackageResourceEnabled(next, "skill")).toBe(false);
    expect(isPackageResourceEnabled(next, "extension")).toBe(true);
  });

  it("restores the compact string form when the final filter is enabled", () => {
    const [next] = setPackageResourceEnabled(
      [{ source: "npm:multi-tool", themes: [] }],
      "multi-tool",
      "theme",
      true,
    );
    expect(next).toBe("npm:multi-tool");
  });

  it("preserves unrelated filters", () => {
    const [next] = setPackageResourceEnabled(
      [{ source: "npm:multi-tool", extensions: [], skills: ["skills/review/SKILL.md"] }],
      "multi-tool",
      "theme",
      false,
    );
    expect(next).toEqual({
      source: "npm:multi-tool",
      extensions: [],
      skills: ["skills/review/SKILL.md"],
      themes: [],
    });
  });
});
