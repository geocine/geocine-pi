// context-keeper: lossless-leaning context management for long sessions.
//
// Three mechanisms, all informed by the same research thread (ACM /
// "Context as an Environment" / raw-transcript-search-rivals-structured-
// memory) and by deepseek-harness's compaction package family:
//
//  1. PRUNER (deterministic, model-free) — before each LLM call, oversized
//     tool results older than the last N are trimmed to head + tail with a
//     marker. Ported from deepseek-harness compaction-tool-result-pruner.
//     The session log keeps the full output; only the projection the model
//     sees is trimmed, so nothing is lost. This delays compaction and cuts
//     per-request pressure for free.
//
//  2. RECALL TOOL (agent-controlled retrieval) — searches the FULL raw
//     session transcript, including spans hidden by compaction and text
//     removed by the pruner. This is the "query_memory" half of ACM and the
//     Codex-style transcript-history lookup: compaction stops being lossy
//     because the agent can always search what was cut.
//
//  3. CHECKPOINT COMPACTION — replaces pi's default compaction summary with
//     a structured checkpoint written by a configurable model. Ported from
//     deepseek-harness compaction-basic: the summarization call replays the
//     conversation's own system prompt and messages, then appends the
//     instruction as the final user message, so it is a genuine prefix of
//     the last request and reuses the provider's KV cache (nearly free on a
//     single-slot llama.cpp server). A shrink guarantee falls back to pi's
//     default compaction when the summary is not actually smaller.
//
// Config: `context` block in geocine.json — see geocine.example.json.

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { convertToLlm } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { type ContextConfig, DEFAULT_LOCAL_PROVIDERS, loadConfig, logDir } from "../lib/config.ts";
import { appendRecord, newCid, nowIso } from "../lib/consult-log.ts";

const PRUNE_MARKER_PREFIX = "\n[geocine-pi: pruned ";
const DEFAULTS = {
	maxTokens: 4096,
	prunerThresholdChars: 6000,
	prunerHeadChars: 1500,
	prunerTailChars: 1500,
	prunerProtectRecent: 6,
};

function ctxCfg(cwd: string): ContextConfig {
	return loadConfig(cwd).context ?? {};
}

function mainModelId(ctx: ExtensionContext): string | undefined {
	const model = ctx.model as { provider?: string; id?: string } | undefined;
	return model ? `${model.provider}/${model.id}` : undefined;
}

// ---------- 1. deterministic tool-result pruner ----------

interface TextBlock {
	type: string;
	text?: string;
}

/** Total chars across text blocks. */
function measure(blocks: TextBlock[]): number {
	let n = 0;
	for (const b of blocks) if (b.type === "text" && typeof b.text === "string") n += b.text.length;
	return n;
}

/**
 * Head/tail-trim the text of one oversized tool result. Deterministic:
 * the same input always produces the same output, so the pruned prefix is
 * stable across turns (one cache miss when a result first crosses the
 * protection boundary, then stable).
 */
function pruneBlocks(blocks: TextBlock[], cfg: Required<Pick<ContextConfig, "prunerThresholdChars" | "prunerHeadChars" | "prunerTailChars">>): TextBlock[] | null {
	const total = measure(blocks);
	if (total <= cfg.prunerThresholdChars) return null;
	// Already pruned in the session itself (e.g. re-run)? Skip.
	if (blocks.some((b) => b.type === "text" && b.text?.includes(PRUNE_MARKER_PREFIX.trim()))) return null;

	const removedStart = cfg.prunerHeadChars;
	const removedEnd = total - cfg.prunerTailChars;
	const removed = removedEnd - removedStart;
	if (removed <= 0) return null;
	const marker = `${PRUNE_MARKER_PREFIX}${removed} chars from the middle of this old tool result. The full output is in the session transcript — use the recall tool to search it.]\n`;

	const out: TextBlock[] = [];
	let consumed = 0;
	let markerInserted = false;
	for (const block of blocks) {
		if (block.type !== "text" || typeof block.text !== "string") {
			out.push(block);
			continue;
		}
		const start = consumed;
		const end = start + block.text.length;
		const headEnd = Math.min(block.text.length, Math.max(0, removedStart - start));
		const tailStart = Math.min(block.text.length, Math.max(0, removedEnd - start));
		const intersects = start < removedEnd && end > removedStart;
		const mark = intersects && !markerInserted ? marker : "";
		if (mark) markerInserted = true;
		const text = block.text.slice(0, headEnd) + mark + block.text.slice(tailStart);
		if (text.length > 0) out.push({ ...block, text });
		consumed = end;
	}
	return markerInserted ? out : null;
}

// ---------- 2. recall (raw-transcript search) ----------

interface EntryLike {
	type?: string;
	timestamp?: string | number;
	message?: {
		role?: string;
		toolName?: string;
		content?: unknown;
	};
}

/** Flatten one session message into searchable text. */
function entryText(entry: EntryLike): string {
	const msg = entry.message;
	if (!msg) return "";
	const parts: string[] = [];
	const content = msg.content;
	if (typeof content === "string") parts.push(content);
	else if (Array.isArray(content)) {
		for (const block of content as Array<Record<string, unknown>>) {
			if (typeof block.text === "string") parts.push(block.text);
			if (typeof block.thinking === "string") parts.push(block.thinking);
			// tool calls: name + arguments
			if (block.type === "toolCall") {
				parts.push(`${String(block.name ?? "")} ${JSON.stringify(block.arguments ?? {})}`);
			}
		}
	}
	return parts.join("\n");
}

function searchTranscript(
	entries: EntryLike[],
	query: string,
	maxResults: number,
): { total: number; snippets: string[] } {
	let re: RegExp;
	try {
		re = new RegExp(query, "i");
	} catch {
		re = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
	}
	const snippets: string[] = [];
	let total = 0;
	// Newest first: recent forgotten details are the usual target.
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type !== "message") continue;
		const role = entry.message?.role ?? "?";
		const text = entryText(entry);
		const m = re.exec(text);
		if (!m) continue;
		total++;
		if (snippets.length >= maxResults) continue;
		const at = m.index;
		const from = Math.max(0, at - 250);
		const to = Math.min(text.length, at + 350);
		const snippet = `${from > 0 ? "…" : ""}${text.slice(from, to)}${to < text.length ? "…" : ""}`;
		const tool = entry.message?.toolName ? ` tool=${entry.message.toolName}` : "";
		const ts = entry.timestamp ? ` ${String(entry.timestamp)}` : "";
		snippets.push(`--- [#${i} ${role}${tool}${ts}] ---\n${snippet}`);
	}
	return { total, snippets };
}

// ---------- 3. checkpoint compaction ----------

// Structured checkpoint instruction, ported from deepseek-harness
// compaction-basic. Delivered as the FINAL user message after the replayed
// conversation (not as a separate system prompt) so the summarization call
// is a prefix of the last request and reuses the provider's KV cache.
const CHECKPOINT_INSTRUCTION = [
	"You are now acting as a compaction engine for this coding session. Condense the conversation ABOVE into a structured checkpoint that lets another model resume the work with no loss of essential context.",
	"",
	'Output EXACTLY the Markdown structure below: keep every section, in order. Use terse bullets. Write "(none)" for an empty section — never drop a section.',
	"",
	"## Primary Request and Intent",
	"## Key Technical Concepts",
	"## Files and Code",
	"- [exact path: why it matters, key changes]",
	"## Errors and Fixes",
	"## Pending Jobs",
	"## Current Work",
	"## Next Step",
	"## Critical Context",
	"- [decisions + rationale, constraints, user preferences, open questions]",
	"",
	"Rules:",
	"- Preserve exact file paths, commands, error strings, identifiers, numeric values, and function signatures.",
	"- Capture user feedback and explicit corrections faithfully.",
	"- Do NOT mention this summarization request or that the context was compacted.",
	"- Output only the checkpoint text: do not call any tool.",
	"- If the conversation above starts with an earlier compaction summary (a <summary> block), do not copy it verbatim: keep still-true facts, drop stale ones, and merge newer information into one consolidated checkpoint.",
].join("\n");

const RECALL_FOOTER =
	"\n\n(Older context was compacted away. The full raw transcript is still searchable with the recall tool — use it before re-reading files or re-running commands to recover details like exact error text, earlier tool output, or prior decisions.)";

export default function contextKeeper(pi: ExtensionAPI) {
	// -- 0. proactive compaction: pi's own threshold (contextWindow -
	// reserveTokens) fires far too late for a local server, where every
	// context token is paid again at prompt-processing speed whenever the
	// cache misses (and hybrid recurrent models like Qwen3.8 miss hard:
	// prior-turn <think> stripping diverges the prompt every turn). Trigger
	// early, dsh/ACM-style, while a local provider is active.
	//
	// Fires on agent_settled, NOT turn_end: mid-run the next LLM request is
	// already in flight, and compact() aborts it ("This operation was
	// aborted" + a dead run). Settled = nothing in flight, compaction is
	// free to run. reserveTokens can't do this natively: it is global, and
	// a value tuned for a 262k local window breaks smaller cloud models. --
	let compactPending = false;
	pi.on("session_compact", () => {
		compactPending = false;
	});
	pi.on("session_compact_failed", () => {
		compactPending = false;
	});
	pi.on("agent_settled", async (_event, ctx) => {
		const full = loadConfig(ctx.cwd);
		const at = full.context?.compactAtTokens;
		if (!at || at <= 0 || compactPending) return;
		const provider = (ctx.model as { provider?: string } | undefined)?.provider;
		const locals = full.rescue?.localProviders ?? DEFAULT_LOCAL_PROVIDERS;
		if (!provider || !locals.includes(provider)) return;
		const usage = ctx.getContextUsage();
		if (usage?.tokens == null || usage.tokens < at) return;
		compactPending = true;
		ctx.compact({
			onError: () => {
				compactPending = false;
			},
		});
	});

	// -- 1. pruner: OPT-IN. Runs before every LLM call on a deep copy of
	// messages. Every newly pruned result mutates the prompt mid-context:
	// cheap for cloud caching, a partial re-ingest for local standard-KV
	// models, and a near-full re-ingest for hybrid recurrent models. --
	pi.on("context", async (event, ctx) => {
		const cfg = ctxCfg(ctx.cwd);
		if (cfg.pruner !== true) return;
		const pruneCfg = {
			prunerThresholdChars: cfg.prunerThresholdChars ?? DEFAULTS.prunerThresholdChars,
			prunerHeadChars: cfg.prunerHeadChars ?? DEFAULTS.prunerHeadChars,
			prunerTailChars: cfg.prunerTailChars ?? DEFAULTS.prunerTailChars,
		};
		const protect = cfg.prunerProtectRecent ?? DEFAULTS.prunerProtectRecent;

		const messages = event.messages as Array<{ role?: string; content?: unknown }>;
		const toolResultIdx: number[] = [];
		for (let i = 0; i < messages.length; i++) {
			if (messages[i].role === "toolResult" && Array.isArray(messages[i].content)) toolResultIdx.push(i);
		}
		const prunable = toolResultIdx.slice(0, Math.max(0, toolResultIdx.length - protect));
		let changed = false;
		for (const i of prunable) {
			const pruned = pruneBlocks(messages[i].content as TextBlock[], pruneCfg);
			if (pruned) {
				messages[i].content = pruned;
				changed = true;
			}
		}
		return changed ? { messages: event.messages } : undefined;
	});

	// -- 2. recall tool: agent-controlled search over the raw transcript --
	pi.registerTool({
		name: "recall",
		label: "Recall",
		description:
			"Search this session's FULL raw transcript — including history that was compacted away or trimmed from old tool outputs. Use it to recover exact error messages, earlier command output, file contents you already read, or decisions made earlier, instead of re-running commands or re-reading files. Regex or plain text; newest matches first.",
		promptSnippet: "Search the full session transcript (survives compaction) for forgotten details",
		promptGuidelines: [
			"After a context checkpoint, use recall to recover specifics the checkpoint dropped (exact errors, paths, earlier outputs) before redoing work.",
		],
		parameters: Type.Object({
			query: Type.String({
				description: "Regex (case-insensitive) or literal text to find, e.g. 'ENOENT|permission denied' or a function name.",
			}),
			maxResults: Type.Optional(Type.Number({ description: "Max snippets to return. Default 5." })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const cfg = ctxCfg(ctx.cwd);
			if (cfg.recall === false) {
				return { content: [{ type: "text", text: "recall is disabled in geocine.json (context.recall)." }], details: {} };
			}
			const entries = ctx.sessionManager.getEntries() as EntryLike[];
			const max = Math.min(Math.max(1, params.maxResults ?? 5), 20);
			const { total, snippets } = searchTranscript(entries, params.query, max);
			const text =
				total === 0
					? `No transcript matches for: ${params.query}`
					: `${total} match(es) in the raw transcript (showing ${snippets.length}, newest first):\n\n${snippets.join("\n\n")}`;
			return { content: [{ type: "text", text: text.slice(0, 12_000) }], details: { total } };
		},
	});

	// -- 3. checkpoint compaction --
	pi.on("session_before_compact", async (event, ctx) => {
		const cfg = ctxCfg(ctx.cwd);
		if (cfg.checkpoint === false) return; // pi default compaction
		const started = Date.now();
		const { preparation, signal, reason } = event;
		const { messagesToSummarize, turnPrefixMessages, tokensBefore, firstKeptEntryId, previousSummary } = preparation;
		const all = [...messagesToSummarize, ...turnPrefixMessages];
		if (all.length === 0) return;

		// Summarizer: a named consultant's model, or the session's own model
		// (which keeps the call on the warm KV cache of a local server).
		let model = ctx.model;
		let summarizerName = mainModelId(ctx) ?? "main";
		if (cfg.summarizer) {
			const consultant = loadConfig(ctx.cwd).consultants[cfg.summarizer];
			const found = consultant?.provider ? ctx.modelRegistry.find(consultant.provider, consultant.model) : undefined;
			if (found) {
				model = found;
				summarizerName = `${consultant.provider}/${consultant.model}`;
			} else {
				ctx.ui.notify(`context.summarizer "${cfg.summarizer}" not resolvable; using session model`, "warning");
			}
		}
		if (!model) return;

		// Elapsed ticker in the footer status bar. The core "Compacting
		// context..." spinner line is not writable from an extension, so the
		// footer carries the timer instead.
		const fmtElapsed = () => {
			const seconds = Math.round((Date.now() - started) / 1000);
			return seconds >= 60 ? `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s` : `${seconds}s`;
		};
		const ticker = setInterval(() => {
			ctx.ui.setStatus("context-keeper", `compacting ${fmtElapsed()}`);
		}, 1000);

		const log = (outcome: "custom" | "fallback_empty" | "fallback_error" | "fallback_not_smaller", summaryChars: number, error?: string) => {
			appendRecord(logDir(loadConfig(ctx.cwd)), {
				type: "compaction",
				cid: newCid(),
				ts: nowIso(),
				cwd: ctx.cwd,
				mainModel: mainModelId(ctx),
				reason,
				summarizer: summarizerName,
				tokensBefore,
				messagesSummarized: all.length,
				summaryChars,
				outcome,
				elapsedMs: Date.now() - started,
				...(error ? { error } : {}),
			});
		};

		try {
			// Prefix-cache alignment: same system prompt, the actual
			// conversation messages, then the instruction as the only novel
			// suffix. A prior summary must be replayed EXACTLY as the live
			// context renders it (pi wraps it as a user message with a fixed
			// prefix/suffix): any wording difference in this first message
			// invalidates the provider cache at position 0, turning every
			// compaction into a full re-ingest on a local server. Building
			// the same compactionSummary message pi uses and letting
			// convertToLlm render it guarantees byte identity.
			if (previousSummary) {
				all.unshift({
					role: "compactionSummary",
					summary: previousSummary,
					tokensBefore: 0,
					timestamp: Date.now(),
				} as (typeof all)[number]);
			}
			const llmMessages = convertToLlm(all);
			const instructions = event.customInstructions ? `\n\nAdditional focus requested by the user: ${event.customInstructions}` : "";
			llmMessages.push({
				role: "user",
				content: [{ type: "text", text: CHECKPOINT_INSTRUCTION + instructions }],
				timestamp: Date.now(),
			} as (typeof llmMessages)[number]);

			const response = await ctx.modelRegistry.complete(
				model,
				{ systemPrompt: ctx.getSystemPrompt(), messages: llmMessages },
				{ maxTokens: cfg.maxTokens ?? DEFAULTS.maxTokens, signal },
			);
			const summary = response.content
				.filter((c): c is { type: "text"; text: string } => c.type === "text")
				.map((c) => c.text)
				.join("\n")
				.trim();

			if (!summary) {
				log("fallback_empty", 0);
				return; // pi default takes over
			}
			// Shrink guarantee (deepseek-harness): a checkpoint that is not
			// clearly smaller than what it replaces makes things worse.
			const spanChars = JSON.stringify(llmMessages).length;
			if (summary.length >= spanChars * 0.5) {
				log("fallback_not_smaller", summary.length);
				return;
			}

			log("custom", summary.length);
			return {
				compaction: {
					summary: summary + RECALL_FOOTER,
					firstKeptEntryId,
					tokensBefore,
					usage: response.usage,
				},
			};
		} catch (err) {
			if (!signal.aborted) {
				const message = err instanceof Error ? err.message : String(err);
				log("fallback_error", 0, message);
				ctx.ui.notify(`Checkpoint compaction failed (${message}); using pi default`, "warning");
			}
			return; // pi default takes over
		} finally {
			clearInterval(ticker);
			ctx.ui.setStatus("context-keeper", `last compaction ${fmtElapsed()}`);
		}
	});
}
