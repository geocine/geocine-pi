// Judge dispatcher: resolves the configured backends into a degradation
// ladder — primary classifier (Jev) -> naive-llm fallback (one dumb JSON
// completion on the local server) -> undefined (call-site heuristics) —
// and exposes the never-throw judge() entry plus safe answer readers. See
// types.ts for the contract. Add a backend by implementing JudgeBackend
// and listing it in BACKENDS — call sites never name a vendor.
//
// Every answered call, whichever tier answered it, is traced as one
// training row (context, schema, labels + source) — see serialize.ts. The
// dataset is the point: it is what lets a local constrained-decoding head
// eventually replace both paid tiers.
//
// This file is also the DECISION FABRIC's shared plumbing. Every call site
// (fabric node) passes its node id so all micro-decisions share one rate
// cap — a pathological loop can't hammer the classifier — and one
// in-memory ledger (calls, degradations, latency per node) surfaced by
// judgeFabricStats() in /geocine judge.

import * as fs from "node:fs";
import * as path from "node:path";
import { naiveLlmJudge } from "./naive-llm.ts";
import { toContext, toLabels, toSchema } from "./serialize.ts";
import type {
	ChoiceAnswer,
	JudgeBackend,
	JudgeRequest,
	JudgeResult,
	JudgeSettings,
	NoulAnswer,
	ScoreAnswer,
} from "./types.ts";
import { typesafeApiKeyEnv, typesafeHost, typesafeJudge, typesafeModel } from "./typesafe.ts";

export type {
	ChoiceQuestion,
	JudgeAnswer,
	JudgeQuestion,
	JudgeRequest,
	JudgeResult,
	JudgeSettings,
	NoulQuestion,
	ScoreQuestion,
} from "./types.ts";

const BACKENDS: JudgeBackend[] = [typesafeJudge, naiveLlmJudge];

const DEFAULT_TIMEOUT_MS = 4000;
export const DEFAULT_MIN_CONFIDENCE = 0.55;
const DEFAULT_MAX_CALLS_PER_MINUTE = 30;

interface NodeStats {
	calls: number;
	answered: number;
	degraded: number;
	throttled: number;
	fellBack: number;
	totalMs: number;
}

/** Per-node ledger, shared process-wide (all extensions import this module). */
const ledger = new Map<string, NodeStats>();
/** Sliding window of call timestamps for the fabric-wide rate cap. */
let callTimes: number[] = [];

function stats(node: string): NodeStats {
	let s = ledger.get(node);
	if (!s) {
		s = { calls: 0, answered: 0, degraded: 0, throttled: 0, fellBack: 0, totalMs: 0 };
		ledger.set(node, s);
	}
	return s;
}

function underRateCap(cfg: JudgeSettings): boolean {
	const cap = cfg.maxCallsPerMinute ?? DEFAULT_MAX_CALLS_PER_MINUTE;
	const now = Date.now();
	callTimes = callTimes.filter((t) => now - t < 60_000);
	if (callTimes.length >= cap) return false;
	callTimes.push(now);
	return true;
}

/**
 * Append one training row to the trace JSONL — the offline classifier's
 * dataset. The row IS the training example, in the exact shape a
 * parallel-constrained-decoding head consumes (see serialize.ts): `context`
 * is the model input, `schema` the fields it answers, `labels` the soft
 * targets. `source` names the answering tier so calibrated Jev labels are
 * separable from naive-llm self-reported ones (filter or down-weight when
 * training). Monthly files, never throws.
 */
function traceCall(settings: JudgeSettings, node: string, source: string, req: JudgeRequest, result: JudgeResult): void {
	if (settings.trace === false || !settings.traceDir) return;
	try {
		fs.mkdirSync(settings.traceDir, { recursive: true });
		const file = path.join(settings.traceDir, `judge-${new Date().toISOString().slice(0, 7)}.jsonl`);
		const line = JSON.stringify({
			ts: new Date().toISOString(),
			node,
			source,
			elapsedMs: result.elapsedMs,
			context: toContext(req.state),
			schema: toSchema(req.questions),
			labels: toLabels(result.answers),
		});
		fs.appendFileSync(file, `${line}\n`, "utf8");
	} catch {
		// tracing must never break a session
	}
}

/** Per-node fabric activity for the /geocine judge status panel. */
export function judgeFabricStats(): string[] {
	if (ledger.size === 0) return ["fabric: no judge calls this session"];
	const lines: string[] = [];
	for (const [node, s] of ledger) {
		const avg = s.answered > 0 ? Math.round(s.totalMs / s.answered) : 0;
		const extras = [
			s.fellBack ? `${s.fellBack} via naive-llm` : "",
			s.degraded ? `${s.degraded} degraded` : "",
			s.throttled ? `${s.throttled} throttled` : "",
		]
			.filter(Boolean)
			.join(", ");
		lines.push(`${node}: ${s.answered}/${s.calls} answered${avg ? `, ~${avg}ms` : ""}${extras ? ` (${extras})` : ""}`);
	}
	return lines;
}

interface Tier {
	backend: JudgeBackend;
	settings: JudgeSettings;
}

/** The naive-llm fallback tier from judge.fallback, if configured. */
function fallbackTier(settings: JudgeSettings): Tier | undefined {
	const fb = settings.fallback;
	if (!fb?.baseUrl) return undefined;
	return {
		backend: naiveLlmJudge,
		settings: { ...settings, baseUrl: fb.baseUrl, model: fb.model, apiKeyEnv: fb.apiKeyEnv, maxTokens: fb.maxTokens },
	};
}

/**
 * The degradation ladder, best tier first: primary classifier (Jev), then
 * the naive-llm fallback. Empty = call sites use their heuristics alone.
 */
function tiersOf(cfg: JudgeSettings | undefined): Tier[] {
	const settings = cfg ?? {};
	if (settings.enabled === false) return [];
	const tiers: Tier[] = [];
	const backend = BACKENDS.find((b) => b.id === (settings.provider ?? "typesafe"));
	if (backend?.configured(settings)) tiers.push({ backend, settings });
	const fb = fallbackTier(settings);
	if (fb) tiers.push(fb);
	return tiers;
}

/** The best available tier, or undefined (= degrade to heuristics). */
export function resolveJudge(cfg: JudgeSettings | undefined): Tier | undefined {
	return tiersOf(cfg)[0];
}

/** One-line state for menus/status: which classifier answers, or why none. */
export function judgeStatus(cfg: JudgeSettings | undefined): string {
	const settings = cfg ?? {};
	if (settings.enabled === false) return "disabled — heuristic fallbacks only";
	const id = settings.provider ?? "typesafe";
	const backend = BACKENDS.find((b) => b.id === id);
	const fb = fallbackTier(settings);
	const fbNote = fb ? ` · fallback naive-llm @ ${fb.settings.baseUrl}` : "";
	const keyEnv = id === "typesafe" ? typesafeApiKeyEnv(settings) : (settings.apiKeyEnv ?? "TYPESAFE_API_KEY");
	if (!backend) return `unknown provider "${id}"${fbNote || " — heuristic fallbacks only"}`;
	if (!backend.configured(settings)) {
		if (fb) return `${id}: no API key (${keyEnv})${fbNote}`;
		return `${id}: no API key (${keyEnv}) — heuristic fallbacks only`;
	}
	if (id === "typesafe") {
		return `${id}/${typesafeModel(settings)} @ ${typesafeHost(settings)} ready${fbNote}`;
	}
	return `${id}/${settings.model ?? "jev-latest"} ready${fbNote}`;
}

/**
 * Ask typed questions over one state, walking the ladder: primary
 * classifier, then the naive-llm fallback, each under its own timeout.
 * Returns undefined when no tier answers — the caller's heuristic path
 * MUST handle that. Never throws.
 */
export async function judge(
	cfg: JudgeSettings | undefined,
	req: JudgeRequest,
	opts?: { signal?: AbortSignal; timeoutMs?: number; node?: string },
): Promise<JudgeResult | undefined> {
	const tiers = tiersOf(cfg);
	if (tiers.length === 0) return undefined;
	const nodeId = opts?.node ?? "other";
	const node = stats(nodeId);
	node.calls++;
	if (!underRateCap(tiers[0].settings)) {
		node.throttled++;
		return undefined; // degrade — the cap protects against decision loops
	}
	for (const [index, tier] of tiers.entries()) {
		if (opts?.signal?.aborted) return undefined;
		const controller = new AbortController();
		const timeoutMs = opts?.timeoutMs ?? tier.settings.timeoutMs ?? DEFAULT_TIMEOUT_MS;
		const timer = setTimeout(() => controller.abort(), timeoutMs);
		const onOuterAbort = () => controller.abort();
		opts?.signal?.addEventListener("abort", onOuterAbort, { once: true });
		try {
			const result = await tier.backend.judge(req, tier.settings, controller.signal);
			node.answered++;
			node.totalMs += result.elapsedMs;
			if (index > 0) node.fellBack++;
			traceCall(cfg ?? {}, nodeId, `${tier.backend.id}:${result.model}`, req, result);
			return { ...result, calibrated: tier.backend.calibrated };
		} catch {
			// fall through to the next tier
		} finally {
			clearTimeout(timer);
			opts?.signal?.removeEventListener("abort", onOuterAbort);
		}
	}
	node.degraded++;
	return undefined; // degrade — the judge must never break a session
}

/** Probability of yes for a noul answer, or undefined if absent/mistyped. */
export function noulOf(result: JudgeResult | undefined, id: string): number | undefined {
	const a = result?.answers[id];
	return a?.type === "noul" ? (a as NoulAnswer).noul : undefined;
}

export function choiceOf(result: JudgeResult | undefined, id: string): ChoiceAnswer | undefined {
	const a = result?.answers[id];
	return a?.type === "choice" ? (a as ChoiceAnswer) : undefined;
}

export function scoreOf(result: JudgeResult | undefined, id: string): ScoreAnswer | undefined {
	const a = result?.answers[id];
	return a?.type === "score" ? (a as ScoreAnswer) : undefined;
}
