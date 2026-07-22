import { completeSimple } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isSubagentSessionFile, normalizeGeneratedSessionName } from "./session-name-utils.js";

const AUTO_NAME_TIMEOUT_MS = 30_000;
const AUTO_NAME_MAX_INPUT = 1_500;

function debug(...values: unknown[]): void {
	if (process.env.PI_APP_AUTO_SESSION_NAME_LOG === "1") {
		console.error("[pi-app:auto-name]", ...values);
	}
}

function sessionFile(ctx: ExtensionContext): string | undefined {
	try {
		return ctx.sessionManager.getSessionFile();
	} catch {
		return undefined;
	}
}

async function generateName(prompt: string, ctx: ExtensionContext, signal: AbortSignal): Promise<string> {
	if (!ctx.model) return "";
	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
	if (!auth.ok || signal.aborted) {
		debug("skipped: model auth unavailable or request aborted");
		return "";
	}
	// Do not pass a reasoning level. For Qwen-compatible servers Pi then sends
	// `chat_template_kwargs.enable_thinking=false`, keeping this auxiliary call
	// short without changing the session model or its selected thinking level.
	const titleModel = ctx.model;
	debug("request", {
		provider: titleModel.provider,
		model: titleModel.id,
		api: titleModel.api,
		reasoning: titleModel.reasoning,
	});
	const result = await completeSimple(
		titleModel,
		{
			systemPrompt: [
				"Generate a concise title for this coding session.",
				"Use the same language as the user.",
				"Use 2-7 informative words and preserve important project or technology names.",
				"Return only the title: no quotes, markdown, explanation, or trailing punctuation.",
			].join("\n"),
			messages: [{ role: "user", content: prompt.slice(0, AUTO_NAME_MAX_INPUT), timestamp: Date.now() }],
		},
		{
			apiKey: auth.apiKey,
			headers: { ...(ctx.model.headers ?? {}), ...(auth.headers ?? {}) },
			maxTokens: 256,
			signal,
			timeoutMs: AUTO_NAME_TIMEOUT_MS,
			maxRetries: 0,
		},
	);
	debug("response", {
		stopReason: result.stopReason,
		errorMessage: result.errorMessage,
		contentTypes: result.content.map((part) => part.type),
	});
	const text = result.content
		.filter((part): part is { type: "text"; text: string } => part.type === "text")
		.map((part) => part.text)
		.join(" ");
	return normalizeGeneratedSessionName(text);
}

export function registerSessionAutoName(pi: ExtensionAPI): void {
	if (process.env.PI_APP_AUTO_SESSION_NAME === "0") return;
	let firstPrompt = "";
	let attempted = false;
	let generating = false;
	let generation: AbortController | undefined;

	pi.on("session_start", (_event, ctx) => {
		firstPrompt = "";
		attempted = Boolean(pi.getSessionName()) || isSubagentSessionFile(sessionFile(ctx));
		generating = false;
		generation?.abort();
		generation = undefined;
		debug("session_start", { sessionFile: sessionFile(ctx), skipped: attempted });
	});

	pi.on("before_agent_start", (event, ctx) => {
		if (attempted || generating || pi.getSessionName() || isSubagentSessionFile(sessionFile(ctx))) return;
		const prompt = event.prompt.trim();
		if (!prompt || prompt.startsWith("/")) return;
		firstPrompt ||= prompt;
		debug("captured first prompt", { length: firstPrompt.length });
	});

	// Run after the primary turn so a single-slot local inference server never has
	// to arbitrate between the user's task and a cosmetic title request.
	pi.on("agent_end", (_event, ctx) => {
		if (!firstPrompt || attempted || generating || pi.getSessionName()) return;
		debug("agent_end: generating title");
		attempted = true;
		generating = true;
		const sourceSession = sessionFile(ctx);
		generation = new AbortController();
		const controller = generation;
		void generateName(firstPrompt, ctx, controller.signal)
			.then((title) => {
				debug("normalized title", title || "<empty>");
				if (!title || controller.signal.aborted || pi.getSessionName()) return;
				if (sourceSession && sessionFile(ctx) !== sourceSession) return;
				pi.setSessionName(title);
				debug("session name set", title);
			})
			.catch((error) => {
				debug("generation failed", error instanceof Error ? error.message : String(error));
				// Naming is a best-effort UX feature; the first-message snippet remains
				// the lossless fallback and model/provider errors never affect the run.
			})
			.finally(() => {
				if (generation === controller) generation = undefined;
				generating = false;
			});
	});

	pi.on("session_shutdown", () => {
		generation?.abort();
		generation = undefined;
		generating = false;
	});
}

export default registerSessionAutoName;
