#!/usr/bin/env node

import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sandboxedPiCommand } from "./macos-sandbox.mjs";

const required = new Map([
	["mcp", "npm:pi-mcp-adapter"],
	["mcp-auth", "npm:pi-mcp-adapter"],
	["todos", "npm:@juicesharp/rpiv-todo"],
	["permission-system", "npm:@gotgenes/pi-permission-system"],
	["cc-tools", "npm:pi-claude-style-tools"],
	["cc-theme", "npm:pi-claude-style-tools"],
	["cc-spinner", "npm:pi-claude-style-tools"],
	["statusline", "npm:@narumitw/pi-statusline"],
	["plannotator", "npm:@plannotator/pi-extension"],
	["plannotator-review", "npm:@plannotator/pi-extension"],
	["plannotator-annotate", "npm:@plannotator/pi-extension"],
	["plannotator-last", "npm:@plannotator/pi-extension"],
	["pi-rewind", "../../GithubControl/pi-app/harness-extension"],
	["pi-workflow", "../../GithubControl/pi-app/harness-extension"],
	["pi-task", "../../GithubControl/pi-app/harness-extension"],
	["pi-branch-return", "../../GithubControl/pi-app/harness-extension"],
	["websearch", "npm:pi-web-access"],
	["curator", "npm:pi-web-access"],
	["google-account", "npm:pi-web-access"],
	["search", "npm:pi-web-access"],
	["agents", "npm:@tintinweb/pi-subagents"],
	["ponytail", "git:github.com/DietrichGebert/ponytail"],
	["ponytail-review", "git:github.com/DietrichGebert/ponytail"],
	["ponytail-audit", "git:github.com/DietrichGebert/ponytail"],
	["ponytail-gain", "git:github.com/DietrichGebert/ponytail"],
	["ponytail-debt", "git:github.com/DietrichGebert/ponytail"],
	["ponytail-help", "git:github.com/DietrichGebert/ponytail"],
	["skill:ponytail", "git:github.com/DietrichGebert/ponytail"],
	["skill:ponytail-review", "git:github.com/DietrichGebert/ponytail"],
	["skill:ponytail-audit", "git:github.com/DietrichGebert/ponytail"],
	["skill:ponytail-gain", "git:github.com/DietrichGebert/ponytail"],
	["skill:ponytail-debt", "git:github.com/DietrichGebert/ponytail"],
	["skill:ponytail-help", "git:github.com/DietrichGebert/ponytail"],
]);

const requiredTools = new Map([
	["mcp", "npm:pi-mcp-adapter"],
	["todo", "npm:@juicesharp/rpiv-todo"],
	["ask_user_question", "npm:@juicesharp/rpiv-ask-user-question"],
	["plannotator_submit_plan", "npm:@plannotator/pi-extension"],
	["web_search", "npm:pi-web-access"],
	["fetch_content", "npm:pi-web-access"],
	["get_search_content", "npm:pi-web-access"],
	["Agent", "npm:@tintinweb/pi-subagents"],
	["get_subagent_result", "npm:@tintinweb/pi-subagents"],
	["steer_subagent", "npm:@tintinweb/pi-subagents"],
	["live_preview", "../../GithubControl/pi-app/harness-extension"],
	["agent_browser", "npm:pi-agent-browser-native"],
]);

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const cwd = realpathSync(mkdtempSync(join(tmpdir(), "pi-runtime-command-smoke-")));
const scratch = join(cwd, ".pi", "tmp");
mkdirSync(scratch, { recursive: true });
// Force Pi's normal project-trust lookup instead of testing only a workspace
// without local resources (which never touches trust.json.lock).
writeFileSync(join(cwd, ".pi", "settings.json"), "{}\n");
mkdirSync(join(cwd, ".pi", "extensions", "pi-permission-system"), { recursive: true });
writeFileSync(
	join(cwd, ".pi", "extensions", "pi-permission-system", "config.json"),
	'{"permissionReviewLog":true}\n',
);
const agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
const permissionLogs = join(agentDir, "extensions", "pi-permission-system", "logs");
const permissionReviewLog = join(permissionLogs, "pi-permission-system-permission-review.jsonl");
const reviewBytesBefore = (() => {
	try { return statSync(permissionReviewLog).size; } catch { return 0; }
})();
const runtimeState = [
  "settings.json.lock",
  "auth.json",
  "auth.json.lock",
  "models-store.json",
  "models-store.json.lock",
  "trust.json",
  "trust.json.lock",
  "mcp-cache.json",
  "mcp-npx-cache.json",
  "mcp-onboarding.json",
  "mcp-oauth",
].map((name) => join(agentDir, name));
runtimeState.push(permissionLogs);
// Keep the normal project-trust path enabled. Pi 0.81+ takes a trust.json.lock
// even for read-only trust lookup, so --no-approve would hide a broken sandbox
// allowlist and let the exact app-start regression escape this smoke test.
const invocation = sandboxedPiCommand([
	"--extension", join(repoRoot, "bench", "extension-surface-probe.mjs"),
	"--mode", "rpc", "--no-session", "--offline",
], repoRoot, true, cwd, [], runtimeState);
const child = spawn(invocation.command, invocation.args, {
	cwd,
	stdio: ["pipe", "pipe", "pipe"],
	env: { ...process.env, TMPDIR: scratch, TMP: scratch, TEMP: scratch },
});
let buffer = "";
let stderr = "";
const events = [];
child.stderr.on("data", (chunk) => { stderr += chunk; });

const result = await new Promise((resolve, reject) => {
	const timer = setTimeout(() => reject(new Error(`RPC timeout: ${stderr.slice(-1_000)}`)), 30_000);
	child.stdout.on("data", (chunk) => {
		buffer += chunk;
		let newline;
		while ((newline = buffer.indexOf("\n")) >= 0) {
			const line = buffer.slice(0, newline);
			buffer = buffer.slice(newline + 1);
			let event;
			try { event = JSON.parse(line); } catch { continue; }
			events.push(event);
			if (event.type !== "response" || event.id !== "commands") continue;
			clearTimeout(timer);
			if (!event.success) reject(new Error(event.error ?? "get_commands failed"));
			else resolve(event.data);
		}
	});
	child.stdin.write(`${JSON.stringify({ id: "commands", type: "get_commands" })}\n`);
});

child.kill("SIGTERM");
rmSync(cwd, { recursive: true, force: true });
const names = (result.commands ?? []).map((command) => command.name);
const missing = [...required.keys()].filter((name) => !names.includes(name));
const wrongSources = (result.commands ?? []).flatMap((command) => {
	const expected = required.get(command.name);
	const actual = command.sourceInfo?.source;
	return expected && actual !== expected ? [`${command.name}: ${actual ?? "missing"} (expected ${expected})`] : [];
});
const permissionLogErrors = events.flatMap((event) => {
	if (event.type !== "extension_ui_request" || event.method !== "notify") return [];
	const message = String(event.message ?? "");
	return message.includes("Failed to write permission-system") ? [message] : [];
});
const toolProbeEvent = events.find((event) =>
	event.type === "extension_ui_request" &&
	event.method === "setWidget" &&
	event.widgetKey === "pi-app-extension-surface-probe"
);
const tools = (() => {
	try { return JSON.parse((toolProbeEvent?.widgetLines ?? []).join("\n")); } catch { return []; }
})();
const toolByName = new Map(tools.map((tool) => [tool.name, tool]));
const missingTools = [...requiredTools.keys()].filter((name) => !toolByName.has(name));
const wrongToolSources = [...requiredTools].flatMap(([name, expected]) => {
	const actual = toolByName.get(name)?.source;
	return toolByName.has(name) && actual !== expected
		? [`${name}: ${actual ?? "missing"} (expected ${expected})`]
		: [];
});
const reviewBytesAfter = (() => {
	try { return statSync(permissionReviewLog).size; } catch { return 0; }
})();
if (missing.length > 0 || wrongSources.length > 0 || missingTools.length > 0 || wrongToolSources.length > 0 || permissionLogErrors.length > 0 || reviewBytesAfter <= reviewBytesBefore) {
	throw new Error([
		missing.length > 0 ? `Missing runtime commands: ${missing.join(", ")}` : "",
		wrongSources.length > 0 ? `Wrong command sources: ${wrongSources.join(", ")}` : "",
		missingTools.length > 0 ? `Missing runtime tools: ${missingTools.join(", ")}` : "",
		wrongToolSources.length > 0 ? `Wrong tool sources: ${wrongToolSources.join(", ")}` : "",
		permissionLogErrors.length > 0 ? permissionLogErrors.join("\n") : "",
		reviewBytesAfter <= reviewBytesBefore ? `Permission review log was not appended: ${permissionReviewLog}` : "",
		`Loaded: ${names.join(", ")}`,
		stderr.slice(-4_000),
	].filter(Boolean).join("\n"));
}
console.log(JSON.stringify({
	passed: true,
	commandCount: names.length,
	toolCount: tools.length,
	required: [...required.keys()],
	requiredTools: [...requiredTools.keys()],
	permissionReviewLog,
	permissionReviewBytesAppended: reviewBytesAfter - reviewBytesBefore,
}));
