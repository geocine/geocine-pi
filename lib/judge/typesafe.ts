// TypeSafe (System One / Jev) backend for the judge contract.
// HTTP API: POST {baseUrl}/v1/systemone with {state, model, questions};
// answers come back keyed by the same question ids, each with calibrated
// probabilities (https://docs.typesafe.ai/api).

import type { JudgeAnswer, JudgeBackend, JudgeRequest, JudgeResult, JudgeSettings } from "./types.ts";

const DEFAULT_BASE_URL = "https://api.typesafe.ai";
const DEFAULT_MODEL = "jev-latest";
const DEFAULT_API_KEY_ENV = "TYPESAFE_API_KEY";

function apiKey(cfg: JudgeSettings): string | undefined {
	return process.env[cfg.apiKeyEnv ?? DEFAULT_API_KEY_ENV] || undefined;
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

	configured(cfg) {
		return Boolean(apiKey(cfg));
	},

	async judge(req: JudgeRequest, cfg: JudgeSettings, signal: AbortSignal): Promise<JudgeResult> {
		const key = apiKey(cfg);
		if (!key) throw new Error(`typesafe: ${cfg.apiKeyEnv ?? DEFAULT_API_KEY_ENV} not set`);
		const base = (cfg.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
		const model = cfg.model ?? DEFAULT_MODEL;
		const t0 = Date.now();
		const response = await fetch(`${base}/v1/systemone`, {
			method: "POST",
			headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
			body: JSON.stringify({ state: req.state, model, questions: req.questions }),
			signal,
		});
		if (!response.ok) throw new Error(`typesafe: HTTP ${response.status}`);
		const data = (await response.json()) as {
			model?: string;
			answers?: Record<string, unknown>;
			usage?: { input_tokens?: number; output_tokens?: number };
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
			usage: { inputTokens: data.usage?.input_tokens, outputTokens: data.usage?.output_tokens },
		};
	},
};
