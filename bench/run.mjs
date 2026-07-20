#!/usr/bin/env node
/**
 * Бенчмарк агентного стека (ROADMAP §5.11-1, H3): headless-прогоны `pi -p`
 * на фиксированных задачах, метрики из jsonl сессии и harness-лога.
 *
 * Запуск:  node bench/run.mjs [--only id1,id2] [--timeout 240] [--label baseline]
 * Выход:   bench/results/<ts>-<label>.json + таблица в stdout.
 *
 * Метрики: success (детерминированный check), turns (assistant-сообщения),
 * toolCalls, loopScore (идентичные tool+args подряд), harness-события
 * (objective/verify-loop/strategy-note/checkpoint; старые nudge/loop/BLOCK
 * сохраняются для сопоставимости), finalCtx (input+cacheRead последнего ответа),
 * outTokens (суммарный output), duration.
 *
 * Судить по нему: сетки сэмплинга и каждое новое правило харнесса.
 */

import { execFileSync, execSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { cpus, freemem, homedir, loadavg, platform, release, tmpdir, totalmem, uptime } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tasks } from "./tasks.mjs";
import { longTasks } from "./long-tasks.mjs";
import { advancedTasks } from "./advanced-tasks.mjs";
import { commitFixtureBaseline, exposeUntrackedFixtureFiles } from "./fixture-git.mjs";
import { rotatedArmOrder } from "./schedule.mjs";
import { stageSkillForTrial } from "./skill-resource.mjs";
import { sandboxedPiCommand, sandboxedReadOnlyPiCommand } from "./macos-sandbox.mjs";
import { materializeTaskVerifierManifest } from "./task-verifiers.mjs";

const benchDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(benchDir);
const args = process.argv.slice(2);
const opt = (name, dflt) => {
	const i = args.indexOf(`--${name}`);
	return i >= 0 ? args[i + 1] : dflt;
};
const only = opt("only", "").split(",").filter(Boolean);
const timeoutS = Number(opt("timeout", "240"));
const label = opt("label", "baseline");
const suite = opt("suite", "smoke");
const model = opt("model", process.env.PI_BENCH_MODEL ?? "");
const harnessProfile = opt("harness", process.env.PI_APP_HARNESS_PROFILE ?? "");
const skill = opt("skill", "");
const repeats = Math.max(1, Number(opt("repeats", "1")) || 1);
const armNames = opt("arms", "").split(",").map((value) => value.trim()).filter(Boolean);
const judgeMode = opt("judge", "none");
const judgeTimeoutS = Math.max(30, Number(opt("judge-timeout", String(Math.min(timeoutS, 1_800)))) || 1_800);
// minimal по умолчанию — скорость итераций; сетка может гонять high
const thinking = opt("thinking", "minimal");
let activeChild = null;

const ARM_PRESETS = {
	baseline: { harnessProfile: "baseline", env: { PONYTAIL_DEFAULT_MODE: "off" } },
	workflow: { harnessProfile: "workflow", env: { PONYTAIL_DEFAULT_MODE: "off" } },
	full: { harnessProfile: "workflow", env: { PONYTAIL_DEFAULT_MODE: "full" } },
	ponytail: { harnessProfile: "workflow", env: { PONYTAIL_DEFAULT_MODE: "full" } },
	"no-classifier": { harnessProfile: "workflow", env: { PONYTAIL_DEFAULT_MODE: "full", PI_APP_HARNESS_ABLATIONS: "classifier" } },
	"no-repair-loop": { harnessProfile: "workflow", env: { PONYTAIL_DEFAULT_MODE: "full", PI_APP_HARNESS_ABLATIONS: "repair-loop" } },
	"no-semantic-gates": { harnessProfile: "workflow", env: { PONYTAIL_DEFAULT_MODE: "full", PI_APP_HARNESS_ABLATIONS: "semantic-gates" } },
	"no-ponytail": { harnessProfile: "workflow", env: { PONYTAIL_DEFAULT_MODE: "off", PI_APP_HARNESS_ABLATIONS: "ponytail" } },
};

const arms = armNames.length > 0
	? armNames.map((name) => {
		const preset = ARM_PRESETS[name];
		if (!preset) throw new Error(`Unknown arm ${name}. Known: ${Object.keys(ARM_PRESETS).join(", ")}`);
		if (preset.skill && !existsSync(preset.skill)) throw new Error(`Arm ${name} requires skill ${preset.skill}.`);
		return { name, ...preset };
	})
	: [{ name: label, harnessProfile: harnessProfile || "default", env: {}, ...(skill ? { skill } : {}) }];

function killActiveChild(signal = "SIGTERM") {
	const pid = activeChild?.pid;
	if (!pid) return;
	try {
		process.kill(-pid, signal);
	} catch {
		/* дочерний process group уже завершился */
	}
}

for (const signal of ["SIGINT", "SIGTERM"]) {
	process.on(signal, () => {
		killActiveChild("SIGTERM");
		process.exit(signal === "SIGINT" ? 130 : 143);
	});
}

function newestJsonl(dir) {
	try {
		const files = readdirSync(dir)
			.filter((f) => f.endsWith(".jsonl"))
			.map((f) => ({ f: join(dir, f), t: statSync(join(dir, f)).mtimeMs }))
			.sort((a, b) => b.t - a.t);
		return files[0]?.f ?? null;
	} catch {
		return null;
	}
}

function newestMainJsonl(dir) {
	try {
		const files = readdirSync(dir)
			.filter((file) => file.endsWith(".jsonl"))
			.map((file) => ({ path: join(dir, file), time: statSync(join(dir, file)).mtimeMs }))
			.sort((a, b) => b.time - a.time);
		return files.find((file) => {
			try { return readFileSync(file.path, "utf8").includes('"customType":"pi-app-workflow-state"'); } catch { return false; }
		})?.path ?? newestJsonl(dir);
	} catch {
		return null;
	}
}

function hashText(text) {
	return createHash("sha256").update(text).digest("hex");
}

function readOptional(path) {
	try { return readFileSync(path, "utf8"); } catch { return ""; }
}

function commandOutput(command, args = [], cwd = repoRoot) {
	try { return execFileSync(command, args, { cwd, encoding: "utf8", timeout: 10_000 }).trim(); } catch (error) { return String(error?.stderr ?? error?.message ?? error).slice(-2_000); }
}

function systemSnapshot() {
	const cpuList = cpus();
	return {
		at: new Date().toISOString(),
		platform: platform(),
		release: release(),
		cpuModel: cpuList[0]?.model ?? "unknown",
		cpuCount: cpuList.length,
		loadAverage: loadavg(),
		freeMemory: freemem(),
		totalMemory: totalmem(),
		uptime: uptime(),
	};
}

function provenance() {
	const agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
	const modelConfigText = readOptional(join(agentDir, "models.json"));
	const settingsText = readOptional(join(agentDir, "settings.json"));
	const harnessText = ["index.ts", "policy.ts", "workflow.ts", "workspace.ts"].map((file) => readOptional(join(repoRoot, "harness-extension", file))).join("\n---\n");
	const benchmarkText = ["run.mjs", "verify-final.mjs", "fixture-git.mjs", "task-verifiers.mjs", "regrade-report.mjs", "resume-workflow.mjs", "workflow-recovery.mjs", "workflow-resume-smoke.mjs", "schedule.mjs", "skill-resource.mjs", "macos-sandbox.mjs", "long-tasks.mjs", "advanced-tasks.mjs"]
		.map((file) => readOptional(join(benchDir, file))).join("\n---\n");
	let serverModels = null;
	try { serverModels = JSON.parse(commandOutput("curl", ["-fsS", "http://localhost:8003/v1/models"])); } catch { /* unavailable */ }
	let selectedModelConfig = null;
	try {
		const parsed = JSON.parse(modelConfigText);
		const models = Array.isArray(parsed) ? parsed : Object.values(parsed.providers ?? {}).flatMap((provider) => provider.models ?? []);
		selectedModelConfig = models.find((item) => !model || item.id === model.split("/").at(-1)) ?? null;
	} catch { /* malformed user config is captured by hash */ }
	return {
		gitHead: commandOutput("git", ["rev-parse", "HEAD"]),
		gitDiffHash: hashText(commandOutput("git", ["diff", "--binary"])),
		harnessHash: hashText(harnessText),
		benchmarkHash: hashText(benchmarkText),
		taskSuiteHash: hashText((suite === "all" ? ["tasks.mjs", "long-tasks.mjs", "advanced-tasks.mjs"] : [suite === "long" ? "long-tasks.mjs" : suite === "advanced" ? "advanced-tasks.mjs" : "tasks.mjs"])
			.map((file) => readOptional(join(benchDir, file))).join("\n---\n")),
		modelConfigHash: hashText(modelConfigText),
		settingsHash: hashText(settingsText),
		selectedModelConfig,
		serverModels,
		piVersion: commandOutput("pi", ["--version"]),
		extensions: commandOutput("pi", ["list"]),
		ponytailHead: commandOutput("git", ["-C", join(agentDir, "git/github.com/DietrichGebert/ponytail"), "rev-parse", "HEAD"]),
		nodeVersion: process.version,
		initialSystem: systemSnapshot(),
	};
}

/** Метрики из jsonl сессии pi (см. pi-rpc-wire-format). */
function sessionMetrics(file) {
	const m = {
		turns: 0,
		toolCalls: 0,
		loopScore: 0,
		finalCtx: 0,
		outTokens: 0,
		toolErrors: 0,
		toolNames: {},
		skillReads: 0,
		workflow: null,
		evaluatorRecords: 0,
		checkpointRecords: 0,
	};
	if (!file) return m;
	let lastSig = "";
	for (const line of readFileSync(file, "utf8").split("\n")) {
		let e;
		try {
			e = JSON.parse(line);
		} catch {
			continue;
		}
		if (e?.type === "custom" && e.customType === "pi-app-workflow-state" && e.data?.version === 3) {
			m.workflow = {
				runId: e.data.runId,
					profile: e.data.profile,
					approved: e.data.approved,
					autoLoops: e.data.autoLoops ?? 0,
					loopSignals: e.data.loopSignals ?? 0,
					changedFiles: e.data.changedFiles ?? [],
					steps: (e.data.steps ?? []).map(({ id, status, attempts }) => ({ id, status, attempts })),
				};
			}
			if (e?.type === "custom" && ["subagents:record", "pi-app-evaluator-record"].includes(e.customType) && e.data?.type === "independent-evaluator") m.evaluatorRecords++;
			if (e?.type === "custom" && e.customType === "pi-app-checkpoint") m.checkpointRecords++;
		const msg = e?.message;
		if (e?.type !== "message" || !msg) continue;
		if (msg.role === "toolResult" && msg.isError) m.toolErrors++;
		if (msg.role === "assistant") {
			m.turns++;
			const u = msg.usage ?? {};
			m.outTokens += u.output ?? 0;
			m.finalCtx = (u.input ?? 0) + (u.cacheRead ?? 0);
			for (const b of Array.isArray(msg.content) ? msg.content : []) {
				if (b?.type !== "toolCall") continue;
				m.toolCalls++;
				const toolName = String(b.name ?? "unknown");
				m.toolNames[toolName] = (m.toolNames[toolName] ?? 0) + 1;
				const toolArgs = b.arguments ?? b.input ?? {};
				const resourcePath = String(toolArgs.path ?? toolArgs.file_path ?? toolArgs.filePath ?? "");
				if (toolName === "read" && resourcePath.includes("pi-bench-skills")) m.skillReads++;
				let sig = String(b.name ?? "");
				try {
					sig += `:${JSON.stringify(toolArgs)}`;
				} catch {
					/* только имя */
				}
				if (sig === lastSig) m.loopScore++;
				lastSig = sig;
			}
		}
	}
	return m;
}

function gradeTask(task, cwd) {
	const criteria = task.criteria ?? [{ id: "check", command: task.check }];
	const checks = [];
	for (const criterion of criteria) {
		try {
			execSync(criterion.command, { cwd, stdio: "pipe", timeout: 60_000 });
			checks.push({ id: criterion.id, kind: criterion.kind ?? "outcome", passed: true });
		} catch (error) {
			const stdout = error?.stdout ? String(error.stdout) : "";
			const stderr = error?.stderr ? String(error.stderr) : "";
			checks.push({
				id: criterion.id,
				kind: criterion.kind ?? "outcome",
				passed: false,
				output: `${stdout}\n${stderr}`.trim().slice(-1000),
			});
		}
	}
	return {
		checks,
		graders: Object.fromEntries(["outcome", "static", "security"].map((kind) => {
			const group = checks.filter((check) => check.kind === kind);
			return [kind, { score: group.filter((check) => check.passed).length, maxScore: group.length, passed: group.every((check) => check.passed) }];
		})),
		score: checks.filter((check) => check.passed).length,
		maxScore: checks.length,
		success: checks.every((check) => check.passed),
	};
}

function diffMetrics(cwd, baseline) {
	try {
		const rows = execFileSync("git", ["diff", "--numstat", baseline, "--", "."], { cwd, encoding: "utf8" })
			.trim()
			.split("\n")
			.filter(Boolean);
		let insertions = 0;
		let deletions = 0;
		for (const row of rows) {
			const [added, removed] = row.split("\t");
			if (/^\d+$/.test(added)) insertions += Number(added);
			if (/^\d+$/.test(removed)) deletions += Number(removed);
		}
		return { changedFiles: rows.length, insertions, deletions, churn: insertions + deletions };
	} catch {
		return { changedFiles: 0, insertions: 0, deletions: 0, churn: 0 };
	}
}

function harnessEvents(cwd, workflow, checkpointRecords = 0) {
	try {
		const text = readFileSync(join(cwd, ".pi", "harness.log"), "utf8");
		return {
			objectives: workflow ? 1 : 0,
			verifyLoops: workflow?.autoLoops ?? 0,
			strategyNotes: workflow?.loopSignals ?? 0,
			checkpoints: checkpointRecords,
			evaluatorsStarted: (text.match(/waiting for evaluator eval-/g) ?? []).length,
			falsifiersStarted: (text.match(/waiting for evaluator falsifier /g) ?? []).length,
			evaluatorsCompleted: (text.match(/evaluator .* completed pass=/g) ?? []).length,
			nudges: (text.match(/ nudge: /g) ?? []).length,
			loops: (text.match(/ loop: /g) ?? []).length,
			blocks: (text.match(/ loop: BLOCK/g) ?? []).length,
		};
	} catch {
		return {
			objectives: workflow ? 1 : 0,
			verifyLoops: workflow?.autoLoops ?? 0,
			strategyNotes: workflow?.loopSignals ?? 0,
			checkpoints: checkpointRecords,
			evaluatorsStarted: 0,
			falsifiersStarted: 0,
			evaluatorsCompleted: 0,
			nudges: 0,
			loops: 0,
			blocks: 0,
		};
	}
}

async function runModelJudge(task, cwd, grade, arm, scratchRoot, agentRoot) {
	if (judgeMode !== "model" && judgeMode !== "all") return null;
	const prompt = [
		"You are an independent read-only judge. Inspect the actual repository and judge the original contract, hidden-risk boundaries, regressions, and security.",
		"Do not modify files. Deterministic verification results are supplied below; inspect source with read-only tools and do not trust the executor's final prose.",
		`Original task:\n${task.prompt}`,
		`Deterministic grader results:\n${JSON.stringify(grade.checks, null, 2)}`,
		"End with exactly JUDGE: PASS or JUDGE: FAIL and concise evidence.",
	].join("\n\n");
	const judgeArgs = ["-a", "--no-session", "--no-extensions", "--no-skills", "--no-context-files", "--tools", "read,grep,find,ls", "--thinking", thinking];
	if (model) judgeArgs.push("--model", model);
	judgeArgs.push("-p", prompt);
	return new Promise((resolve) => {
		const judgeScratch = realpathSync(mkdtempSync(join(tmpdir(), "pibench-judge-")));
		const judgeAgentRoot = join(judgeScratch, "agent");
		mkdirSync(judgeAgentRoot, { recursive: true });
		for (const file of ["models.json", "auth.json", "settings.json"]) {
			if (existsSync(join(agentRoot, file))) cpSync(join(agentRoot, file), join(judgeAgentRoot, file));
		}
		const invocation = sandboxedReadOnlyPiCommand(judgeArgs, repoRoot, [cwd], judgeScratch);
		const child = spawn(invocation.command, invocation.args, {
			cwd,
			stdio: ["ignore", "pipe", "pipe"],
			detached: true,
			env: { ...process.env, PI_CODING_AGENT_DIR: judgeAgentRoot, PONYTAIL_DEFAULT_MODE: "off", TMPDIR: judgeScratch, TMP: judgeScratch, TEMP: judgeScratch },
		});
		let output = "";
		child.stdout.on("data", (data) => { output += data; });
		child.stderr.on("data", (data) => { output += data; });
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			try { process.kill(-child.pid, "SIGKILL"); } catch { /* done */ }
		}, judgeTimeoutS * 1_000);
		child.on("close", () => {
			clearTimeout(timer);
			const verdicts = [...output.matchAll(/\bJUDGE\s*:\s*(PASS|FAIL)\b/gi)];
			const verdict = verdicts.at(-1)?.[1]?.toLowerCase();
			const reply = {
				arm: arm.name,
				passed: verdict === "pass",
				failed: verdict === "fail",
				verdict: verdict ?? "missing",
				timedOut,
				output: output.trim().slice(-8_000),
			};
			rmSync(judgeScratch, { recursive: true, force: true });
			resolve(reply);
		});
	});
}

function humanJudgeRecord(reviewId) {
	if (judgeMode !== "human" && judgeMode !== "all") return null;
	return {
		status: "pending-independent-review",
		reviewId,
		blindPacket: "separate-file",
	};
}

function humanReviewPacket(task, grade, cwd, reviewId, baseline) {
	if (judgeMode !== "human" && judgeMode !== "all") return null;
	return {
		reviewId,
		status: "pending-independent-review",
		rubric: [
			"Does the observable outcome satisfy the original request, including implicit edge cases?",
			"Is the implementation coherent, safe, and appropriately scoped?",
			"Is the verification evidence sufficient and free of masked failures?",
			"Are UI/UX or human-facing behaviors understandable and reversible?",
		],
		taskId: task.id,
		objective: task.prompt,
		imageFiles: task.imageFiles ?? [],
		deterministicEvidence: grade.checks,
		diff: commandOutput("git", ["diff", "--no-ext-diff", baseline, "--", "."], cwd).slice(0, 120_000),
		reviewerFields: {
			verdict: "PENDING",
			scores: { outcome: null, coherence: null, evidence: null, uxSafety: null },
			blockingFindings: [],
			notes: "",
		},
	};
}

function runTask(task, arm, trial, onCheckpoint = () => {}) {
	// realpath: macOS tmpdir — симлинк /var/folders → /private/var; pi пишет
	// каталог сессий по каноническому пути
	const cwd = realpathSync(mkdtempSync(join(tmpdir(), `pibench-${task.id}-${arm.name}-${trial}-`)));
	execSync("git init -q .", { cwd });
	writeFileSync(join(cwd, ".git", "info", "exclude"), ".pi/\n");
	const scratchRoot = join(cwd, ".pi", "tmp");
	const agentRoot = join(cwd, ".pi", "agent");
	const sessionRoot = join(agentRoot, "sessions");
	mkdirSync(scratchRoot, { recursive: true });
	mkdirSync(sessionRoot, { recursive: true });
	const sourceAgentRoot = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
	for (const file of ["models.json", "auth.json", "AGENTS.md", "subagents.json"]) {
		if (existsSync(join(sourceAgentRoot, file))) cpSync(join(sourceAgentRoot, file), join(agentRoot, file));
	}
	writeFileSync(join(agentRoot, "settings.json"), JSON.stringify({
		defaultProvider: "ollama",
		defaultModel: "ThinkingCap-Qwen3.6-27B-oQ4e-DWQ-MTP-Vision",
		defaultThinkingLevel: thinking,
		packages: [],
		compaction: { reserveTokens: 32768, keepRecentTokens: 24000 },
	}, null, 2));
	for (const [rel, content] of Object.entries(task.files)) {
		const p = join(cwd, rel);
		mkdirSync(dirname(p), { recursive: true });
		writeFileSync(p, content);
	}
	// Expose only explicitly public task verifiers. Static/security benchmark
	// graders remain outside the workspace and cannot leak into the model prompt.
	materializeTaskVerifierManifest(cwd, task);
	// Make the fixture a real baseline so diff inspection is meaningful. Without
	// an initial commit every source file is merely untracked and `git diff` is empty.
	const fixtureBaseline = commitFixtureBaseline(cwd);

	const t0 = Date.now();
	const res = { id: task.id, category: task.category ?? suite, arm: arm.name, trial, success: false, timedOut: false, durationS: 0, systemBefore: systemSnapshot() };
	const piArgs = [
		"--no-approve",
		"--no-extensions",
		"--extension", join(repoRoot, "harness-extension", "index.ts"),
		"--extension", join(sourceAgentRoot, "git/github.com/DietrichGebert/ponytail/pi-extension/index.js"),
		"--extension", join(sourceAgentRoot, "npm/node_modules/@tintinweb/pi-subagents/src/index.ts"),
		"--no-skills",
		"--session-dir", sessionRoot,
		"--thinking", thinking,
	];
	if (model) piArgs.push("--model", model);
	// A skill arm must expose exactly the skill under test. Otherwise Pi also
	// discovers every global skill and the experiment measures attention pollution.
	const requestedSkill = arm.skill ?? skill;
	const skillResource = requestedSkill ? stageSkillForTrial(cwd, requestedSkill) : null;
	const activeSkill = skillResource?.targetSkill;
	if (activeSkill) piArgs.push("--skill", activeSkill);
	piArgs.push("-p");
	for (const imagePath of task.imageFiles ?? []) piArgs.push(`@${imagePath}`);
	const skillName = activeSkill
		? readOptional(activeSkill).match(/^name:\s*["']?([^\n"']+)/m)?.[1]?.trim()
		: null;
	const treatmentPrompt = skillName
		? `Before acting, load the supplied ${skillName} skill exactly once and follow it for this task. Keep every write inside the current working directory.\n\n${task.prompt}`
		: task.prompt;
	piArgs.push(treatmentPrompt);
	const invocation = sandboxedPiCommand(piArgs, repoRoot, true, cwd, activeSkill ? [dirname(activeSkill)] : []);
	const child = spawn(invocation.command, invocation.args, {
		cwd,
		stdio: ["ignore", "pipe", "pipe"],
		detached: true, // своя process group: таймаут убивает pi вместе с детьми
			env: {
				...process.env,
				PI_CODING_AGENT_DIR: agentRoot,
				TMPDIR: scratchRoot,
				TMP: scratchRoot,
				TEMP: scratchRoot,
			PI_APP_HARNESS_LOG: "1",
			PI_APP_HARNESS_WAIT_FOR_BACKGROUND: "1",
			// Use the same explicit budget for the in-harness read-only evaluator
			// and the post-run blind model judge. Slow local reasoning models should
			// not be scored as semantic failures merely because one layer retained
			// the historical 300s default.
			PI_APP_HARNESS_EVALUATOR_TIMEOUT_MS:
				process.env.PI_APP_HARNESS_EVALUATOR_TIMEOUT_MS ?? String(judgeTimeoutS * 1_000),
			// Local reasoning models can spend more than 90s before the first streamed
			// event. Keep the benchmark's own hard timeout, but disable pi-retry's
			// first-token stall watchdog so it does not invalidate the trial.
			PI_RETRY_STALL_TIMEOUT_MS: process.env.PI_RETRY_STALL_TIMEOUT_MS ?? "0",
			...(arm.harnessProfile && arm.harnessProfile !== "default" ? { PI_APP_HARNESS_PROFILE: arm.harnessProfile } : {}),
			...arm.env,
		},
	});
	activeChild = child;
	let out = "";
	child.stdout.on("data", (d) => (out += d));
	child.stderr.on("data", (d) => (out += d));

	return new Promise((resolve) => {
		const killer = setTimeout(() => {
			res.timedOut = true;
			try {
				process.kill(-child.pid, "SIGKILL");
			} catch {
				/* уже вышел */
			}
		}, timeoutS * 1000);

		child.on("close", async () => {
			if (activeChild === child) activeChild = null;
			clearTimeout(killer);
			try {
				exposeUntrackedFixtureFiles(cwd);
			} catch (error) {
				res.diffPreparationError = String(error?.message ?? error);
			}
			res.durationS = Math.round((Date.now() - t0) / 10) / 100;
			const grade = gradeTask(task, cwd);
			Object.assign(res, grade);
			Object.assign(res, sessionMetrics(newestMainJsonl(sessionRoot)));
			res.treatmentAdherence = {
				requiredSkill: skillName,
				expectedSkillReads: activeSkill ? 1 : 0,
				observedSkillReads: res.skillReads,
				passed: activeSkill ? res.skillReads === 1 : true,
			};
			const workflowRequired = arm.harnessProfile === "workflow";
			res.workflowCompleted = res.workflow
				? res.workflow.steps.length > 0 && res.workflow.steps.every((step) => ["passed", "skipped"].includes(step.status))
				: workflowRequired ? false : null;
			res.diff = diffMetrics(cwd, fixtureBaseline);
			res.harness = harnessEvents(cwd, res.workflow, res.checkpointRecords);
			res.workspace = cwd;
			res.tail = out.trim().split("\n").slice(-2).join(" | ").slice(0, 200);
			res.systemAfter = systemSnapshot();
			if (skillResource) {
				const sourceHashAfter = hashText(readOptional(skillResource.sourceSkill));
				const targetHashAfter = hashText(readOptional(skillResource.targetSkill));
				res.skillResource = { ...skillResource, sourceHashAfter, targetHashAfter };
				if (sourceHashAfter !== skillResource.sourceHash || targetHashAfter !== skillResource.targetHash) {
					res.sandboxViolation = sourceHashAfter !== skillResource.sourceHash
						? `Source skill changed during trial: ${skillResource.sourceSkill}`
						: `Staged read-only skill changed during trial: ${skillResource.targetSkill}`;
					res.success = false;
				}
			}
			// Outcome grading and treatment completion are deliberately separate.
			// A lucky patch whose required harness workflow rejected it is not a
			// successful treatment, while its deterministic score remains observable.
			res.treatmentSuccess = res.success
				&& res.treatmentAdherence.passed
				&& !res.diffPreparationError
				&& (!workflowRequired || res.workflowCompleted === true);
			// Persist the expensive executor/evaluator outcome before starting the
			// optional blind model judge. A closed terminal or killed parent must not
			// erase hours of already completed local-model work.
			onCheckpoint(res, "executor-complete");
			res.modelJudge = await runModelJudge(task, cwd, grade, arm, scratchRoot, agentRoot);
			const reviewId = `review-${hashText(`${Date.now()}-${cwd}`).slice(0, 16)}`;
			res.humanJudge = humanJudgeRecord(reviewId);
			res._humanReviewPacket = humanReviewPacket(task, grade, cwd, reviewId, fixtureBaseline);
			onCheckpoint(res, "judge-complete");
			resolve(res);
		});
	});
}

const suiteTasks = suite === "long" ? longTasks : suite === "advanced" ? advancedTasks : suite === "all" ? [...tasks, ...longTasks, ...advancedTasks] : tasks;
const selectedBase = suiteTasks.filter((t) => only.length === 0 || only.includes(t.id));
const selected = [];
for (let trial = 1; trial <= repeats; trial++) {
	for (let taskIndex = 0; taskIndex < selectedBase.length; taskIndex++) {
		const task = selectedBase[taskIndex];
		// Rotate arm order so warm-up, load drift, and time-of-day do not
		// systematically favor the same arm. Do not combine reversal and rotation:
		// for two arms they cancel each other and silently keep arm 0 first.
		const order = rotatedArmOrder(arms, trial, taskIndex);
		for (const arm of order) selected.push({ task, arm, trial });
	}
}
console.log(
	`bench: suite=${suite}, ${selected.length} запусков, таймаут ${timeoutS}с, ` +
		`model=${model || "default"}, arms=${arms.map((arm) => arm.name).join(",")}, repeats=${repeats}, judge=${judgeMode}`,
);
const benchmarkProvenance = provenance();
const results = [];
const outDir = join(benchDir, "results");
mkdirSync(outDir, { recursive: true });
const reportStamp = new Date().toISOString().replace(/[:.]/g, "-");
const progressFile = join(outDir, `${reportStamp}-${label}.progress.json`);
const progressRows = new Map();
function progressKey(row) {
	return `${row.id}:${row.arm}:${row.trial}`;
}
function writeJsonAtomic(path, value) {
	const temporary = `${path}.tmp-${process.pid}`;
	writeFileSync(temporary, JSON.stringify(value, null, 2));
	renameSync(temporary, path);
}
function checkpointResult(row, phase) {
	progressRows.set(progressKey(row), structuredClone(row));
	writeJsonAtomic(progressFile, {
		version: 1,
		status: "running",
		phase,
		updatedAt: new Date().toISOString(),
		label,
		suite,
		model: model || "default",
		thinking,
		judgeMode,
		judgeTimeoutS,
		repeats,
		arms: arms.map((arm) => ({ name: arm.name, harnessProfile: arm.harnessProfile, env: arm.env, skill: arm.skill ?? null })),
		trialOrder: selected.map((job) => ({ task: job.task.id, arm: job.arm.name, trial: job.trial })),
		provenance: benchmarkProvenance,
		results: [...progressRows.values()],
	});
}
writeJsonAtomic(progressFile, {
	version: 1,
	status: "running",
	phase: "initialized",
	updatedAt: new Date().toISOString(),
	label,
	suite,
	model: model || "default",
	thinking,
	judgeMode,
	judgeTimeoutS,
	repeats,
	arms: arms.map((arm) => ({ name: arm.name, harnessProfile: arm.harnessProfile, env: arm.env, skill: arm.skill ?? null })),
	trialOrder: selected.map((job) => ({ task: job.task.id, arm: job.arm.name, trial: job.trial })),
	provenance: benchmarkProvenance,
	results: [],
});
for (const job of selected) {
	process.stdout.write(`▶ ${job.task.id} · ${job.arm.name} · trial ${job.trial} … `);
	const r = await runTask(job.task, job.arm, job.trial, checkpointResult);
	results.push(r);
	console.log(
		`${r.success ? (r.timedOut ? "✅⏱ (решено, но ран убит по таймауту)" : "✅") : r.timedOut ? "⏱ TIMEOUT" : "❌"} ${r.durationS}s · treatment=${r.treatmentSuccess ? "accepted" : "rejected"} score=${r.score}/${r.maxScore} turns=${r.turns} tools=${r.toolCalls} skillReads=${r.skillReads} errors=${r.toolErrors} loop=${r.loopScore} ctx=${r.finalCtx} out=${r.outTokens} diff=${r.diff.churn} harness=${JSON.stringify(r.harness)}`,
	);
}

const summary = {
	label,
	suite,
	date: new Date().toISOString(),
	model: model || "default",
	skill: skill || null,
	thinking,
	harnessProfile: harnessProfile || "default",
	arms: arms.map((arm) => ({ name: arm.name, harnessProfile: arm.harnessProfile, env: arm.env, skill: arm.skill ?? null, skillHash: arm.skill ? hashText(readOptional(arm.skill)) : null })),
	judgeMode,
	judgeTimeoutS,
	benchmarkSandbox: sandboxedPiCommand([], repoRoot, true, "/__pi_bench_fixture__").mode,
	repeats,
	trialOrder: selected.map((job) => ({ task: job.task.id, arm: job.arm.name, trial: job.trial })),
	provenance: benchmarkProvenance,
	finalSystem: systemSnapshot(),
	passed: results.filter((r) => r.success).length,
	treatmentPassed: results.filter((r) => r.treatmentSuccess).length,
	total: results.length,
	byArm: Object.fromEntries(arms.map((arm) => {
		const rows = results.filter((result) => result.arm === arm.name);
		return [arm.name, {
			passed: rows.filter((row) => row.success).length,
			treatmentPassed: rows.filter((row) => row.treatmentSuccess).length,
			workflowCompleted: rows.filter((row) => row.workflowCompleted === true).length,
			total: rows.length,
			meanScore: rows.length ? rows.reduce((sum, row) => sum + row.score / Math.max(1, row.maxScore), 0) / rows.length : 0,
			meanDurationS: rows.length ? rows.reduce((sum, row) => sum + row.durationS, 0) / rows.length : 0,
			meanLoopScore: rows.length ? rows.reduce((sum, row) => sum + row.loopScore, 0) / rows.length : 0,
			meanSkillReads: rows.length ? rows.reduce((sum, row) => sum + (row.skillReads ?? 0), 0) / rows.length : 0,
		}];
	})),
	results,
};
const humanReviewPackets = results
	.map((result) => result._humanReviewPacket)
	.filter(Boolean)
	.sort((left, right) => left.reviewId.localeCompare(right.reviewId));
for (const result of results) delete result._humanReviewPacket;
const outFile = join(outDir, `${reportStamp}-${label}.json`);
writeJsonAtomic(outFile, summary);
if (humanReviewPackets.length > 0) {
	const blindFile = join(outDir, `${reportStamp}-${label}-human-review-blind.json`);
	writeFileSync(blindFile, JSON.stringify({
		label: "blind-independent-review",
		instructions: "Score packets without opening the paired benchmark report. Arm, trial, workspace, and scheduling order are intentionally omitted.",
		packets: humanReviewPackets,
	}, null, 2));
	console.log(`Blind human review: ${blindFile}`);
}
writeJsonAtomic(progressFile, {
	version: 1,
	status: "completed",
	phase: "report-written",
	updatedAt: new Date().toISOString(),
	report: outFile,
	label,
	suite,
	results,
});
console.log(`\nИтог: ${summary.passed}/${summary.total} · отчёт: ${outFile}`);
