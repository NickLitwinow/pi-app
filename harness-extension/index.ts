/**
 * pi-app-harness — воркфлоу-харнесс pi-app (ROADMAP §5.1, issue #16).
 *
 * Три поведения, все — ЭФЕМЕРНЫЕ system-reminder'ы, добавляемые в контекст
 * конкретного LLM-вызова через событие `context` (в сессию/чат не пишутся,
 * токены не накапливаются в истории):
 *
 *  1. todo-first — нетривиальный промпт → напоминание составить todo-план до действий;
 *  2. verify-before-done — после edit/write, пока не выполнена ни одна команда,
 *     каждый вызов получает напоминание прогнать проверки (см. skill verify);
 *  3. skill-router (уровень 2) — промпт матчится по триггерам на установленный
 *     скилл → «прочитай его SKILL.md и следуй ему».
 *
 * Анти-шум: слэш-команды игнорируются; todo/skill-наджи — один раз за ран;
 * verify-надж — максимум 2 раза за ран (35B склонна к лупам от повторов).
 * Выключатель: PI_APP_HARNESS=0. Отладочный лог: PI_APP_HARNESS_LOG=1 →
 * .pi/harness.log в рабочем каталоге.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type SkillInfo = { name: string; description?: string };

const TODO_NUDGE =
	"This looks like a multi-step task. BEFORE acting: create a todo list " +
	"(use the todo tool if available, otherwise write a short numbered plan, 3–7 items), " +
	"then work through it, keeping statuses current.";

const VERIFY_NUDGE =
	"Files were modified in this run and no command has been executed since. " +
	"Before declaring the task complete: run the project's checks/tests " +
	"(follow the verify skill if installed) and report their REAL output.";

/** Триггеры → имя скилла. Подсказываем только если скилл реально установлен.
 *  ВАЖНО: `\b` в JS-регэкспах не работает с кириллицей (не входит в \w) —
 *  для русских основ используем голые вхождения, для коротких английских
 *  токенов — явные границы. */
const SKILL_TRIGGERS: Array<[RegExp, string]> = [
	[/(ревью|провер(ь|ка)\s+(код|дифф)|посмотри\s+(pr|дифф|diff)|code\s+review|\breview\b)/i, "code-review"],
	[/(баг|ошибк|краш|падает|не\s+работает|сломал|исправь|почини|\b(bug|crash|fix|broken)\b)/i, "debug"],
	[/(тест|покрыти|\b(tests?|coverage)\b)/i, "testing"],
	[/(коммит|запушь|релиз|\b(commit|push|pull\s+request|merge\s+request|pr|mr|release|ship)\b)/i, "ship"],
	[/(работает\s+ли|проверь,?\s+что|убедись|прогони\s+провер|\bverify\b)/i, "verify"],
];

function isNonTrivial(prompt: string): boolean {
	if (prompt.length >= 280) return true;
	const listMarkers = (prompt.match(/(^|\n)\s*(\d+[.)]|[-*•])\s+/g) ?? []).length;
	if (listMarkers >= 2) return true;
	return /(реализуй|рефактор|переработа|мигрир|переделай|исправь\s+вс[её]|добавь\s+.{10,}\s+и\s+|\b(implement|refactor|migrate|redesign)\b)/i.test(
		prompt,
	);
}

/** Команда, которая считается проверкой: тесты/линт/сборка/тайпчек популярных стеков. */
function isVerifyCommand(cmd: string): boolean {
	return /((npm|pnpm|yarn|bun)\s+(run\s+)?(test|check|lint|build|typecheck)|vitest|jest\b|pytest|cargo\s+(test|check|clippy|build)|go\s+(test|vet|build)|\btsc\b|eslint|ruff|mypy|make\s+(test|check|lint|build)|gradlew?\s+(test|check|build)|mvn\s+(test|verify)|ctest|swift\s+(test|build))/i.test(
		cmd,
	);
}

function matchSkill(prompt: string, skills: SkillInfo[]): SkillInfo | null {
	const installed = new Map(skills.map((s) => [s.name, s]));
	for (const [re, name] of SKILL_TRIGGERS) {
		if (re.test(prompt) && installed.has(name)) return installed.get(name)!;
	}
	return null;
}

export default function harness(pi: ExtensionAPI) {
	if (process.env.PI_APP_HARNESS === "0") return;
	const debugLog = process.env.PI_APP_HARNESS_LOG === "1";

	/** Одноразовые наджи, потребляются первым же `context` после старта рана. */
	let pendingNudges: string[] = [];
	/** Правки в текущем ране, после которых не было ни одной команды. */
	let editsUnverified = false;
	/** Сколько раз verify-надж уже вставлен в этом ране (потолок 2). */
	let verifyNudgesSent = 0;

	const log = (line: string) => {
		if (!debugLog) return;
		try {
			mkdirSync(join(process.cwd(), ".pi"), { recursive: true });
			appendFileSync(join(process.cwd(), ".pi", "harness.log"), `${new Date().toISOString()} ${line}\n`);
		} catch {
			// лог — только для отладки, молча пропускаем
		}
	};

	pi.on("before_agent_start", async (ev) => {
		pendingNudges = [];
		editsUnverified = false;
		verifyNudgesSent = 0;

		const prompt = (ev.prompt ?? "").trim();
		log(
			`start: skills=[${((ev.systemPromptOptions?.skills ?? []) as SkillInfo[]).map((s) => s?.name ?? JSON.stringify(Object.keys(s ?? {}))).join(",")}]`,
		);
		if (!prompt || prompt.startsWith("/")) return; // слэш-команды не трогаем

		if (isNonTrivial(prompt)) {
			pendingNudges.push(TODO_NUDGE);
			log("nudge: todo-first");
		}
		const skills = (ev.systemPromptOptions?.skills ?? []) as SkillInfo[];
		const skill = matchSkill(prompt, skills);
		if (skill) {
			pendingNudges.push(
				`The "${skill.name}" skill matches this task${skill.description ? ` (${skill.description})` : ""}. ` +
					"Read its SKILL.md now and follow it instead of improvising.",
			);
			log(`nudge: skill ${skill.name}`);
		}
	});

	/** bash-команды по toolCallId: у tool_execution_end нет args — берём из start. */
	const cmdByCall = new Map<string, string>();

	pi.on("tool_execution_start", async (ev) => {
		if (String(ev.toolName ?? "").toLowerCase() === "bash") {
			cmdByCall.set(ev.toolCallId, String((ev.args as { command?: string } | undefined)?.command ?? ""));
		}
	});

	pi.on("tool_execution_end", async (ev) => {
		const name = String(ev.toolName ?? "").toLowerCase();
		if (name === "edit" || name === "write") {
			editsUnverified = true;
			return;
		}
		if (name !== "bash") return;
		const cmd = cmdByCall.get(ev.toolCallId) ?? "";
		cmdByCall.delete(ev.toolCallId);
		// надж снимает только УСПЕШНАЯ команда, похожая на проверку проекта,
		// а не любой bash (F2): `echo done` — не верификация
		if (editsUnverified && !ev.isError && isVerifyCommand(cmd)) {
			editsUnverified = false;
			log(`verified by: ${cmd.slice(0, 60)}`);
		}
	});

	pi.on("context", async (ev) => {
		const notes = [...pendingNudges];
		pendingNudges = [];
		if (editsUnverified && verifyNudgesSent < 2) {
			notes.push(VERIFY_NUDGE);
			verifyNudgesSent++;
			log("nudge: verify");
		}
		if (notes.length === 0) return;
		log(`inject: ${notes.length} note(s)`);
		const text = `<system-reminder source="pi-app-harness">\n${notes.join("\n\n")}\n</system-reminder>`;
		const injected = {
			role: "user",
			content: [{ type: "text", text }],
			timestamp: Date.now(),
		} as unknown as (typeof ev.messages)[number];
		return { messages: [...ev.messages, injected] };
	});

	pi.on("agent_end", async () => {
		pendingNudges = [];
		editsUnverified = false;
		verifyNudgesSent = 0;
		cmdByCall.clear();
	});

	log("loaded");
}
