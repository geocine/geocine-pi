// Shared configuration for the geocine-pi plugin set.
//
// One config file rules everything: ~/.pi/agent/geocine.json (global),
// optionally overridden by .pi/geocine.json in the project (shallow merge,
// models merged by name). See geocine.example.json in the package root.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { JudgeSettings } from "./judge/types.ts";

export interface ModelConfig {
	/** pi --provider value (e.g. "openrouter", "llama.cpp"). */
	provider?: string;
	/** pi --model value (e.g. "deepseek/deepseek-v4-pro-0813"). */
	model: string;
	/**
	 * What this model is the right rescuer FOR, in one line
	 * (e.g. "hard debugging and root-cause analysis", "architecture and
	 * planning", "content strict models falsely refuse"). Shown to the
	 * local model in the consult tool description (it proposes a rescuer
	 * by role) and to the user in the approval prompt.
	 */
	role?: string;
	/**
	 * Capability classes, free-form but with a suggested vocabulary:
	 * "default", "frontier", "abliterated", "cheap", "fast", "local",
	 * "intelligent". Anywhere a model name is accepted (the consult
	 * tool's `model` param, /consult @name) a class name resolves to a
	 * model carrying it, and the judge's route node uses classes to
	 * pick the cheapest model whose capabilities cover the need — the
	 * standing goal is to spend as few LLM tokens as possible. A model
	 * classed "default" is the fallback when nothing else decides.
	 */
	classes?: string[];
	/** pi --thinking value. */
	thinking?: string;
	/**
	 * Jail mode:
	 *  - "staged": model runs in a temp dir containing ONLY staged files
	 *    (context firewall — bounds its input token spend), enforced by the
	 *    jail sentry (out-of-root reads blocked and audited). Default.
	 *  - "none": model runs in the live cwd with read-only tools
	 *    (for free/local/lenient models where token waste costs nothing).
	 */
	jail?: "staged" | "none";
	/** Run the local guardrail pre-screen before consulting. Default false. */
	prescreen?: boolean;
	/** Extra notes injected into the briefing (e.g. persona/emphasis). */
	notes?: string;
	/** Skip the user approval prompt for LLM-invoked consults of this model. */
	autoApprove?: boolean;
}

export interface ApprovalConfig {
	/**
	 * Gate for LLM-invoked `consult` tool calls (user-typed /consult never asks):
	 *  - "ask" (default): prompt yes / no / always-allow / auto-approve-all.
	 *  - "judge": the fabric's approve node auto-approves clearly justified,
	 *    well-routed consults (>= approveThreshold); anything doubtful falls
	 *    back to the ask prompt. Never auto-denies — deny stays a human call.
	 *  - "auto": never prompt.
	 */
	consultTool?: "ask" | "judge" | "auto";
	/** Confidence the approve node needs to skip the prompt. Default 0.85. */
	approveThreshold?: number;
}

export interface WatchdogConfig {
	/** Master switch for the detection stack. Default true (tier 0 is free). */
	enabled?: boolean;
	/**
	 * Optional OpenAI-compatible endpoint for the tier-1 LLM watchdog
	 * (e.g. a second small llama.cpp instance). When absent, only the
	 * deterministic tier-0 counters run. Do NOT point this at the same
	 * single-slot server as the main model: it evicts the KV cache.
	 */
	baseUrl?: string;
	model?: string;
	apiKeyEnv?: string;
	/**
	 * When a judge classifier is configured, ask it for a verdict on EVERY
	 * turn that has new tool activity, not only when a tier-0 counter fires.
	 * This is what makes drift detectable at all (no counter can see it),
	 * and System One calls are fast/cheap enough to afford it. false =
	 * judge only verifies counter findings. Default true.
	 */
	judgeEveryTurn?: boolean;
	/** Inject "Located" hints back into the main session. Default true. */
	sendHints?: boolean;
	/** Minimum turns between two hints. Default 4. */
	hintCooldownTurns?: number;
	/** Consecutive identical tool calls that count as a loop. Default 3. */
	loopThreshold?: number;
	/** Consecutive failures of the same command that count as stuck. Default 3. */
	failStreakThreshold?: number;
}

export interface TriageConfig {
	/**
	 * Judge-powered task routing: at task start, score difficulty for the
	 * local model and pick a route (local / plan-first / frontier); mid-task,
	 * an escalate-now probability rides the watchdog's every-turn judge
	 * call. Requires a configured judge — silently off without one.
	 * Default true.
	 */
	enabled?: boolean;
	/**
	 * Mid-task escalate probability (noul) needed before suggesting a
	 * consult. High on purpose: the suggestion interrupts the loop.
	 * Default 0.75.
	 */
	escalateThreshold?: number;
	/** Minimum turns between two escalate suggestions. Default 8. */
	cooldownTurns?: number;
}

export interface GateConfig {
	/**
	 * Outcome gate: when the agent settles, judge the WORK PRODUCT (git
	 * diff, captured test/lint outputs, trace) — is the task done, and who
	 * acts next: continue (nudge the local model on), stop (done or needs
	 * the user), escalate (suggest a frontier consult). Requires a
	 * configured judge — silently off without one. Default true.
	 */
	enabled?: boolean;
	/**
	 * Max idle nudges (continue/escalate) per user task; a nudge starts a
	 * new local run, so this caps automatic token spend. Default 1.
	 */
	maxNudgesPerTask?: number;
	/** Max characters of git diff evidence sent to the judge. Default 8000. */
	maxDiffChars?: number;
}

export interface GuardConfig {
	/**
	 * Command guard: destructive-looking shell commands (recursive deletes,
	 * hard resets, force pushes, DROP TABLE, ...) are judged against the
	 * current task before execution; confident collateral damage is
	 * blocked with a reason the model sees. Deterministic prefilter first,
	 * so the judge only sees the rare suspicious command. No judge = allow
	 * (pi's own tool approval remains the fallback). Default true.
	 */
	enabled?: boolean;
	/**
	 * Collateral-damage probability needed to block. High on purpose —
	 * blocking a legitimate command is worse than letting pi's approval
	 * flow handle it. Default 0.8.
	 */
	blockThreshold?: number;
}

export interface ToolGuardConfig {
	/**
	 * Tool guard: the fabric's call-level "wasteful?" node, for local
	 * workers that are weak at tool use. A deterministic prefilter tracks
	 * exact-call repeats, identical retries after failure, and re-reads of
	 * the same file; only suspects reach the judge, which blocks confident
	 * thrash with a corrective reason the model reads. Frontier workers
	 * are never guarded; no judge = allow. Default true.
	 */
	enabled?: boolean;
	/** Wasteful probability needed to block. Default 0.8. */
	blockThreshold?: number;
	/** Max blocks per user task before the guard goes quiet. Default 3. */
	maxBlocksPerTask?: number;
}

export interface PrescreenConfig {
	/** Model name (from models) used as the local screener. */
	model?: string;
	/** Max staged bytes shown to the screener. Default 24576. */
	maxBytes?: number;
}

export interface RescueConfig {
	/** Capture manual local→frontier rescue episodes. Default true. */
	enabled?: boolean;
	/**
	 * Providers considered "local" (free). A model_select away from one of
	 * these to any other provider starts a rescue episode.
	 * Default: ["llama.cpp", "lmstudio", "ollama", "abliteration-ai"].
	 */
	localProviders?: string[];
	/** Model used by /distill to draft lessons. Default: prescreen model. */
	distillModel?: string;
}

export interface ContextConfig {
	/**
	 * Providers whose sessions get context-keeper treatment (early/idle
	 * compaction, pre-compaction reminder, ingestion pruner, and the
	 * arc/checkpoint compaction override). Any model from another provider
	 * uses pi's built-in compaction untouched. Default: true local servers
	 * (llama.cpp, lmstudio, ollama) — API providers, however cheap, ingest
	 * prompts fast enough that pi's own threshold is fine. Distinct from
	 * rescue.localProviders, which is about rescue-capture semantics.
	 */
	providers?: string[];
	/**
	 * Compaction summary style. Default "arc".
	 * - "arc": deterministic digest (ARC-style) — no model call, instant,
	 *   no paraphrase loss; the recall tool recovers exact content.
	 * - "checkpoint": LLM-written structured checkpoint (prefix-cache-
	 *   aligned summarization + shrink guarantee). Slower but narrative.
	 * - "off": pi's default compaction.
	 */
	mode?: "arc" | "checkpoint" | "off";
	/** @deprecated Legacy toggle: false = mode "off". Use `mode` instead. */
	checkpoint?: boolean;
	/**
	 * Registry entry (from `models`) that writes the checkpoint
	 * (mode "checkpoint" only). Default: the session's own model — for a
	 * local model this keeps the call on the warm KV cache.
	 */
	summarizer?: string;
	/** Max tokens for the checkpoint summary. Default 4096. */
	maxTokens?: number;
	/**
	 * Proactively compact when the context reaches this many tokens (only
	 * while a context.providers provider is active). pi's own threshold
	 * (contextWindow - reserveTokens) is far too late for a local server:
	 * at 500 tok/s prompt speed, a 150k-token re-ingest is minutes. dsh
	 * compacts at 0.8x context; ACM keeps the working set at 20-60k.
	 * Unset/0 disables the early trigger.
	 */
	compactAtTokens?: number;
	/**
	 * Also compact after this many minutes of idleness once the context is
	 * past half of compactAtTokens (dsh compactNow(): pay the compaction
	 * cost while nobody is waiting). Unset/0 disables.
	 */
	idleCompactMinutes?: number;
	/**
	 * Ingestion-time pruning (TokenPilot-style): oversized bash/powershell
	 * outputs are head/tail-trimmed ONCE, when captured, so they never
	 * enter the prompt at full size — cache-neutral even on hybrid
	 * recurrent models (Qwen3.8 class). The full output is stashed in the
	 * session and searchable with the recall tool. Default true.
	 */
	pruner?: boolean;
	/** Tool results larger than this many chars get pruned. Default 6000. */
	prunerThresholdChars?: number;
	/** Chars kept from the start of a pruned result. Default 1500. */
	prunerHeadChars?: number;
	/** Chars kept from the end of a pruned result. Default 1500. */
	prunerTailChars?: number;
	/**
	 * The `note` tool + verbatim pinning of notes into compaction digests
	 * (Codex-style model-written durable state). Default true.
	 */
	notes?: boolean;
	/**
	 * Inject a one-shot pre-compaction reminder when the context is within
	 * this many tokens of compactAtTokens, telling the model to pin
	 * load-bearing facts with `note` before the cut. Default 8000; 0 = off.
	 */
	reminderTokens?: number;
	/** Register the `recall` transcript-search tool. Default true. */
	recall?: boolean;
	/**
	 * Judge-rerank fuzzy recall results: when the exact query misses and
	 * BM25 keyword fallback returns candidates, the judge scores each for
	 * relevance to the query and confidently-irrelevant ones are dropped
	 * (weak models otherwise chase junk snippets). Exact matches are never
	 * reranked. No judge = results pass through. Default true.
	 */
	rerank?: boolean;
}

export interface QwenConfig {
	/** Persisted Qwen auto thinking mode, set via /harness (survives restarts and /reload). */
	auto?: boolean;
	/** Persisted Qwen manual thinking level, set via /harness (also the budget auto-mode borrows). */
	level?: "off" | "low" | "medium" | "high" | "xhigh" | "max";
	/**
	 * Thinking level for turns whose latest message contains an image
	 * (fresh screenshot/attachment). Overrides both the manual level and
	 * auto mode for that request only. Unset = no override. Set via
	 * /harness image <level|inherit>.
	 */
	imageLevel?: "off" | "low" | "medium" | "high" | "xhigh" | "max";
}

export interface HarnessConfig {
	/**
	 * Transparent tool aliasing: advertise each model family's trained tool
	 * names/schemas on the wire while pi stays canonical. Default true.
	 */
	aliases?: boolean;
}

export interface WebConfig {
	/**
	 * Which provider serves web_fetch / web_search:
	 *  - "auto" (default): first available provider — tinyfish when its key
	 *    is present, else builtin. A keyed provider that errors mid-call
	 *    falls back to builtin for that call.
	 *  - "tinyfish": TinyFish search + fetch APIs (pinned: errors surface).
	 *  - "builtin": DuckDuckGo HTML scrape + plain fetch, no API key.
	 */
	provider?: string;
	/**
	 * TinyFish API key (https://agent.tinyfish.ai/api-keys). A literal key
	 * or a "$VAR_NAME" environment reference. Falls back to the
	 * TINYFISH_API_KEY environment variable.
	 */
	tinyfishApiKey?: string;
}

export interface PdfConfig {
	/**
	 * Max characters one read_pdf call may return. The tool fills whole
	 * pages until the budget runs out and names the omitted pages, so a
	 * big PDF can never flood a local model's context. Default 24000.
	 */
	maxChars?: number;
	/** Max matches returned by a read_pdf search. Default 40. */
	maxSearchMatches?: number;
}

export const DEFAULT_LOCAL_PROVIDERS = ["llama.cpp", "lmstudio", "ollama", "abliteration-ai"];

/**
 * True when the session's ACTIVE model — whatever pi's model picker has
 * selected, read per event, never designated — runs on a cheap provider
 * (rescue.localProviders). "Local" is shorthand for cheap, not physically
 * local: the default list already includes hosted abliteration-ai, and a
 * budget cloud host (e.g. baseten running Qwen) belongs there too.
 *
 * Precondition for all escalation machinery that INJECTS messages or
 * blocks calls — triage steers, mid-task escalate suggestions,
 * outcome-gate nudges, tool-guard blocks. Injected messages grow an
 * expensive main model's context to suggest what the user already did
 * (switch up), so a frontier main model gets verdicts and status lines
 * only. Decisions themselves stay on the classifier: LLM tokens are for
 * work, never for deciding.
 */
export function isLocalWorker(model: unknown, cfg: GeocineConfig): boolean {
	const provider = (model as { provider?: string } | undefined)?.provider;
	if (!provider) return false;
	return (cfg.rescue?.localProviders ?? DEFAULT_LOCAL_PROVIDERS).includes(provider);
}

/**
 * Default context.providers: providers slow enough at prompt ingestion that
 * context-keeper's early compaction and digest override pay off. Narrower
 * than DEFAULT_LOCAL_PROVIDERS on purpose: abliteration-ai is a hosted API
 * with big windows — pi's built-in compaction handles it.
 */
export const DEFAULT_CONTEXT_PROVIDERS = ["llama.cpp", "lmstudio", "ollama"];

export interface GeocineConfig {
	models: Record<string, ModelConfig>;
	watchdog?: WatchdogConfig;
	triage?: TriageConfig;
	gate?: GateConfig;
	guard?: GuardConfig;
	toolGuard?: ToolGuardConfig;
	prescreen?: PrescreenConfig;
	rescue?: RescueConfig;
	approval?: ApprovalConfig;
	context?: ContextConfig;
	qwen?: QwenConfig;
	harness?: HarnessConfig;
	pdf?: PdfConfig;
	web?: WebConfig;
	/**
	 * System One classifier (lib/judge): fast typed judgments used by the
	 * watchdog (verdict confirmation) and the advisor prescreen (refusal
	 * risk). Unset/unreachable = those call sites keep their heuristic or
	 * LLM fallbacks. provider is a backend id so the classifier is
	 * replaceable without touching call sites.
	 */
	judge?: JudgeSettings;
	/** Directory for decision logs. Default ~/.pi/agent/consult-log */
	logDir?: string;
}

export const CONFIG_FILE = path.join(os.homedir(), ".pi", "agent", "geocine.json");

function readJson(file: string): Partial<GeocineConfig> | undefined {
	try {
		return JSON.parse(fs.readFileSync(file, "utf8")) as Partial<GeocineConfig>;
	} catch {
		return undefined;
	}
}

export function loadConfig(cwd?: string): GeocineConfig {
	const global = readJson(CONFIG_FILE) ?? {};
	const project = cwd ? readJson(path.join(cwd, ".pi", "geocine.json")) : undefined;

	const merged: GeocineConfig = {
		models: stripCommentKeys({ ...(global.models ?? {}), ...(project?.models ?? {}) }),
		watchdog: { ...(global.watchdog ?? {}), ...(project?.watchdog ?? {}) },
		triage: { ...(global.triage ?? {}), ...(project?.triage ?? {}) },
		gate: { ...(global.gate ?? {}), ...(project?.gate ?? {}) },
		guard: { ...(global.guard ?? {}), ...(project?.guard ?? {}) },
		prescreen: { ...(global.prescreen ?? {}), ...(project?.prescreen ?? {}) },
		rescue: { ...(global.rescue ?? {}), ...(project?.rescue ?? {}) },
		approval: { ...(global.approval ?? {}), ...(project?.approval ?? {}) },
		context: { ...(global.context ?? {}), ...(project?.context ?? {}) },
		qwen: { ...(global.qwen ?? {}), ...(project?.qwen ?? {}) },
		harness: { ...(global.harness ?? {}), ...(project?.harness ?? {}) },
		pdf: { ...(global.pdf ?? {}), ...(project?.pdf ?? {}) },
		web: { ...(global.web ?? {}), ...(project?.web ?? {}) },
		judge: { ...(global.judge ?? {}), ...(project?.judge ?? {}) },
		logDir: project?.logDir ?? global.logDir,
	};
	// Wire the judge trace into the consult-log dir (an explicit traceDir
	// wins). The trace is the offline-classifier dataset — see lib/judge.
	merged.judge = { traceDir: logDir(merged), ...(merged.judge ?? {}) };
	return merged;
}

/** JSON configs use "$comment" keys inside maps; they are not entries. */
function stripCommentKeys<T>(obj: Record<string, T>): Record<string, T> {
	return Object.fromEntries(Object.entries(obj).filter(([k]) => !k.startsWith("$")));
}

/** Effective prescreen decision for one model (its own flag). */
export function shouldPrescreen(model: ModelConfig): boolean {
	return model.prescreen === true;
}

/**
 * Resolve `wanted` within a pool: exact name first, then as a capability
 * class (preferring a model also classed "default"). Names are just
 * map labels — classes are the selection language.
 */
function pickByNameOrClass(pool: Record<string, ModelConfig>, wanted: string): string | undefined {
	if (pool[wanted]) return wanted;
	const inClass = Object.keys(pool).filter((n) => pool[n].classes?.includes(wanted));
	if (inClass.length === 0) return undefined;
	return inClass.find((n) => pool[n].classes?.includes("default")) ?? inClass[0];
}

/** The addressable handles of a pool (classes; @key only when unclassed). */
function poolHandles(pool: Record<string, ModelConfig>): string {
	return Object.entries(pool)
		.map(([n, c]) => (c.classes?.length ? c.classes.join("/") : `@${n}`))
		.join(", ");
}

/**
 * Resolve a model by capability class (or raw map key). Used by the
 * consult tool, /consult, and infrastructure roles (prescreen screener,
 * distiller). No name = the model classed "default", else the first
 * configured — classes are the selection language, keys are just labels.
 */
export function resolveModel(
	cfg: GeocineConfig,
	name?: string,
): { name: string; model: ModelConfig } | { error: string } {
	const names = Object.keys(cfg.models);
	if (names.length === 0) {
		return { error: `No models configured. Create ${CONFIG_FILE} (see geocine.example.json).` };
	}
	if (!name) {
		const fallback = names.find((n) => cfg.models[n].classes?.includes("default")) ?? names[0];
		return { name: fallback, model: cfg.models[fallback] };
	}
	const picked = pickByNameOrClass(cfg.models, name);
	if (!picked) {
		return { error: `Unknown model or class "${name}". Configured: ${poolHandles(cfg.models)}` };
	}
	return { name: picked, model: cfg.models[picked] };
}

/** The rescuer /consult or the consult tool would use with no name given. */
export function defaultModelName(cfg: GeocineConfig): string | undefined {
	const resolved = resolveModel(cfg);
	return "error" in resolved ? undefined : resolved.name;
}

/** Display label for a model: provider/model — never the map key. */
export function modelLabel(c: ModelConfig): string {
	return `${c.provider ?? "?"}/${c.model}`;
}

/**
 * The handle to WRITE when targeting this model (steer hints, editor
 * prefills): its first class that resolves back to it — classes are the
 * selection language — falling back to the raw map key for unclassed ones.
 */
export function modelHandle(cfg: GeocineConfig, name: string): string {
	const pool = cfg.models;
	for (const cls of pool[name]?.classes ?? []) {
		if (pickByNameOrClass(pool, cls) === name) return cls;
	}
	return name;
}

export function logDir(cfg: GeocineConfig): string {
	return cfg.logDir ?? path.join(os.homedir(), ".pi", "agent", "consult-log");
}

/**
 * Mutate the GLOBAL config file (~/.pi/agent/geocine.json) in place.
 * Extensions re-read config per event, so changes take effect immediately —
 * no reload needed. Note: project-level .pi/geocine.json overrides still win.
 */
export function updateGlobalConfig(mutate: (cfg: Partial<GeocineConfig>) => void): GeocineConfig {
	const cfg = readJson(CONFIG_FILE) ?? {};
	mutate(cfg);
	fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
	fs.writeFileSync(CONFIG_FILE, `${JSON.stringify(cfg, null, "\t")}\n`, "utf8");
	return loadConfig();
}
