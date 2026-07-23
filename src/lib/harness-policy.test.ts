import { describe, expect, it } from "vitest";
import {
  buildIndependentFalsifierPrompt,
  buildIndependentEvaluatorPrompt,
  classifyTask,
  classifyPreviewBrowserEvidence,
  executionFailed,
  independentEvaluationAccepted,
  independentEvaluationRepairPrompt,
  inferTaskIntent,
  isVerifyCommand,
  parseBackgroundAgentId,
  parseIndependentVerdict,
  verificationSucceeded,
} from "../../harness-extension/policy";
import {
  attachVerifierSteps,
  createWorkflowState,
  loadVerifierManifest,
  normalizeWorkflowState,
  readySteps,
  updateWorkflowStep,
} from "../../harness-extension/workflow";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fingerprintWorkspace, isWorkspacePath, parsePorcelainZ, rebaseWorktreePrompt } from "../../harness-extension/workspace";
import { decorateTaskQueue } from "../../harness-extension/tasks";
import { isSubagentSessionFile, normalizeGeneratedSessionName } from "../../harness-extension/session-name-utils";

describe("harness verification policy", () => {
  it.each([
    "npm test",
    "pnpm run typecheck",
    "cd src-tauri && cargo test",
    "npm run lint && npm run build",
    "pytest tests/unit",
    "node --test test/discount.test.js",
    "python3 -m pytest tests/unit",
    "dotnet test",
    "./gradlew test",
  ])("accepts a real verifier: %s", (command) => {
    expect(isVerifyCommand(command)).toBe(true);
  });

  it.each([
    "echo npm test",
    "printf 'cargo test'",
    "npm test || true",
    "cargo test || :",
    "npm run build; exit 0",
    "echo done",
    "cat package.json",
  ])("rejects a fake or masked verifier: %s", (command) => {
    expect(isVerifyCommand(command)).toBe(false);
  });
});

describe("background agent result parsing", () => {
  it("extracts the same bounded ID from plain and JSON-escaped tool results", () => {
    expect(parseBackgroundAgentId("Agent ID: abc-123\nType: Agent")).toBe("abc-123");
    expect(parseBackgroundAgentId(String.raw`Agent ID: abc-123\nType: Agent`)).toBe("abc-123");
  });

  it("does not absorb presentation fields or accept a missing identifier", () => {
    expect(parseBackgroundAgentId(String.raw`Agent ID: worker_2.branch\nType: Agent`)).toBe("worker_2.branch");
    expect(parseBackgroundAgentId("Agent ID: ")).toBeUndefined();
  });
});

describe("live preview browser evidence", () => {
  const url = "http://localhost:1420";

  it("separates navigation from rendered inspection", () => {
    expect(classifyPreviewBrowserEvidence("chrome_navigate", { url }, url)).toMatchObject({
      opened: true,
      inspected: false,
    });
    expect(classifyPreviewBrowserEvidence("chrome_snapshot", {}, url)).toMatchObject({
      opened: false,
      inspected: true,
    });
    expect(classifyPreviewBrowserEvidence("agent_browser", { qa: { url, screenshotPath: "qa.png" } }, url)).toMatchObject({
      opened: true,
      inspected: true,
    });
    expect(classifyPreviewBrowserEvidence("agent_browser", { args: ["open", `${url}/`] }, url).opened).toBe(true);
    expect(classifyPreviewBrowserEvidence("agent_browser", { args: ["snapshot", "-i"] }, url).inspected).toBe(true);
    expect(classifyPreviewBrowserEvidence("agent_browser", {
      job: { steps: [{ action: "open", url }, { action: "screenshot", path: "qa.png" }] },
    }, url)).toMatchObject({ opened: true, inspected: true });
  });

  it("does not accept source tools, another URL, or malformed inputs", () => {
    expect(classifyPreviewBrowserEvidence("read", { path: "src/App.tsx", note: url }, url)).toMatchObject({
      opened: false,
      inspected: false,
    });
    expect(classifyPreviewBrowserEvidence("chrome_navigate", { url: "http://localhost:9999" }, url).opened).toBe(false);
    expect(classifyPreviewBrowserEvidence("agent_browser", { note: url, args: ["open", "http://localhost:9999"] }, url).opened).toBe(false);
    expect(classifyPreviewBrowserEvidence("agent_browser", { args: ["eval", "open", url] }, url).opened).toBe(false);
    expect(classifyPreviewBrowserEvidence("agent_browser", { args: ["read", url] }, url).inspected).toBe(false);
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(classifyPreviewBrowserEvidence("agent_browser", circular, url)).toMatchObject({
      opened: false,
      inspected: false,
    });
  });
});

describe("workspace evidence", () => {
  it("preserves porcelain status columns and paths", () => {
    expect(parsePorcelainZ(" M src/cli.js\0?? new file.js\0")).toEqual({
      files: ["src/cli.js", "new file.js"],
      untracked: ["new file.js"],
    });
  });

  it("changes the fingerprint when an untracked file changes", () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-harness-untracked-"));
    writeFileSync(join(cwd, "new.js"), "one");
    const first = fingerprintWorkspace(cwd, "", "?? new.js\0");
    writeFileSync(join(cwd, "new.js"), "two");
    const second = fingerprintWorkspace(cwd, "", "?? new.js\0");
    expect(first.files).toEqual(["new.js"]);
    expect(first.fingerprint).not.toBe(second.fingerprint);
  });

  it("changes the fingerprint when a clean checkout advances to a new revision", () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-harness-revision-"));
    const first = fingerprintWorkspace(cwd, "", "", "commit-a");
    const second = fingerprintWorkspace(cwd, "", "", "commit-b");
    expect(first.files).toEqual([]);
    expect(first.fingerprint).not.toBe(second.fingerprint);
  });

  it("keeps isolated tool paths inside their authoritative worktree", () => {
    const cwd = "/repo/.pi/tmp/pi-agent-123";
    expect(isWorkspacePath(cwd, "src/index.ts")).toBe(true);
    expect(isWorkspacePath(cwd, `${cwd}/src/index.ts`)).toBe(true);
    expect(isWorkspacePath(cwd, "/repo/src/index.ts")).toBe(false);
    expect(isWorkspacePath(cwd, "../../src/index.ts")).toBe(false);
  });

  it("rebases inherited parent paths without duplicating an existing child path", () => {
    const parent = "/repo";
    const child = "/repo/.pi/tmp/pi-agent-123";
    const prompt = `Parent cwd: ${parent}\nChild cwd: ${child}\nRead ${parent}/src/index.ts`;
    expect(rebaseWorktreePrompt(prompt, parent, child)).toBe(
      `Parent cwd: ${child}\nChild cwd: ${child}\nRead ${child}/src/index.ts`,
    );
  });
});

describe("workflow classification", () => {
  it("separates assessment, research, debugging, building, and trivial work", () => {
    expect(classifyTask("Проанализируй текущую реализацию и объясни ограничения")).toBe("assessment");
    expect(classifyTask("Проведи доресерч актуальных best practices")).toBe("research");
    expect(classifyTask("Исправь баг на границе диапазона")).toBe("debug");
    expect(classifyTask("Реализуй миграцию формата конфигурации")).toBe("build");
    expect(classifyTask("Переименуй переменную")).toBe("build");
    expect(inferTaskIntent("Переименуй переменную").profile).toBe("chore");
  });

  it("keeps research and debugging as capabilities when implementation is explicit", () => {
    const original = inferTaskIntent(
      "Полностью переработай harness, проведи доресерч best practices, исправляя дефекты, и выполни A/B тест",
    );
    expect(original.primary).toBe("build");
    expect(original.needsResearch).toBe(true);
    expect(original.allowsMutation).toBe(true);
    expect(original.requiresPlan).toBe(true);
    expect(original.requiresEvaluator).toBe(true);
    expect(original.signals).toContain("debug");

    const migration = inferTaskIntent("Реализуй миграцию конфигурации, исправляя дефект старого формата");
    expect(migration.primary).toBe("build");
    expect(migration.profile).toBe("bug");
  });

  it("does not treat production-ready quality as a live production hotfix", () => {
    const intent = inferTaskIntent(
      "Доведи до production-ready мигратор конфигурации v1→v2. Исправь найденный дефект и проверь проект.",
    );
    expect(intent.primary).toBe("build");
    expect(intent.profile).toBe("bug");
    expect(intent.risk).toBe("medium");
    expect(intent.requiresHumanApproval).toBe(false);
  });

  it("separates code-level security work from externally destructive approval", () => {
    const codeFix = inferTaskIntent("Исправь secure.js по SECURITY.md, добавь защиту от path traversal и shell injection");
    expect(codeFix.profile).toBe("bug");
    expect(codeFix.requiresHumanApproval).toBe(false);

    const deploy = inferTaskIntent("Исправь production incident и deploy hotfix в продакшн");
    expect(deploy.profile).toBe("hotfix");
    expect(deploy.risk).toBe("high");
    expect(deploy.requiresHumanApproval).toBe(true);
  });

  it("requires explicit, non-negated authorization for tracked-file deletion", () => {
    expect(inferTaskIntent("Удалить устаревший legacy.js и обновить callers").allowsDeletion).toBe(true);
    expect(inferTaskIntent("Исправить legacy.js, не удаляй публичный модуль").allowsDeletion).toBe(false);
    expect(inferTaskIntent("Fix the parser without removing the public API").allowsDeletion).toBe(false);
    expect(inferTaskIntent("Исправить мигратор по CONTRACT.md").allowsDeletion).toBe(false);
  });
});

describe("persisted workflow contract", () => {
  it("creates a dependency graph with acceptance gates", () => {
    const state = createWorkflowState("Реализуй новую UI панель и тесты", 100);
    expect(state.version).toBe(3);
    expect(state.profile).toBe("feature");
    expect(state.intent.needsPreview).toBe(true);
    expect(state.steps.map((step) => step.id)).toEqual(["plan", "build", "preview", "verify", "evaluate", "review"]);
    expect(state.steps.find((step) => step.id === "verify")?.deps).toEqual(["preview"]);
    expect(state.steps.every((step) => Boolean(step.acceptance))).toBe(true);
    expect(state.steps.every((step) => Boolean(step.owner) && step.maxAttempts > 0)).toBe(true);
    expect(state.status).toBe("active");
    expect(readySteps(state).map((step) => step.id)).toEqual(["plan"]);

    const planned = updateWorkflowStep(state, "plan", "passed", "approved", 200);
    expect(readySteps(planned).map((step) => step.id)).toEqual(["build"]);
    expect(planned.events.at(-1)?.type).toBe("passed");
  });

  it("requires rendered preview evidence only for visual mutations", () => {
    expect(inferTaskIntent("Исправь адаптивную панель и иконки").needsPreview).toBe(true);
    expect(inferTaskIntent("Реализуй миграцию JSON конфига").needsPreview).toBe(false);
    expect(inferTaskIntent("Проанализируй UI без изменений").needsPreview).toBe(false);
    expect(createWorkflowState("Исправь адаптивную панель").steps.find((step) => step.id === "preview")).toMatchObject({
      kind: "preview",
      owner: "preview-runner",
      deps: ["build"],
      required: true,
    });
  });

  it("persists explicit human, blocked, and completed workflow lifecycle states", () => {
    let hotfix = createWorkflowState("Deploy production hotfix", 100);
    expect(hotfix.status).toBe("active");
    hotfix = updateWorkflowStep(hotfix, "plan", "passed", "containment approved", 110);
    expect(hotfix.status).toBe("needs-human");
    expect(hotfix.blockedStepId).toBe("approve");

    let feature = createWorkflowState("Реализуй новую возможность", 200);
    const build = feature.steps.find((step) => step.id === "build")!;
    for (let attempt = 0; attempt < build.maxAttempts; attempt++) {
      feature = updateWorkflowStep(feature, "build", "running", undefined, 201 + attempt * 2);
      feature = updateWorkflowStep(feature, "build", "failed", `failure ${attempt + 1}`, 202 + attempt * 2);
    }
    expect(feature).toMatchObject({ status: "blocked", blockedStepId: "build", blockedReason: `failure ${build.maxAttempts}` });

    let research = createWorkflowState("Исследуй архитектуру без изменений", 300);
    for (const step of research.steps) research = updateWorkflowStep(research, step.id, "passed", "evidence", 301);
    expect(research.status).toBe("completed");
    expect(research.terminationReason).toContain("Every required workflow step");
  });

  it("upgrades older persisted v3 steps with lifecycle metadata", () => {
    const legacy = createWorkflowState("Реализуй компонент", 400);
    delete (legacy as Partial<typeof legacy>).status;
    for (const step of legacy.steps) {
      delete (step as Partial<typeof step>).owner;
      delete (step as Partial<typeof step>).maxAttempts;
    }
    const restored = normalizeWorkflowState(legacy);
    expect(restored.status).toBe("active");
    expect(restored.steps.every((step) => step.owner && step.maxAttempts > 0)).toBe(true);
  });

  it("loads an explicit verifier manifest and expands the gate", () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-harness-manifest-"));
    mkdirSync(join(cwd, ".pi"));
    writeFileSync(join(cwd, ".pi", "verifiers.json"), JSON.stringify({
      version: 1,
      commands: [
        { id: "lint", label: "Lint", command: "npm run lint" },
        { id: "test", label: "Tests", command: "npm test", timeoutMs: 1234 },
      ],
    }));
    const manifest = loadVerifierManifest(cwd);
    const state = attachVerifierSteps(createWorkflowState("Реализуй компонент"), manifest);
    expect(manifest.source).toBe("project");
    expect(state.steps.filter((step) => step.kind === "gate").map((step) => step.id)).toEqual([
      "verify:lint",
      "verify:test",
    ]);
    expect(state.steps.find((step) => step.id === "evaluate")?.deps).toEqual(["verify:lint", "verify:test"]);
  });

  it("replaces a failed no-verifier placeholder when retry discovers a manifest", () => {
    const initial = updateWorkflowStep(
      createWorkflowState("Реализуй workflow.json"),
      "verify",
      "failed",
      "No executable project verifier manifest was found.",
    );
    const recovered = attachVerifierSteps(initial, {
      version: 1,
      source: "project",
      commands: [{ id: "contract", label: "Contract", command: "node verify.js" }],
    });
    expect(recovered.steps.some((step) => step.id === "verify")).toBe(false);
    expect(recovered.steps.find((step) => step.id === "verify:contract")).toMatchObject({ status: "pending" });
    expect(recovered.steps.find((step) => step.id === "evaluate")?.deps).toEqual(["verify:contract"]);
  });

  it("honors declarative profile and human approval overrides", () => {
    const state = attachVerifierSteps(
      createWorkflowState("Исправь баг", 100, "hotfix"),
      { version: 1, source: "project", humanApproval: true, commands: [{ id: "test", label: "Test", command: "npm test" }] },
    );
    expect(state.profile).toBe("hotfix");
    expect(state.approved).toBe(false);
    expect(state.intent.requiresHumanApproval).toBe(true);
    expect(state.steps.some((step) => step.id === "approve")).toBe(true);
  });

  it("adds project approval to ordinary workflows and honors evaluator opt-out", () => {
    const state = attachVerifierSteps(
      createWorkflowState("Реализуй компонент", 100),
      {
        version: 1,
        source: "project",
        humanApproval: true,
        evaluator: { enabled: false },
        commands: [{ id: "test", label: "Test", command: "npm test" }],
      },
    );
    const approval = state.steps.find((step) => step.id === "approve");
    expect(approval).toMatchObject({ status: "waiting", deps: ["plan"] });
    expect(state.steps.find((step) => step.id === "build")?.deps).toEqual(["approve"]);
    expect(state.approved).toBe(false);
    expect(state.intent.requiresEvaluator).toBe(false);
  });

  it("allows a project manifest to waive inferred hotfix approval", () => {
    const state = attachVerifierSteps(
      createWorkflowState("Deploy production hotfix", 100),
      { version: 1, source: "project", humanApproval: false, commands: [{ id: "test", label: "Test", command: "npm test" }] },
    );
    expect(state.approved).toBe(true);
    expect(state.intent.requiresHumanApproval).toBe(false);
    expect(state.steps.find((step) => step.id === "approve")?.status).toBe("skipped");
  });

  it("detects conventional package scripts when no manifest exists", () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-harness-package-"));
    writeFileSync(join(cwd, "package.json"), JSON.stringify({ scripts: { lint: "eslint .", test: "vitest run", dev: "vite" } }));
    expect(loadVerifierManifest(cwd)).toMatchObject({
      source: "detected",
      commands: [
        { id: "lint", command: "npm run lint" },
        { id: "test", command: "npm run test" },
      ],
    });
  });
});

describe("background queue presentation", () => {
  it("derives queue position, priority, wait reason, and an evidence-based ETA", () => {
    const tasks = decorateTaskQueue([
      { id: "done", type: "worker", status: "completed" as const, durationMs: 120_000 },
      { id: "live-1", type: "worker", status: "running" as const },
      { id: "live-2", type: "worker", status: "running" as const },
      { id: "next", type: "worker", status: "queued" as const },
      { id: "judge", type: "independent-evaluator", status: "queued" as const },
    ], 2);
    expect(tasks[3]).toMatchObject({ priority: "normal", queuePosition: 1, etaMs: 120_000 });
    expect(tasks[3].blockedReason).toContain("available worker slot");
    expect(tasks[4]).toMatchObject({ priority: "high", queuePosition: 2, etaMs: 120_000 });
  });

  it("does not invent an ETA without completed-duration evidence", () => {
    const [queued] = decorateTaskQueue([{ id: "q", status: "queued" as const }], 2);
    expect(queued).toMatchObject({ queuePosition: 1, priority: "normal" });
    expect(queued.etaMs).toBeUndefined();
  });
});

describe("verification result policy", () => {
  it("accepts an actual zero-exit verifier", () => {
    expect(verificationSucceeded("npm test", false, { details: { exitCode: 0 }, content: "12 passed" })).toBe(true);
  });

  it.each([
    ["npm test", true, { details: { exitCode: 0 } }],
    ["npm test", false, { details: { exitCode: 1 } }],
    ["pytest", false, { content: "2 failed, 10 passed" }],
    ["echo done", false, { details: { exitCode: 0 } }],
  ])("rejects failed or non-verification results", (command, isError, result) => {
    expect(verificationSucceeded(command, isError, result)).toBe(false);
  });

  it("invalidates a green gate when a later direct probe exits non-zero", () => {
    expect(executionFailed(true, { content: "ENOENT: open summary" })).toBe(true);
    expect(executionFailed(false, { details: { exitCode: 2 } })).toBe(true);
    expect(executionFailed(false, { details: { exitCode: 0 }, content: "ok" })).toBe(false);
  });

  it("uses the last explicit independent-evaluator verdict", () => {
    expect(parseIndependentVerdict("VERDICT: PASS\nevidence")).toBe("pass");
    expect(parseIndependentVerdict('{"verdict":"fail"}')).toBe("fail");
    expect(parseIndependentVerdict("Instruction mentioned VERDICT: PASS, but evidence failed.\nVERDICT: FAIL")).toBe("fail");
    expect(parseIndependentVerdict("looks good")).toBeUndefined();
  });

  it("fails closed when an evaluator skips protocol evidence or contradicts PASS", () => {
    expect(independentEvaluationAccepted("VERDICT: PASS")).toBe(false);
    expect(independentEvaluationAccepted("PROTOCOL: COMPLETE\nCLAUSE C1: PASS\nBLOCKING: NONE\nVERDICT: PASS")).toBe(true);
    expect(independentEvaluationAccepted("PROTOCOL: COMPLETE\nCLAUSE C1: FAIL\nBLOCKING: defect\nVERDICT: PASS")).toBe(false);
    expect(independentEvaluationAccepted("CLAUSE C1: PASS\nCLAUSE C2: PASS\nCLAUSE C3: PASS\nCLAUSE C4: PASS\nCLAUSE C5: PASS\nCLAUSE C6: PASS\nCLAUSE C7: PASS\nBLOCKING: NONE\nVERDICT: PASS")).toBe(false);
    expect(independentEvaluationAccepted("CLAUSE C1: PASS\nCLAUSE C2: PASS\nCLAUSE C3: PASS\nCLAUSE C4: PASS\nCLAUSE C5: PASS\nCLAUSE C6: PASS\nCLAUSE C7: PASS\nCLAUSE C8: PASS\nBLOCKING: NONE\nVERDICT: PASS")).toBe(true);
  });

  it("accepts harmless Markdown around complete control lines without accepting failures", () => {
    expect(independentEvaluationAccepted([
      "## PROTOCOL: COMPLETE",
      "**CLAUSE input-type: PASS**",
      "**BLOCKING: NONE**",
      "VERDICT: **PASS**",
    ].join("\n"))).toBe(true);
    expect(independentEvaluationAccepted([
      "## PROTOCOL: COMPLETE",
      "**Verdict:** **CLAUSE input-type: PASS**",
      "Status: **CLAUSE discriminator: PASS**",
			"**Result:** CLAUSE runtime-shape: PASS",
      "**BLOCKING: NONE**",
      "VERDICT: **PASS**",
    ].join("\n"))).toBe(true);
		expect(independentEvaluationAccepted([
			"**Result:** CLAUSE 1: PASS",
			"**Result:** CLAUSE 2: PASS",
			"PROTOCOL: COMPLETE",
			"BLOCKING: NONE",
			"VERDICT: PASS",
		].join("\n"))).toBe(true);
    expect(independentEvaluationAccepted([
      "## PROTOCOL: COMPLETE",
      "### CLAUSE input-type",
      "**Verdict:** **PASS**",
      "**BLOCKING: NONE**",
      "VERDICT: **PASS**",
    ].join("\n"))).toBe(false);
		expect(independentEvaluationAccepted([
			...Array.from({ length: 8 }, (_, index) => [
				`### CLAUSE ${index + 1}: explicit obligation`,
				"Implementation evidence is cited here.",
				"**Verdict:** **PASS**",
			]).flat(),
			"## Blocking Findings",
			"**BLOCKING: NONE**",
			"VERDICT: PASS",
		].join("\n"))).toBe(true);
		expect(independentEvaluationAccepted([
			...Array.from({ length: 8 }, (_, index) => [
				`### CLAUSE ${index + 1}: explicit obligation`,
				"Implementation evidence is cited here.",
				index % 2 === 0 ? "**Verdict**: PASS — traced expression" : "**Verdict**: PASS.",
			]).flat(),
			"## Blocking Findings",
			"**BLOCKING: NONE**",
			"VERDICT: PASS",
		].join("\n"))).toBe(true);
		expect(independentEvaluationAccepted([
			"### CLAUSE input-type: explicit obligation",
			"**Verdict**: FAIL — wrong type accepted",
			"BLOCKING: wrong type accepted",
			"PROTOCOL: COMPLETE",
			"VERDICT: PASS",
		].join("\n"))).toBe(false);
		expect(independentEvaluationAccepted([
			"### CLAUSE input-type: explicit obligation",
			"**Verdict**: PASS — plausible prose",
			"BLOCKING: NONE",
			"VERDICT: PASS",
		].join("\n"))).toBe(false);
		expect(independentEvaluationAccepted([
			"### CLAUSE input-type",
			"**Verdict:** **FAIL**",
			"BLOCKING: wrong type accepted",
			"PROTOCOL: COMPLETE",
			"VERDICT: PASS",
		].join("\n"))).toBe(false);
    expect(independentEvaluationAccepted([
      "## PROTOCOL: COMPLETE",
      "- **CLAUSE discriminator: FAIL**",
      "**BLOCKING: string version is accepted**",
      "VERDICT: **PASS**",
    ].join("\n"))).toBe(false);
		expect(independentEvaluationAccepted([
			"| Clause | Verdict | Evidence |",
			"| --- | --- | --- |",
			"| C1 | **PASS** | traced expression |",
			"| C2: default boundary | PASS | adversarial corpus |",
			"**BLOCKING: NONE**",
			"**PROTOCOL: COMPLETE**",
			"VERDICT: PASS",
		].join("\n"))).toBe(true);
		expect(independentEvaluationAccepted([
			"| C1 | PASS | traced expression |",
			"| C2 | FAIL | wrong-type default |",
			"BLOCKING: NONE",
			"PROTOCOL: COMPLETE",
			"VERDICT: PASS",
		].join("\n"))).toBe(false);
		expect(independentEvaluationAccepted([
			"| C1 | plausible evidence says PASS |",
			"BLOCKING: NONE",
			"PROTOCOL: COMPLETE",
			"VERDICT: PASS",
		].join("\n"))).toBe(false);
		expect(independentEvaluationAccepted([
			...Array.from({ length: 8 }, (_, index) => [
				`### CLAUSE ${index + 1}: explicit obligation`,
				"Implementation evidence is cited here.",
				"- **PASS**",
			]).flat(),
			"## Blocking Findings",
			"**BLOCKING: NONE**",
			"VERDICT: PASS",
		].join("\n"))).toBe(true);
		expect(independentEvaluationAccepted([
			"### CLAUSE R1: Reject absolute paths — PASS",
			"Implementation evidence follows.",
			"BLOCKING: NONE",
			"PROTOCOL: COMPLETE",
			"VERDICT: PASS",
		].join("\n"))).toBe(true);
		expect(independentEvaluationAccepted([
			"### CLAUSE R1: Reject absolute paths — FAIL",
			"BLOCKING: absolute-inside accepted",
			"PROTOCOL: COMPLETE",
			"VERDICT: PASS",
		].join("\n"))).toBe(false);
  });

  it("does not anchor a repair continuation on a malformed positive review", () => {
    const prompt = independentEvaluationRepairPrompt("All clauses pass.\nPROTOCOL: COMPLETE\nVERDICT: PASS");
    expect(prompt).toContain("claimed PASS");
    expect(prompt).toContain("not evidence");
    expect(prompt).not.toContain("All clauses pass");

    const failure = independentEvaluationRepairPrompt("CLAUSE discriminator: FAIL\nBLOCKING: string version accepted\nPROTOCOL: COMPLETE\nVERDICT: FAIL");
    expect(failure).toContain("string version accepted");
		expect(failure).toContain("fresh full clause-matrix");
		expect(failure).toContain("do not stop after the quoted clause");
		expect(failure).toContain("verbatim regression probe");
		expect(failure).toContain("do not reinterpret");
		expect(failure).toContain("whitespace-only values");
		expect(failure).toContain("state-transition identity/round trips");
		expect(failure).toContain("invalid handles or targets");
		expect(failure).toContain("absolute paths targeting both inside and outside");
		expect(failure).toContain("macOS /var versus /private/var");
		expect(failure).toContain("every removed export or entrypoint line");
		expect(failure).toContain("require-main guard");
		expect(failure).toContain("must not read process.argv or call process.exit");
  });

  it("requires adversarial clause tracing instead of trusting coerced ranges", () => {
    const prompt = buildIndependentEvaluatorPrompt({
      objective: "Implement CONTRACT.md",
      profile: "feature",
      changedFiles: ["src/normalize.js"],
      evidence: "npm test: passed",
      diff: "+ const port = Number(value.port)",
    });

    expect(prompt).toContain("clause matrix");
    expect(prompt).toContain("representation/type grammar");
    expect(prompt).toContain("Number.isInteger(Number(x))");
    expect(prompt).toContain("true, false, null, undefined");
    expect(prompt).toContain("Do not substitute easier examples");
		expect(prompt).toContain("exact literal such as version: 1 means the number 1 only");
		expect(prompt).toContain('"1", "2", "01", 0, 1, 2, 3');
    expect(prompt).toContain("Treat defaults as a separate acceptance boundary");
		expect(prompt).toContain("number, boolean, array, and object");
		expect(prompt).toContain("blank includes both empty and whitespace-only strings");
		expect(prompt).toContain("do not invent a canonical-format restriction");
		expect(prompt).toContain("does not authorize a catch-all non-v2 branch");
		expect(prompt).toContain("state-transition identity and round trips");
		expect(prompt).toContain("Restoring only payload while leaving the wrong active identity");
		expect(prompt).toContain("mutate returned nested objects to detect aliases");
		expect(prompt).toContain("absolute paths targeting both inside and outside");
		expect(prompt).toContain("traversal segments that normalize back inside");
		expect(prompt).toContain("macOS /var versus /private/var");
		expect(prompt).toContain("every removed export or entrypoint line");
		expect(prompt).toContain("Replacing it with a process-global-only");
		expect(prompt).toContain("must not read process.argv or call process.exit");
    expect(prompt).toContain("deleting the sibling is not a valid fix");
    expect(prompt).toContain("Never downgrade a known contract violation");
    expect(prompt.trim().endsWith("VERDICT: PASS or VERDICT: FAIL.")).toBe(true);
  });

	it("builds a second-pass counterexample falsifier that challenges a proposed pass", () => {
		const prompt = buildIndependentFalsifierPrompt({
			objective: "Implement CONTRACT.md",
			profile: "feature",
			changedFiles: ["src/normalize.js"],
			evidence: "npm test: passed",
			diff: "+ const host = value.host || '127.0.0.1'",
		}, "CLAUSE defaults: PASS\nBLOCKING: NONE\nPROTOCOL: COMPLETE\nVERDICT: PASS");

		expect(prompt).toContain("counterexample falsifier");
		expect(prompt).toContain("Candidate evaluation (untrusted)");
		expect(prompt).toContain("Only when missing or blank");
		expect(prompt).toContain("empty and whitespace-only strings");
		expect(prompt).toContain("leading zeroes");
		expect(prompt).toContain("catch-all non-v2 branch");
		expect(prompt).toContain("rewind/return");
		expect(prompt).toContain("nested mutable aliases");
		expect(prompt).toContain("absolute paths targeting both inside and outside");
		expect(prompt).toContain("macOS /var versus /private/var");
		expect(prompt).toContain("every removed export or entrypoint line");
		expect(prompt).toContain("require-main guard");
		expect(prompt).toContain("must not read process.argv or call process.exit");
		expect(prompt).toContain("Never relabel a known violation");
	});

	it("normalizes generated session titles without leaking reasoning or wrappers", () => {
		expect(normalizeGeneratedSessionName('<think>draft</think>\nНазвание сессии: "Исправить OAuth refresh."')).toBe("Исправить OAuth refresh");
		expect(normalizeGeneratedSessionName("Title: Refactor authentication middleware\nExplanation: ignored")).toBe("Refactor authentication middleware");
		expect(normalizeGeneratedSessionName("   ")).toBe("");
		expect(normalizeGeneratedSessionName("Очень длинное название сессии для переработки механизма автоматического именования и нескольких лишних подробностей").length).toBeLessThanOrEqual(64);
	});

	it("never auto-names subagent session files", () => {
		expect(isSubagentSessionFile("/Users/dev/.pi/agent/sessions/subagents/child/session.jsonl")).toBe(true);
		expect(isSubagentSessionFile("C:\\Users\\dev\\.pi\\agent\\sessions\\subagents\\child.jsonl")).toBe(true);
		expect(isSubagentSessionFile("/Users/dev/.pi/agent/sessions/project/session.jsonl")).toBe(false);
	});
});
