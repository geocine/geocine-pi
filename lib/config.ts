// Shared configuration for the geocine-pi plugin set.
//
// One config file rules everything: ~/.pi/agent/geocine.json (global),
// optionally overridden by .pi/geocine.json in the project (shallow merge,
// consultants merged by name). See geocine.example.json in the package root.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface ConsultantConfig {
	/** pi --provider value (e.g. "openrouter", "llama.cpp"). */
	provider?: string;
	/** pi --model value (e.g. "deepseek/deepseek-v4-pro-0813"). */
	model: string;
	/**
	 * What this consultant is the right rescuer FOR, in one line
	 * (e.g. "hard debugging and root-cause analysis", "architecture and
	 * planning", "content strict models falsely refuse"). Shown to the
	 * local model in the consult tool description (it proposes a rescuer
	 * by role) and to the user in the approval prompt.
	 */
	role?: string;
	/** pi --thinking value. */
	thinking?: string;
	/**
	 * Jail mode:
	 *  - "staged": consultant runs in a temp dir containing ONLY staged files
	 *    (context firewall — bounds its input token spend). Default.
	 *  - "docker": staged + wrapped in the vendored docker jail (needs image).
	 *  - "none": consultant runs in the live cwd with read-only tools
	 *    (for free/local/lenient consultants where token waste costs nothing).
	 */
	jail?: "staged" | "docker" | "none";
	/** Run the local guardrail pre-screen before consulting. Default false. */
	prescreen?: boolean;
	/** Extra notes injected into the briefing (e.g. persona/emphasis). */
	notes?: string;
	/** Env var NAMES this consultant needs forwarded into a docker jail. */
	envKeys?: string[];
	/** Skip the user approval prompt for LLM-invoked consults of this consultant. */
	autoApprove?: boolean;
}

export interface ApprovalConfig {
	/**
	 * Gate for LLM-invoked `consult` tool calls (user-typed /consult never asks):
	 *  - "ask" (default): prompt yes / no / always-allow / auto-approve-all.
	 *  - "auto": never prompt.
	 */
	consultTool?: "ask" | "auto";
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
	/** Inject "Located" hints back into the main session. Default true. */
	sendHints?: boolean;
	/** Minimum turns between two hints. Default 4. */
	hintCooldownTurns?: number;
	/** Consecutive identical tool calls that count as a loop. Default 3. */
	loopThreshold?: number;
	/** Consecutive failures of the same command that count as stuck. Default 3. */
	failStreakThreshold?: number;
}

export interface PrescreenConfig {
	/** Consultant name (from consultants) used as the local screener. */
	consultant?: string;
	/** Max staged bytes shown to the screener. Default 24576. */
	maxBytes?: number;
}

export interface DockerConfig {
	/** Image name for the docker jail. Default "geocine-consult". */
	image?: string;
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
	/** Consultant used by /distill to draft lessons. Default: prescreen consultant. */
	distillConsultant?: string;
}

export interface ContextConfig {
	/**
	 * Replace pi's default compaction summary with the structured checkpoint
	 * (prefix-cache-aligned summarization + shrink guarantee). Default true.
	 */
	checkpoint?: boolean;
	/**
	 * Consultant name (from consultants) whose model writes the checkpoint.
	 * Default: the session's own model — for a local model this keeps the
	 * summarization call on the warm KV cache, making it nearly free.
	 */
	summarizer?: string;
	/** Max tokens for the checkpoint summary. Default 4096. */
	maxTokens?: number;
	/**
	 * Proactively compact when the context reaches this many tokens (only
	 * while a LOCAL provider is active — see rescue.localProviders). pi's
	 * own threshold (contextWindow - reserveTokens) is far too late for a
	 * local server: at 500 tok/s prompt speed, a 150k-token re-ingest is
	 * minutes. dsh compacts at 0.8x context; ACM keeps the working set at
	 * 20-60k. Unset/0 disables the early trigger.
	 */
	compactAtTokens?: number;
	/**
	 * Deterministic head/tail pruning of OLD oversized tool results before
	 * each LLM call (model-free; the session log keeps the full output and
	 * the recall tool can still search it). Default FALSE: every newly
	 * pruned result changes the prompt mid-context, which costs a partial
	 * re-ingest on standard KV models and a near-FULL re-ingest on hybrid
	 * recurrent models (Qwen3.8 class) — enable only for providers with
	 * cheap prompt processing.
	 */
	pruner?: boolean;
	/** Tool results larger than this many chars get pruned. Default 6000. */
	prunerThresholdChars?: number;
	/** Chars kept from the start of a pruned result. Default 1500. */
	prunerHeadChars?: number;
	/** Chars kept from the end of a pruned result. Default 1500. */
	prunerTailChars?: number;
	/** The N most recent tool results are never pruned. Default 6. */
	prunerProtectRecent?: number;
	/** Register the `recall` transcript-search tool. Default true. */
	recall?: boolean;
}

export interface QwenConfig {
	/** Persisted /qwen auto mode (survives restarts and /reload). */
	auto?: boolean;
	/** Persisted /qwen manual level (also the budget auto-mode borrows). */
	level?: "off" | "low" | "medium" | "high" | "xhigh" | "max";
}

export const DEFAULT_LOCAL_PROVIDERS = ["llama.cpp", "lmstudio", "ollama", "abliteration-ai"];

export interface GeocineConfig {
	consultants: Record<string, ConsultantConfig>;
	/** Name of the default consultant for /consult and the consult tool. */
	defaultConsultant?: string;
	watchdog?: WatchdogConfig;
	prescreen?: PrescreenConfig;
	docker?: DockerConfig;
	rescue?: RescueConfig;
	approval?: ApprovalConfig;
	context?: ContextConfig;
	qwen?: QwenConfig;
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
		consultants: { ...(global.consultants ?? {}), ...(project?.consultants ?? {}) },
		defaultConsultant: project?.defaultConsultant ?? global.defaultConsultant,
		watchdog: { ...(global.watchdog ?? {}), ...(project?.watchdog ?? {}) },
		prescreen: { ...(global.prescreen ?? {}), ...(project?.prescreen ?? {}) },
		docker: { ...(global.docker ?? {}), ...(project?.docker ?? {}) },
		rescue: { ...(global.rescue ?? {}), ...(project?.rescue ?? {}) },
		approval: { ...(global.approval ?? {}), ...(project?.approval ?? {}) },
		context: { ...(global.context ?? {}), ...(project?.context ?? {}) },
		qwen: { ...(global.qwen ?? {}), ...(project?.qwen ?? {}) },
		logDir: project?.logDir ?? global.logDir,
	};
	return merged;
}

export function resolveConsultant(
	cfg: GeocineConfig,
	name?: string,
): { name: string; consultant: ConsultantConfig } | { error: string } {
	const wanted = name ?? cfg.defaultConsultant;
	const names = Object.keys(cfg.consultants);
	if (names.length === 0) {
		return { error: `No consultants configured. Create ${CONFIG_FILE} (see geocine.example.json).` };
	}
	if (!wanted) {
		return { error: `No consultant named and no defaultConsultant set. Configured: ${names.join(", ")}` };
	}
	const consultant = cfg.consultants[wanted];
	if (!consultant) {
		return { error: `Unknown consultant "${wanted}". Configured: ${names.join(", ")}` };
	}
	return { name: wanted, consultant };
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
