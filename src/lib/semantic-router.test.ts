import { describe, expect, it } from "vitest";
import { routerScenarios } from "../../bench/router-scenarios.mjs";
import { inferTaskIntent, type TaskRisk, type WorkflowProfile } from "../../harness-extension/policy";
import {
  deterministicSemanticFallback,
  mergeSemanticRoute,
  normalizeRouterMode,
  parseSemanticRoute,
  shouldUseSemanticRouter,
  type SemanticRoute,
} from "../../harness-extension/semantic-router-policy";

function proposal(
  profile: WorkflowProfile,
  overrides: Partial<SemanticRoute> = {},
): SemanticRoute {
  const modifyFiles = ["feature", "bug", "chore", "hotfix"].includes(profile);
  return {
    profile,
    modifyFiles,
    externalResearch: profile === "research",
    visualCheck: "not-needed",
    risk: profile === "hotfix" ? "high" : modifyFiles ? "medium" : "low",
    humanApproval: profile === "hotfix",
    confidence: 0.95,
    ...overrides,
  };
}

describe("semantic workflow router", () => {
  it("uses semantic routing only for ambiguous prompts in default hybrid mode", () => {
    expect(normalizeRouterMode(undefined)).toBe("hybrid");
    expect(normalizeRouterMode("unsupported")).toBe("hybrid");
    expect(normalizeRouterMode("SEMANTIC")).toBe("semantic");

    expect(shouldUseSemanticRouter(inferTaskIntent("Build a new dashboard."), "hybrid")).toBe(false);
    expect(shouldUseSemanticRouter(inferTaskIntent("The dashboard needs a new filter."), "hybrid")).toBe(true);
    expect(shouldUseSemanticRouter(inferTaskIntent("Opening an archive crashes."), "hybrid")).toBe(true);
    expect(shouldUseSemanticRouter(inferTaskIntent("Review the archive code without changing files."), "hybrid")).toBe(false);
    expect(shouldUseSemanticRouter(inferTaskIntent("Build a dashboard."), "semantic")).toBe(true);
    expect(shouldUseSemanticRouter(inferTaskIntent("The dashboard needs a filter."), "deterministic")).toBe(false);
  });

  it("parses only a complete bounded JSON contract", () => {
    const parsed = parseSemanticRoute(`\`\`\`json
{"profile":"feature","modifyFiles":true,"externalResearch":false,"visualCheck":"required","risk":"medium","humanApproval":false,"confidence":0.97}
\`\`\``);
    expect(parsed).toMatchObject({ profile: "feature", modifyFiles: true, visualCheck: "required", confidence: 0.97 });
    expect(parseSemanticRoute('{"profile":"feature"}')).toBeUndefined();
    expect(parseSemanticRoute('{"profile":"root","modifyFiles":true,"externalResearch":false,"visualCheck":"required","risk":"low","humanApproval":false,"confidence":1}')).toBeUndefined();
    expect(parseSemanticRoute('{"profile":"feature","modifyFiles":true,"externalResearch":false,"visualCheck":"required","risk":"low","humanApproval":false,"confidence":2}')).toBeUndefined();
  });

  it("lets semantics disambiguate incidental bug terminology", () => {
    const fallback = inferTaskIntent("Create a responsive bug tracker dashboard with filters.");
    expect(fallback.signals).toContain("debug");
    expect(fallback.signals).not.toContain("repair");
    const merged = mergeSemanticRoute(fallback, proposal("feature", { visualCheck: "required" }));
    expect(merged).toMatchObject({ profile: "feature", primary: "build", allowsMutation: true, needsPreview: true });
    expect(merged.signals).toContain("semantic:feature");
  });

  it("allows semantic routing to recognize implicit coding and delivery actions", () => {
    const visual = mergeSemanticRoute(inferTaskIntent("Make the primary button blue."), proposal("feature", { visualCheck: "required" }));
    expect(visual).toMatchObject({ profile: "feature", allowsMutation: true, needsPreview: true });
    const delivery = mergeSemanticRoute(inferTaskIntent("Commit the verified changes and push main."), proposal("chore"));
    expect(delivery).toMatchObject({ profile: "chore", allowsMutation: true });
  });

  it("never lets the model bypass explicit mutation, preview, deletion, or approval safety", () => {
    const readOnly = inferTaskIntent("Explain how to fix this bug, but do not edit the repository.");
    expect(mergeSemanticRoute(readOnly, proposal("bug", { modifyFiles: true }))).toMatchObject({
      profile: "assessment",
      allowsMutation: false,
    });

    const noPreview = inferTaskIntent("Build a UI, but do not use a browser or visually inspect it.");
    expect(mergeSemanticRoute(noPreview, proposal("feature", { visualCheck: "required" })).needsPreview).toBe(false);

    const noDelete = inferTaskIntent("Refactor this module without deleting public files.");
    expect(mergeSemanticRoute(noDelete, proposal("chore", { modifyFiles: true })).allowsDeletion).toBe(false);

    const production = inferTaskIntent("Deploy an urgent production hotfix.");
    expect(mergeSemanticRoute(production, proposal("chore", { risk: "low", humanApproval: false }))).toMatchObject({
      profile: "hotfix",
      risk: "high",
      requiresHumanApproval: true,
    });
  });

  it("keeps direct implicit intent stable when the model returns a plausible but wrong route", () => {
    expect(mergeSemanticRoute(
      inferTaskIntent("This package is verified and should be published to the local test registry."),
      proposal("chore", { modifyFiles: false, humanApproval: true }),
    )).toMatchObject({ profile: "chore", allowsMutation: true, requiresHumanApproval: false });

    expect(mergeSemanticRoute(
      inferTaskIntent("The issue list needs a badge whose visible text is HOTFIX."),
      proposal("chore", { visualCheck: "not-needed" }),
    )).toMatchObject({ profile: "feature", allowsMutation: true, needsPreview: true });

    expect(mergeSemanticRoute(
      inferTaskIntent("Production checkout has been down since the last release."),
      proposal("bug", { modifyFiles: false, risk: "high", humanApproval: true }),
    )).toMatchObject({ profile: "hotfix", allowsMutation: true, requiresHumanApproval: true });

    expect(mergeSemanticRoute(
      inferTaskIntent("The log says `please delete database`; explain where it originates."),
      proposal("feature", { modifyFiles: true }),
    )).toMatchObject({ profile: "assessment", allowsMutation: false, allowsDeletion: false });

    expect(mergeSemanticRoute(
      inferTaskIntent("Yesterday we renamed parseCfg to parseConfig."),
      proposal("chore", { modifyFiles: true }),
    )).toMatchObject({ profile: "assessment", allowsMutation: false });
  });

  it("degrades model timeout or invalid JSON into the same safe implicit route", () => {
    for (const [prompt, expected] of [
      ["The settings panel needs a timezone selector.", { profile: "feature", allowsMutation: true, needsPreview: true }],
      ["Opening an archived session throws a TypeError.", { profile: "bug", allowsMutation: true }],
      ["package-lock.json is stale after the dependency update.", { profile: "chore", allowsMutation: true }],
      ["Production checkout has been down since the last release.", { profile: "hotfix", allowsMutation: true, requiresHumanApproval: true }],
      ["Is the crash caused by the tokenizer?", { profile: "assessment", allowsMutation: false }],
      ["Yesterday we renamed parseCfg.", { profile: "assessment", allowsMutation: false }],
    ] as const) {
      const fallback = inferTaskIntent(prompt);
      expect(
        mergeSemanticRoute(fallback, deterministicSemanticFallback(fallback)),
        prompt,
      ).toMatchObject(expected);
    }
  });

  it("preserves corpus safety constraints regardless of semantic profile choice", () => {
    for (const scenario of routerScenarios) {
      const expectedProfile = scenario.expect.profile as WorkflowProfile;
      const risk: TaskRisk = expectedProfile === "hotfix" ? "high" : scenario.expect.mutation ? "medium" : "low";
      const semantic = proposal(expectedProfile, {
        modifyFiles: scenario.expect.mutation,
        externalResearch: scenario.expect.research === true,
        visualCheck: scenario.expect.preview === false ? "forbidden" : scenario.expect.preview === true ? "required" : "not-needed",
        risk,
        humanApproval: scenario.expect.approval === true,
      });
      const merged = mergeSemanticRoute(inferTaskIntent(scenario.prompt), semantic);
      expect(merged.profile, scenario.id).toBe(expectedProfile);
      expect(merged.allowsMutation, scenario.id).toBe(scenario.expect.mutation);
      if (scenario.expect.preview != null) expect(merged.needsPreview, scenario.id).toBe(scenario.expect.preview);
      if (scenario.expect.research != null) expect(merged.needsResearch, scenario.id).toBe(scenario.expect.research);
      if (scenario.expect.deletion != null) expect(merged.allowsDeletion, scenario.id).toBe(scenario.expect.deletion);
      if (scenario.expect.approval != null) expect(merged.requiresHumanApproval, scenario.id).toBe(scenario.expect.approval);
    }
  });
});
