// Judge: the contract for fast, typed, calibrated judgments ("smart
// if-statements") backed by a System One classifier (TypeSafe's Jev is the
// first backend — https://docs.typesafe.ai). Mirrors the ModelHarness
// pattern: one file per backend implementing JudgeBackend, index.ts owns
// resolution and the never-throw judge() entry.
//
// Design rules (why call sites stay safe without a classifier):
//  - judge() returns undefined on ANY failure: no backend configured, no
//    API key, timeout, HTTP error, malformed answers. Callers must always
//    have a heuristic/LLM fallback path — degradation is part of the
//    contract, not an accident.
//  - Question/answer shapes follow the System One primitives (noul /
//    choice / score) so a future backend (another vendor, a local
//    classifier head, a fine-tuned LoRA) plugs in by implementing
//    JudgeBackend without touching call sites.

/** Yes/no judgment; the answer is the probability of yes. */
export interface NoulQuestion {
	type: "noul";
	instructions: string;
	criteria?: { true?: string; false?: string };
}

/** Pick one option from a defined set; answer carries the distribution. */
export interface ChoiceQuestion {
	type: "choice";
	instructions: string;
	/** option -> rubric description (null when the name is self-evident). */
	criteria: Record<string, string | null>;
}

/** Rate along ordered levels; answer is probability-weighted position. */
export interface ScoreQuestion {
	type: "score";
	instructions: string;
	/** Ordered level descriptions, at least two. Score 0 = first level. */
	criteria: string[];
}

export type JudgeQuestion = NoulQuestion | ChoiceQuestion | ScoreQuestion;

/** Unstructured or structured program state the questions evaluate. */
export type JudgeState = string | Record<string, unknown> | unknown[];

export interface NoulAnswer {
	type: "noul";
	/** Probability of yes, 0..1. */
	noul: number;
}

export interface ChoiceAnswer {
	type: "choice";
	choice: string;
	probabilities: Record<string, number>;
	confidence: number;
}

export interface ScoreAnswer {
	type: "score";
	/** Probability-weighted level index; can land between levels. */
	score: number;
	legend: Record<string, string>;
	probabilities: Record<string, number>;
	confidence: number;
}

export type JudgeAnswer = NoulAnswer | ChoiceAnswer | ScoreAnswer;

export interface JudgeRequest {
	state: JudgeState;
	/** Independent questions over the same state; answered in parallel. */
	questions: Record<string, JudgeQuestion>;
}

export interface JudgeResult {
	answers: Record<string, JudgeAnswer>;
	/** Backend-reported model id (e.g. "jev-1.13"). */
	model: string;
	elapsedMs: number;
	usage?: { inputTokens?: number; outputTokens?: number };
}

export interface JudgeSettings {
	/** Backend id (lib/judge registry). Default "typesafe". */
	provider?: string;
	/** Master switch. Default: enabled when the backend is configured. */
	enabled?: boolean;
	/** Backend endpoint override. */
	baseUrl?: string;
	/** Model id/alias, backend-specific. Default per backend. */
	model?: string;
	/** Env var holding the API key. Default per backend. */
	apiKeyEnv?: string;
	/** Per-call budget before falling back. Default 4000. */
	timeoutMs?: number;
	/**
	 * Minimum choice/score confidence for a judge answer to OVERRULE a
	 * deterministic heuristic (confidence-gated routing). Below it the
	 * heuristic verdict stands. Default 0.55.
	 */
	minConfidence?: number;
	/**
	 * Fabric-wide rate cap across all decision nodes (watchdog, triage,
	 * gate, guard, prescreen). Calls beyond it degrade to heuristics for
	 * the rest of the minute. Default 30.
	 */
	maxCallsPerMinute?: number;
	/**
	 * Log every answered judge call as one training row to JSONL:
	 * {ts, node, source, elapsedMs, context, schema, labels} — exactly the
	 * (context, schema, labels) shape a parallel-constrained-decoding head
	 * (e.g. a Qwen2.5-1.5B) trains on; see lib/judge/serialize.ts for the
	 * folding. `source` names the answering tier ("typesafe:jev-1.13" vs
	 * "naive-llm:...") so weaker naive labels can be filtered or
	 * down-weighted at training time. Default true.
	 */
	trace?: boolean;
	/** Trace directory. loadConfig wires it to the consult-log dir. */
	traceDir?: string;
	/** naive-llm completion cap (that tier is deliberately terse). Default 500. */
	maxTokens?: number;
	/**
	 * The not-too-smart LLM fallback tier: when the primary classifier is
	 * unconfigured or a call fails, the same questions go to an
	 * OpenAI-compatible /chat/completions endpoint (typically the local
	 * llama.cpp server — free) as ONE temperature-0 JSON completion using
	 * the trace's own (context, schema) serialization. Ladder:
	 * Jev -> naive-llm -> call-site heuristics.
	 */
	fallback?: {
		/** e.g. "http://127.0.0.1:8080/v1". Unset = no fallback tier. */
		baseUrl?: string;
		model?: string;
		apiKeyEnv?: string;
		maxTokens?: number;
	};
}

export interface JudgeBackend {
	/** Stable id used as judge.provider in geocine.json. */
	id: string;
	/** Cheap static check: false means judge() would certainly fail. */
	configured(cfg: JudgeSettings): boolean;
	/** One evaluation call. May throw; index.ts converts to undefined. */
	judge(req: JudgeRequest, cfg: JudgeSettings, signal: AbortSignal): Promise<JudgeResult>;
}
