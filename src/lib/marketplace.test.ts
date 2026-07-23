import { describe, expect, it } from "vitest";
import {
  isPackageResourceEnabled,
  packageCliSource,
  packageNameFromSpec,
  packageRisk,
  setPackageResourceEnabled,
} from "../components/Marketplace";

describe("package risk", () => {
  it("never labels an installed multi-resource package as theme-only", () => {
    expect(packageRisk("theme", false).label).toBe("только оформление");
    expect(packageRisk("theme", true).label).toBe("может исполнять код");
    expect(packageRisk("skill", true).className).toBe("danger");
  });
});

describe("packageNameFromSpec", () => {
  it.each([
    ["npm:pi-web-access", "pi-web-access"],
    ["npm:pi-web-access@2.1.0", "pi-web-access"],
    ["npm:@gotgenes/pi-permission-system", "@gotgenes/pi-permission-system"],
    ["npm:@gotgenes/pi-permission-system@0.5.0", "@gotgenes/pi-permission-system"],
    ["git:https://example.com/package.git", "package"],
    ["git:github.com/DietrichGebert/ponytail", "ponytail"],
    ["../../GithubControl/pi-app/harness-extension", "harness-extension"],
    ["/Users/example/My Packages/custom-theme/", "custom-theme"],
    ["file:../shared/custom-skill", "custom-skill"],
  ])("normalizes %s", (source, expected) => {
    expect(packageNameFromSpec(source)).toBe(expected);
  });

  it("normalizes object-form package filters", () => {
    expect(packageNameFromSpec({ source: "npm:@scope/pkg@2.0.0", extensions: [] })).toBe("@scope/pkg");
  });
});

describe("packageCliSource", () => {
  it("preserves exact installed sources and defaults catalog rows to npm", () => {
    expect(packageCliSource({ name: "harness-extension", source: "../../pi-app/harness-extension" }))
      .toBe("../../pi-app/harness-extension");
    expect(packageCliSource({ name: "ponytail", source: "git:github.com/DietrichGebert/ponytail" }))
      .toBe("git:github.com/DietrichGebert/ponytail");
    expect(packageCliSource({ name: "pi-web-access" })).toBe("npm:pi-web-access");
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

  it("can disable skill discovery for a Git package while retaining its extension", () => {
    const [next] = setPackageResourceEnabled(
      ["git:github.com/DietrichGebert/ponytail"],
      "ponytail",
      "skill",
      false,
    );
    expect(next).toEqual({ source: "git:github.com/DietrichGebert/ponytail", skills: [] });
    expect(isPackageResourceEnabled(next, "extension")).toBe(true);
  });

  it("targets the exact local source when two packages share a basename", () => {
    const packages = ["../one/shared", "../two/shared"];
    expect(setPackageResourceEnabled(packages, "../two/shared", "extension", false)).toEqual([
      "../one/shared",
      { source: "../two/shared", extensions: [] },
    ]);
  });
});
