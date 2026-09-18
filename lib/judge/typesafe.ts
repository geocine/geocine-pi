// TypeSafe (System One / Jev) backend for the judge contract.
// Evaluate URL depends on the host: official TypeSafe is
// POST {origin}/v1/systemone; OpenRouter is POST {origin}/api/alpha/decisions
// (https://openrouter.ai/~typesafe/jev-latest). Body is the same
// {state, model, questions} either way; answers come back keyed by the
// same question ids, each with calibrated probabilities
// (https://docs.typesafe.ai/api).
//
// Jev's input window is 32k tokens (OpenRouter lists 32k; TypeSafe: 32k
// for state + the longest question). We clip state to maxInputTokens
// before POST so a large gate/prescreen payload cannot 413 the call.

import type { JudgeAnswer, JudgeBackend, JudgeRequest, JudgeResult, JudgeSettings, JudgeState } from "./types.ts";

const DEFAULT_BASE_URL = "https://api.typesafe.ai";
const TYPESAFE_EVAL_PATH = "/v1/systemone";
const OPENROUTER_EVAL_PATH = "/api/alpha/decisions";
const DEFAULT_MODEL = "jev-latest";
const OPENROUTER_MODEL = "~typesafe/jev-latest";
/** TypeSafe-native ids → OpenRouter slugs when baseUrl is OpenRouter. */
const OPENROUTER_MODEL_ALIASES: Record<string, string> = {
	"jev-latest": "~typesafe/jev-latest",
	"jev-preview": "~typesafe/jev-latest",
	"jev-1.13": "typesafe/jev-1.13",
	"jev-1.13.0": "typesafe/jev-1.13",
};
const DEFAULT_API_KEY_ENV = "TYPESAFE_API_KEY";
const OPENROUTER_API_KEY_ENV = "OPENROUTER_API_KEY";
/** Jev's published input window. */
export const DEFAULT_MAX_INPUT_TOKENS = 32_000;
/** Conservative chars/token; prefer clipping early over overflowing the window. */
const CHARS_PER_TOKEN = 4;

export function isOpenRouterHost(baseUrl: string | undefined): boolean {
	const host = hostOf(baseUrl ?? DEFAULT_BASE_URL);
	return host === "openrouter.ai" || host.endsWith(".openrouter.ai");
}

export function typesafeApiKeyEnv(cfg: JudgeSettings): string {
	if (cfg.apiKeyEnv) return cfg.apiKeyEnv;
	return isOpenRouterHost(cfg.baseUrl) ? OPENROUTER_API_KEY_ENV : DEFAULT_API_KEY_ENV;
}

export function typesafeModel(cfg: JudgeSettings): string {
	const named = cfg.model ?? (isOpenRouterHost(cfg.baseUrl) ? OPENROUTER_MODEL : DEFAULT_MODEL);
	if (isOpenRouterHost(cfg.baseUrl) && OPENROUTER_MODEL_ALIASES[named]) return OPENROUTER_MODEL_ALIASES[named];
	return named;
}

/** Hostname for status lines (`api.typesafe.ai`, `openrouter.ai`). */
export function typesafeHost(cfg: JudgeSettings): string {
	return hostOf(cfg.baseUrl ?? DEFAULT_BASE_URL) || "api.typesafe.ai";
}

/**
 * Resolve the evaluate URL. `baseUrl` is either a host origin (path filled
 * in from the host: TypeSafe `/v1/systemone`, OpenRouter `/api/alpha/decisions`)
 * or a full evaluate URL (any other host — paste the path yourself).
 */
export function typesafeEvaluateUrl(cfg: JudgeSettings): string {
	const raw = (cfg.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
	let url: URL;
	try {
		url = new URL(raw.includes("://") ? raw : `https://${raw}`);
	} catch {
		return `${DEFAULT_BASE_URL}${TYPESAFE_EVAL_PATH}`;
	}
	if (url.pathname && url.pathname !== "/") return raw;
	url.pathname = isOpenRouterHost(raw) ? OPENROUTER_EVAL_PATH : TYPESAFE_EVAL_PATH;
	return url.toString().replace(/\/$/, "");
}

function hostOf(baseUrl: string): string {
	try {
		return new URL(baseUrl.includes("://") ? baseUrl : `https://${baseUrl}`).hostname.toLowerCase();
	} catch {
		return "";
	}
}

function apiKey(cfg: JudgeSettings): string | undefined {
	return process.env[typesafeApiKeyEnv(cfg)] || undefined;
}

function estimateTokens(value: unknown): number {
	try {
		return Math.ceil(JSON.stringify(value).length / CHARS_PER_TOKEN);
	} catch {
		return Number.POSITIVE_INFINITY;
	}
}

function clipString(s: string, maxChars: number): string {
	if (s.length <= maxChars) return s;
	const keep = Math.max(0, maxChars - 48);
	const head = Math.floor(keep * 0.6);
	const tail = keep - head;
	return `${s.slice(0, head)}\n…[truncated for Jev ${DEFAULT_MAX_INPUT_TOKENS} tok window]…\n${s.slice(-tail)}`;
}

function scaleStrings(value: unknown, scale: number): unknown {
	if (typeof value === "string") return clipString(value, Math.max(80, Math.floor(value.length * scale)));
	if (Array.isArray(value)) return value.map((item) => scaleStrings(item, scale));
	if (value && typeof value === "object") {
		return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, scaleStrings(v, scale)]));
	}
	return value;
}

/** Clip `state` so serialized size stays inside Jev's input window. */
export function fitStateToWindow(state: JudgeState, maxTokens: number): JudgeState {
	if (estimateTokens(state) <= maxTokens) return state;
	let current: unknown = state;
	const maxChars = maxTokens * CHARS_PER_TOKEN;
	for (let i = 0; i < 3; i++) {
		let size: number;
		try {
			size = JSON.stringify(current).length;
		} catch {
			return clipString(String(current), maxChars);
		}
		if (size <= maxChars) return current as JudgeState;
		current = scaleStrings(current, Math.max(0.1, (maxChars / size) * 0.9));
	}
	try {
		return clipString(JSON.stringify(current), maxChars);
	} catch {
		return clipString(String(current), maxChars);
	}
}

function isAnswer(value: unknown): value is JudgeAnswer {
	if (!value || typeof value !== "object") return false;
	const a = value as Record<string, unknown>;
	if (a.type === "noul") return typeof a.noul === "number";
	if (a.type === "choice") return typeof a.choice === "string" && typeof a.confidence === "number";
	if (a.type === "score") return typeof a.score === "number" && typeof a.confidence === "number";
	return false;
}

export const typesafeJudge: JudgeBackend = {
	id: "typesafe",
	calibrated: true,

	configured(cfg) {
		return Boolean(apiKey(cfg));
	},

	async judge(req: JudgeRequest, cfg: JudgeSettings, signal: AbortSignal): Promise<JudgeResult> {
		const keyEnv = typesafeApiKeyEnv(cfg);
		const key = apiKey(cfg);
		if (!key) throw new Error(`typesafe: ${keyEnv} not set`);
		const model = typesafeModel(cfg);
		const url = typesafeEvaluateUrl(cfg);
		const maxInput = cfg.maxInputTokens ?? DEFAULT_MAX_INPUT_TOKENS;
		const questionTokens = estimateTokens(req.questions);
		const stateBudget = Math.max(256, maxInput - questionTokens);
		const state = fitStateToWindow(req.state, stateBudget);
		const t0 = Date.now();
		const headers: Record<string, string> = {
			"content-type": "application/json",
			authorization: `Bearer ${key}`,
		};
		if (isOpenRouterHost(cfg.baseUrl)) {
			headers["X-OpenRouter-Title"] = "geocine-pi";
		}
		const response = await fetch(url, {
			method: "POST",
			headers,
			body: JSON.stringify({ state, model, questions: req.questions }),
			signal,
		});
		if (!response.ok) throw new Error(`typesafe: HTTP ${response.status}`);
		const data = (await response.json()) as {
			model?: string;
			answers?: Record<string, unknown>;
			usage?: { input_tokens?: number; output_tokens?: number; prompt_tokens?: number; completion_tokens?: number };
		};
		const answers: Record<string, JudgeAnswer> = {};
		for (const [id, answer] of Object.entries(data.answers ?? {})) {
			if (isAnswer(answer)) answers[id] = answer;
		}
		if (Object.keys(answers).length === 0) throw new Error("typesafe: no usable answers");
		return {
			answers,
			model: data.model ?? model,
			elapsedMs: Date.now() - t0,
			usage: {
				inputTokens: data.usage?.input_tokens ?? data.usage?.prompt_tokens,
				outputTokens: data.usage?.output_tokens ?? data.usage?.completion_tokens,
			},
		};
	},
};
