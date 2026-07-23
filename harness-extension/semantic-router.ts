import { completeSimple } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { inferTaskIntent, type TaskIntent } from "./policy.js";
import {
	deterministicSemanticFallback,
	mergeSemanticRoute,
	normalizeRouterMode,
	parseSemanticRoute,
	SEMANTIC_ROUTER_SYSTEM_PROMPT,
	shouldUseSemanticRouter,
} from "./semantic-router-policy.js";

const ROUTER_MAX_INPUT = 20_000;

function routerTimeoutMs(): number {
	const configured = Number(process.env.PI_APP_HARNESS_ROUTER_TIMEOUT_MS);
	return Number.isFinite(configured) && configured > 0
		? Math.min(120_000, Math.max(5_000, configured))
		: 60_000;
}

function selectRouterModel(ctx: ExtensionContext) {
	const requested = process.env.PI_APP_HARNESS_ROUTER_MODEL?.trim();
	if (requested) {
		const separator = requested.indexOf("/");
		const provider = separator > 0 ? requested.slice(0, separator) : ctx.model?.provider;
		const id = separator > 0 ? requested.slice(separator + 1) : requested;
		const configured = provider ? ctx.modelRegistry.find(provider, id) : undefined;
		if (configured) return configured;
	}
	return ctx.model;
}

function fallbackWithSignal(prompt: string, signal: string): TaskIntent {
	const fallback = inferTaskIntent(prompt);
	const merged = mergeSemanticRoute(fallback, deterministicSemanticFallback(fallback));
	return {
		...merged,
		signals: [...new Set([
			...merged.signals.filter((item) => !item.startsWith("confidence:")),
			"semantic-fallback",
			signal,
		])],
	};
}

export async function routeTaskIntent(prompt: string, ctx: ExtensionContext): Promise<TaskIntent> {
	const fallback = inferTaskIntent(prompt);
	const mode = normalizeRouterMode(process.env.PI_APP_HARNESS_ROUTER);
	if (!shouldUseSemanticRouter(fallback, mode)) return {
		...fallback,
		signals: [...new Set([
			...fallback.signals,
			mode === "deterministic" ? "deterministic-router" : "deterministic-consensus",
		])],
	};
	const routerModel = selectRouterModel(ctx);
	if (!routerModel) return fallbackWithSignal(prompt, "semantic-unavailable");
	const timeoutMs = routerTimeoutMs();
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(routerModel);
		if (!auth.ok || controller.signal.aborted) return fallbackWithSignal(prompt, "semantic-unavailable");
		const result = await completeSimple(
			routerModel,
			{
				systemPrompt: SEMANTIC_ROUTER_SYSTEM_PROMPT,
				messages: [{ role: "user", content: prompt.slice(0, ROUTER_MAX_INPUT), timestamp: Date.now() }],
			},
			{
				apiKey: auth.apiKey,
				headers: { ...(routerModel.headers ?? {}), ...(auth.headers ?? {}) },
				temperature: 0,
				maxTokens: 192,
				signal: controller.signal,
				timeoutMs,
				maxRetries: 0,
			},
		);
		const text = result.content
			.filter((part): part is { type: "text"; text: string } => part.type === "text")
			.map((part) => part.text)
			.join("\n");
		const semantic = parseSemanticRoute(text);
		if (!semantic || semantic.confidence < 0.55) return fallbackWithSignal(prompt, semantic ? "semantic-low-confidence" : "semantic-invalid");
		const merged = mergeSemanticRoute(fallback, semantic);
		return {
			...merged,
			signals: [...new Set([...merged.signals, routerModel === ctx.model ? "semantic-primary-model" : "semantic-dedicated-model"])],
		};
	} catch {
		return fallbackWithSignal(prompt, controller.signal.aborted ? "semantic-timeout" : "semantic-error");
	} finally {
		clearTimeout(timer);
	}
}
