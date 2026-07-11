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
 * (nudge/loop/BLOCK), finalCtx (input+cacheRead последнего ответа),
 * outTokens (суммарный output), duration.
 *
 * Судить по нему: сетки сэмплинга и каждое новое правило харнесса.
 */

import { execSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tasks } from "./tasks.mjs";

const args = process.argv.slice(2);
const opt = (name, dflt) => {
	const i = args.indexOf(`--${name}`);
	return i >= 0 ? args[i + 1] : dflt;
};
const only = opt("only", "").split(",").filter(Boolean);
const timeoutS = Number(opt("timeout", "240"));
const label = opt("label", "baseline");
// minimal по умолчанию — скорость итераций; сетка может гонять high
const thinking = opt("thinking", "minimal");

/** Каталог сессий pi для cwd: --{cwd без ведущего /, [/\:]→-}--  */
function sessionDirFor(cwd) {
	const enc = `--${cwd.replace(/^\//, "").replace(/[/\\:]/g, "-")}--`;
	return join(homedir(), ".pi", "agent", "sessions", enc);
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

/** Метрики из jsonl сессии pi (см. pi-rpc-wire-format). */
function sessionMetrics(file) {
	const m = { turns: 0, toolCalls: 0, loopScore: 0, finalCtx: 0, outTokens: 0 };
	if (!file) return m;
	let lastSig = "";
	for (const line of readFileSync(file, "utf8").split("\n")) {
		let e;
		try {
			e = JSON.parse(line);
		} catch {
			continue;
		}
		const msg = e?.message;
		if (e?.type !== "message" || !msg) continue;
		if (msg.role === "assistant") {
			m.turns++;
			const u = msg.usage ?? {};
			m.outTokens += u.output ?? 0;
			m.finalCtx = (u.input ?? 0) + (u.cacheRead ?? 0);
			for (const b of Array.isArray(msg.content) ? msg.content : []) {
				if (b?.type !== "toolCall") continue;
				m.toolCalls++;
				let sig = String(b.name ?? "");
				try {
					sig += `:${JSON.stringify(b.arguments ?? b.input ?? {})}`;
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

function harnessEvents(cwd) {
	try {
		const text = readFileSync(join(cwd, ".pi", "harness.log"), "utf8");
		return {
			nudges: (text.match(/ nudge: /g) ?? []).length,
			loops: (text.match(/ loop: /g) ?? []).length,
			blocks: (text.match(/ loop: BLOCK/g) ?? []).length,
		};
	} catch {
		return { nudges: 0, loops: 0, blocks: 0 };
	}
}

function runTask(task) {
	// realpath: macOS tmpdir — симлинк /var/folders → /private/var; pi пишет
	// каталог сессий по каноническому пути
	const cwd = realpathSync(mkdtempSync(join(tmpdir(), `pibench-${task.id}-`)));
	execSync("git init -q .", { cwd });
	for (const [rel, content] of Object.entries(task.files)) {
		const p = join(cwd, rel);
		mkdirSync(dirname(p), { recursive: true });
		writeFileSync(p, content);
	}

	const t0 = Date.now();
	const res = { id: task.id, success: false, timedOut: false, durationS: 0 };
	const child = spawn("pi", ["-a", "--thinking", thinking, "-p", task.prompt], {
		cwd,
		stdio: ["ignore", "pipe", "pipe"],
		detached: true, // своя process group: таймаут убивает pi вместе с детьми
		env: { ...process.env, PI_APP_HARNESS_LOG: "1" },
	});
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

		child.on("close", () => {
			clearTimeout(killer);
			res.durationS = Math.round((Date.now() - t0) / 10) / 100;
			try {
				execSync(task.check, { cwd, stdio: "ignore", timeout: 30000 });
				res.success = true;
			} catch {
				res.success = false;
			}
			Object.assign(res, sessionMetrics(newestJsonl(sessionDirFor(cwd))));
			res.harness = harnessEvents(cwd);
			res.tail = out.trim().split("\n").slice(-2).join(" | ").slice(0, 200);
			resolve(res);
		});
	});
}

const selected = tasks.filter((t) => only.length === 0 || only.includes(t.id));
console.log(`bench: ${selected.length} задач, таймаут ${timeoutS}с, label=${label}`);
const results = [];
for (const t of selected) {
	process.stdout.write(`▶ ${t.id} … `);
	const r = await runTask(t);
	results.push(r);
	console.log(
		`${r.success ? (r.timedOut ? "✅⏱ (решено, но ран убит по таймауту)" : "✅") : r.timedOut ? "⏱ TIMEOUT" : "❌"} ${r.durationS}s · turns=${r.turns} tools=${r.toolCalls} loop=${r.loopScore} ctx=${r.finalCtx} out=${r.outTokens} harness=${JSON.stringify(r.harness)}`,
	);
}

const summary = {
	label,
	date: new Date().toISOString(),
	model: process.env.PI_BENCH_MODEL ?? "default",
	passed: results.filter((r) => r.success).length,
	total: results.length,
	results,
};
const outDir = join(dirname(fileURLToPath(import.meta.url)), "results");
mkdirSync(outDir, { recursive: true });
const outFile = join(outDir, `${new Date().toISOString().replace(/[:.]/g, "-")}-${label}.json`);
writeFileSync(outFile, JSON.stringify(summary, null, 2));
console.log(`\nИтог: ${summary.passed}/${summary.total} · отчёт: ${outFile}`);
