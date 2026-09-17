// naive-llm: the deliberately-dumb middle tier of the judge ladder
// (Jev -> naive-llm -> call-site heuristics). One temperature-0 JSON
// completion against an OpenAI-compatible endpoint (typically the local
// llama.cpp server, so it costs nothing), prompted with the SAME
// (context, schema) serialization the trace logs and the future offline
// classifier trains on.
//
// Deliberately NOT smart — no retries, no reasoning, capped completion —
// because it is a stopgap, not the destination: the plan is to replace it
// (and Jev) with a trained constrained-decoding head, and an over-clever
// fallback would both burn tokens and pollute the training signal. Its
// self-reported probs are clamped to <= 0.85 so this tier can never
// out-shout calibrated sources, and its trace rows carry a "naive-llm"
// source so they are separable (filtered or down-weighted) at training
// time.

import { schemaPromptBlock, toContext, toSchema, type TrainingField } from "./serialize.ts";
import type { JudgeAnswer, JudgeBackend, JudgeRequest, JudgeSettings } from "./types.ts";

const DEFAULT_MAX_TOKENS = 500;
const MIN_PROB = 0.5;
const MAX_PROB = 0.85;

function clamp(p: unknown): number {
	const n = typeof p === "number" && Number.isFinite(p) ? p : 0.7;
	return Math.min(MAX_PROB, Math.max(MIN_PROB, n));
}

/** Accepts {value, prob} or a bare value; returns undefined when unusable. */
function readField(raw: unknown): { value: string; prob: number } | undefined {
	if (raw && typeof raw === "object" && "value" in (raw as Record<string, unknown>)) {
		const o = raw as Record<string, unknown>;
		return { value: String(o.value), prob: clamp(o.prob) };
	}
	if (typeof raw === "string" || typeof raw === "number" || typeof raw === "boolean") {
		return { value: String(raw), prob: clamp(undefined) };
	}
	return undefined;
}

function toAnswer(req: JudgeRequest, name: string, field: TrainingField, raw: unknown): JudgeAnswer | undefined {
	const read = readField(raw);
	if (!read) return undefined;
	const q = req.questions[name];
	if (q.type === "noul") {
		const v = read.value.trim().toLowerCase();
		if (v !== "true" && v !== "false") return undefined;
		return { type: "noul", noul: v === "true" ? read.prob : 1 - read.prob };
	}
	const choices = field.choices ?? [];
	const match = choices.find((c) => c.toLowerCase() === read.value.trim().toLowerCase());
	if (match === undefined) return undefined;
	const rest = choices.length > 1 ? (1 - read.prob) / (choices.length - 1) : 0;
	const probabilities = Object.fromEntries(choices.map((c) => [c, c === match ? read.prob : rest]));
	if (q.type === "choice") {
		return { type: "choice", choice: match, probabilities, confidence: read.prob };
	}
	return {
		type: "score",
		score: Number(match),
		legend: Object.fromEntries(q.criteria.map((d, i) => [String(i), d])),
		probabilities,
		confidence: read.prob,
	};
}

function parseLenient(text: string): Record<string, unknown> | undefined {
	const stripped = text.replace(/^\s*```(?:json)?\s*|\s*```\s*$/g, "");
	const start = stripped.indexOf("{");
	const end = stripped.lastIndexOf("}");
	if (start < 0 || end <= start) return undefined;
	try {
		const parsed: unknown = JSON.parse(stripped.slice(start, end + 1));
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined;
	} catch {
		return undefined;
	}
}

export const naiveLlmJudge: JudgeBackend = {
	id: "naive-llm",

	configured(cfg: JudgeSettings) {
		return Boolean(cfg.baseUrl);
	},

	async judge(req, cfg, signal) {
		const t0 = Date.now();
		const schema = toSchema(req.questions);
		const key = cfg.apiKeyEnv ? process.env[cfg.apiKeyEnv] : undefined;
		const response = await fetch(`${(cfg.baseUrl ?? "").replace(/\/$/, "")}/chat/completions`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				...(key ? { authorization: `Bearer ${key}` } : {}),
			},
			body: JSON.stringify({
				model: cfg.model ?? "default",
				messages: [
					{
						role: "system",
						content: `You are a calibrated decision engine. Output ONLY a valid JSON object matching the schema below — no markdown, no prose. For every field pick "value" from its allowed set and "prob" (0..1) = your confidence in that value.\n\nJSON Schema:\n${schemaPromptBlock(schema)}`,
					},
					{
						role: "user",
						content: `Analyze the following context and answer every field:\n\n${toContext(req.state)}`,
					},
				],
				temperature: 0,
				max_tokens: cfg.maxTokens ?? DEFAULT_MAX_TOKENS,
				response_format: { type: "json_object" },
			}),
			signal,
		});
		if (!response.ok) throw new Error(`naive-llm: HTTP ${response.status}`);
		const data = (await response.json()) as { model?: string; choices?: Array<{ message?: { content?: string } }> };
		const parsed = parseLenient(data.choices?.[0]?.message?.content ?? "");
		if (!parsed) throw new Error("naive-llm: unparseable completion");
		const answers: Record<string, JudgeAnswer> = {};
		for (const [name, field] of Object.entries(schema)) {
			const answer = toAnswer(req, name, field, parsed[name]);
			if (answer) answers[name] = answer;
		}
		if (Object.keys(answers).length === 0) throw new Error("naive-llm: no usable answers");
		return { answers, model: data.model ?? cfg.model ?? "local", elapsedMs: Date.now() - t0 };
	},
};
