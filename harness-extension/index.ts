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

const REPEAT_NUDGE =
	"STOP: you just repeated the EXACT same tool call. A further repeat will be blocked. " +
	"Take a DIFFERENT action: use the result you already have, change the arguments, or ask the user.";

const TODO_LOOP_NUDGE =
	"STOP: you are cycling todo updates without doing real work. Do NOT call todo again now — " +
	"advance the current task with read/edit/bash first, then update its status once.";

const CONTEXT_NUDGE =
	"Context has grown past the reliable size for this model. FINISH the current todo item, " +
	"then compact the session (or ask the user to /compact) BEFORE starting anything new. " +
	"Prefer finishing over exploring; do not open new files unless strictly required.";

const SUMMARY_NUDGE =
	"All todos are complete. Give the user a concise summary NOW: what was changed (files), " +
	"how it was verified (real command output), and anything left undone. Then STOP — no more tool calls.";

const REREAD_NUDGE =
	"You are re-reading the same file in small slices. Read the needed range in ONE call " +
	"(or the whole file if it is small) and MOVE ON to acting on it.";

/** Порог контекст-гарда (~токены, оценка chars/4): за train seq 8К модель уже
 *  деградирует, но рабочая зона до ~60К с дисциплиной. */
const CONTEXT_NUDGE_TOKENS = 60_000;

const MALFORMED_NUDGE =
	"Your tool calls are arriving with EMPTY arguments — the call format is broken. " +
	"Emit the tool call again with ALL required fields as proper JSON " +
	'(write: {"path": …, "content": …}; edit: {"path", "oldText", "newText"}; read: {"path"}; bash: {"command"}). ' +
	"Do NOT wrap tool calls in markdown.";

/** Инструменты, у которых пустые arguments всегда означают сломанный вызов. */
const ARGS_REQUIRED = new Set(["read", "write", "edit", "bash"]);

/** Инструменты, считающиеся «содержательной работой» (сбрасывают todo-серию). */
const WORK_TOOLS = new Set(["read", "edit", "write", "bash", "grep", "find", "ls"]);

/** Триггеры → имя скилла. Подсказываем только если скилл реально установлен.
 *  ВАЖНО: `\b` в JS-регэкспах не работает с кириллицей (не входит в \w) —
 *  для русских основ используем голые вхождения, для коротких английских
 *  токенов — явные границы. */
const SKILL_TRIGGERS: Array<[RegExp, string]> = [
	[/(ревью|провер(ь|ка)\s+(код|дифф)|посмотри\s+(pr|дифф|diff)|code\s+review|\breview\b)/i, "code-review"],
	[/(баг|ошибк|краш|падает|не\s+работает|слома|исправ|почин|\b(bug|crash|fix|broken)\b)/i, "debug"],
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
	/** Скиллы из систем-промпта (кэш с before_agent_start) — для todo-роутинга. */
	let skillsCache: SkillInfo[] = [];
	/** Скиллы, уже подсказанные в этом ране (не повторяемся). */
	const hintedSkills = new Set<string>();
	/** Анти-луп (H1): подпись последнего tool-вызова и длина серии повторов. */
	let lastCallSig = "";
	let sameCallStreak = 0;
	/** Анти-луп (H2): длина серии todo-вызовов без содержательной работы. */
	let todoStreak = 0;
	/** Сколько вызовов уже заблокировано в этом ране (предохранитель на аборт). */
	let blockedCalls = 0;
	/** Подряд идущие assistant-сообщения со сломанными (пустые args) tool-вызовами. */
	let malformedStreak = 0;
	/** file-read-streak: последний читаемый path и длина серии его чтений подряд. */
	let lastReadPath = "";
	let readStreak = 0;
	/** Одноразовые за ран флаги контекст-гарда и итога. */
	let contextNudged = false;
	let summaryNudged = false;

	const log = (line: string) => {
		if (!debugLog) return;
		try {
			mkdirSync(join(process.cwd(), ".pi"), { recursive: true });
			appendFileSync(join(process.cwd(), ".pi", "harness.log"), `${new Date().toISOString()} ${line}\n`);
		} catch {
			// лог — только для отладки, молча пропускаем
		}
	};

	const skillHint = (skill: SkillInfo, reason: string) => {
		if (hintedSkills.has(skill.name)) return;
		hintedSkills.add(skill.name);
		pendingNudges.push(
			`The "${skill.name}" skill matches ${reason}${skill.description ? ` (${skill.description})` : ""}. ` +
				"Read its SKILL.md now and follow it instead of improvising.",
		);
		log(`nudge: skill ${skill.name} [${reason}]`);
	};

	pi.on("before_agent_start", async (ev) => {
		pendingNudges = [];
		editsUnverified = false;
		verifyNudgesSent = 0;
		hintedSkills.clear();
		lastCallSig = "";
		sameCallStreak = 0;
		todoStreak = 0;
		blockedCalls = 0;
		malformedStreak = 0;
		lastReadPath = "";
		readStreak = 0;
		contextNudged = false;
		summaryNudged = false;
		skillsCache = (ev.systemPromptOptions?.skills ?? []) as SkillInfo[];

		const prompt = (ev.prompt ?? "").trim();
		log(`start: skills=${skillsCache.length}`);
		if (!prompt || prompt.startsWith("/")) return; // слэш-команды не трогаем

		if (isNonTrivial(prompt)) {
			pendingNudges.push(TODO_NUDGE);
			log("nudge: todo-first");
		}
		// свежие факты → web-инструменты (H4): модель сама о них не вспоминает
		if (/(найди в (интернете|сети)|погугли|поищи в|актуальн\w+ верси|последн\w+ верси|latest version|search the web|что нового в)/i.test(prompt)) {
			pendingNudges.push(
				"This task needs FRESH external facts. Use the web tools now: web_search for discovery, " +
					"fetch_content for a specific page. Do not answer from memory. " +
					"If web tools are not available, state that explicitly.",
			);
			log("nudge: web");
		}
		const skill = matchSkill(prompt, skillsCache);
		if (skill) skillHint(skill, "this task");
	});

	// Анти-луп (§5.11-1): наблюдаемый отказ локальной 35B — карусель одинаковых
	// вызовов (read того же файла, todo create→pending→completed) без прогресса.
	// Эскалация: 2-й идентичный подряд → стоп-реминдер; 4-й → блокировка вызова.
	// Todo-серия: 3 подряд без содержательной работы → реминдер; 6 → блок todo.
	pi.on("tool_call", async (ev, ctx) => {
		const name = String(ev.toolName ?? "").toLowerCase();
		let sig = name;
		try {
			sig = `${name}:${JSON.stringify(ev.input ?? {})}`;
		} catch {
			// нестрокуемый input — различаем только по имени
		}
		if (sig === lastCallSig) {
			sameCallStreak++;
		} else {
			lastCallSig = sig;
			sameCallStreak = 1;
		}

		// Предохранитель: блокировки не останавливают генерацию — модель может
		// пробовать бесконечно (наблюдалось BLOCK todo x20 до таймаута). После
		// 8 заблокированных вызовов ран прерывается целиком.
		const blockCall = (reason: string) => {
			blockedCalls++;
			if (blockedCalls >= 8) {
				log(`loop: ABORT after ${blockedCalls} blocked calls`);
				try {
					ctx.abort();
				} catch {
					// abort вне стрима кидает — игнорируем
				}
			}
			return { block: true, reason };
		};

		if (sameCallStreak === 2) {
			pendingNudges.push(REPEAT_NUDGE);
			log(`loop: repeat x2 ${name}`);
		} else if (sameCallStreak >= 4) {
			log(`loop: BLOCK repeat x${sameCallStreak} ${name}`);
			return blockCall(
				"pi-app-harness: this exact tool call was already executed several times in a row. " +
					"Use the earlier result or take a different action.",
			);
		}

		if (name === "todo") {
			todoStreak++;
			if (todoStreak === 3) {
				pendingNudges.push(TODO_LOOP_NUDGE);
				log("loop: todo x3");
			} else if (todoStreak >= 6) {
				log(`loop: BLOCK todo x${todoStreak}`);
				return blockCall(
					"pi-app-harness: too many consecutive todo updates without real work. " +
						"Advance the task with read/edit/bash first.",
				);
			}
		} else if (WORK_TOOLS.has(name)) {
			todoStreak = 0;
		}

		// file-read-streak: чтение одного файла ломтями (offset меняется — детектор
		// идентичных вызовов не ловит). 3 подряд → надж, 5 → блок.
		if (name === "read") {
			const input = (ev.input ?? {}) as { path?: string; file_path?: string };
			const p = String(input.path ?? input.file_path ?? "");
			if (p && p === lastReadPath) {
				readStreak++;
				if (readStreak === 3) {
					pendingNudges.push(REREAD_NUDGE);
					log(`loop: reread x3 ${p.split("/").pop()}`);
				} else if (readStreak >= 5) {
					log(`loop: BLOCK reread x${readStreak} ${p.split("/").pop()}`);
					return blockCall(
						"pi-app-harness: this file was just read several times in slices. " +
							"Use what you already have or read one large range, then act.",
					);
				}
			} else {
				lastReadPath = p;
				readStreak = 1;
			}
		} else {
			lastReadPath = "";
			readStreak = 0;
		}
		return undefined;
	});

	// Детектор сломанных tool-вызовов (формат-дрейф Qwable): вызовы с пустыми
	// arguments отбраковываются ДО tool_call-события — детекторы выше их не видят
	// (наблюдалось 60×write{} подряд до таймаута). Ловим на message_end.
	pi.on("message_end", async (ev, ctx) => {
		const msg = ev.message as { role?: string; content?: unknown } | undefined;
		if (msg?.role !== "assistant" || !Array.isArray(msg.content)) return;
		let sawCall = false;
		let sawBroken = false;
		for (const b of msg.content as Array<{ type?: string; name?: string; arguments?: unknown }>) {
			if (b?.type !== "toolCall") continue;
			sawCall = true;
			const name = String(b.name ?? "").toLowerCase();
			const args = b.arguments;
			const empty = args == null || (typeof args === "object" && Object.keys(args as object).length === 0);
			if (ARGS_REQUIRED.has(name) && empty) sawBroken = true;
		}
		if (!sawCall) return;
		if (!sawBroken) {
			malformedStreak = 0;
			return;
		}
		malformedStreak++;
		if (malformedStreak === 2) {
			pendingNudges.push(MALFORMED_NUDGE);
			log("loop: malformed x2");
		} else if (malformedStreak >= 6) {
			log(`loop: ABORT malformed x${malformedStreak}`);
			try {
				ctx.abort();
			} catch {
				// вне стрима — игнорируем
			}
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
		if (name === "todo" && !ev.isError) {
			// F5: роутинг по активной задаче. Сабджект in_progress-задачи берём
			// (а) структурно из details.params, (б) из list-формата «[in_progress] #3 subject»,
			// (в) из create/update-формата «#1: subject (in_progress)».
			const details = (ev.result as { details?: { params?: { subject?: unknown; status?: unknown } } } | null)
				?.details;
			const subjects: string[] = [];
			if (details?.params?.status === "in_progress" && typeof details.params.subject === "string") {
				subjects.push(details.params.subject);
			}
			const text = JSON.stringify(ev.result ?? "");
			const listM = /\[in_progress\]\s+#\d+\s+([^"\\(]+)/.exec(text);
			if (listM) subjects.push(listM[1]);
			const inlineM = /#\d+:?\s+([^"\\(]+?)\s*\(in_progress\)/.exec(text);
			if (inlineM) subjects.push(inlineM[1]);
			for (const subject of subjects) {
				const skill = matchSkill(subject, skillsCache);
				if (skill) {
					skillHint(skill, `the active todo ("${subject.trim().slice(0, 60)}")`);
					break;
				}
			}
			// итог по завершению: все задачи completed → потребовать финальное резюме
			if (!summaryNudged) {
				const text = JSON.stringify(ev.result ?? "");
				// только статус-маркеры в скобках: «(pending →» перехода не считается открытой задачей
				const hasCompleted = /[\[(]completed[\])]|(→|->)\s*completed/.test(text);
				const hasOpen = /[\[(](pending|in_progress)[\])]/.test(text);
				if (hasCompleted && !hasOpen) {
					summaryNudged = true;
					pendingNudges.push(SUMMARY_NUDGE);
					log("nudge: summary");
				}
			}
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
		// контекст-гард: за пределами надёжного размера — курс на завершение и компакцию
		if (!contextNudged) {
			let chars = 0;
			for (const m of ev.messages) {
				try {
					chars += JSON.stringify((m as { content?: unknown }).content ?? "").length;
				} catch {
					// не считаем нестрокуемое
				}
			}
			if (chars / 4 > CONTEXT_NUDGE_TOKENS) {
				contextNudged = true;
				pendingNudges.push(CONTEXT_NUDGE);
				log(`nudge: context ~${Math.round(chars / 4 / 1000)}K`);
			}
		}
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
		hintedSkills.clear();
		lastCallSig = "";
		sameCallStreak = 0;
		todoStreak = 0;
		lastReadPath = "";
		readStreak = 0;
		contextNudged = false;
		summaryNudged = false;
	});

	log("loaded");
}
