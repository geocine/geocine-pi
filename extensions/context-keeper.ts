// context-keeper: lossless-leaning context management for long sessions.
//
// Mechanisms, informed by ACM (2607.23809), ARC (2607.25066), TokenPilot
// (2606.17016), and deepseek-harness's compaction package family:
//
//  0. EARLY + IDLE COMPACTION — pi's own threshold (contextWindow -
//     reserveTokens) fires far too late for a local server. Compact when a
//     run settles above `compactAtTokens`, and optionally after
//     `idleCompactMinutes` of idleness above half that threshold (dsh
//     compactNow(): pay the cost while nobody is waiting).
//
//  1. INGESTION PRUNER (deterministic, model-free) — oversized bash/
//     powershell outputs are trimmed to head + tail ONCE, when they enter
//     the session (TokenPilot's ingestion gate). A tail append never breaks
//     the provider prefix cache — unlike retroactive mid-context pruning,
//     which forces re-ingest (near-total on hybrid recurrent models). The
//     full output is stashed as a session entry so recall can search it.
//
//  2. RECALL TOOL (agent-controlled retrieval) — searches the FULL raw
//     transcript, including compacted spans and pruned-output stashes. This
//     is ACM's query_memory / ARC's _recall: compaction stops being lossy
//     because the agent can always search what was cut. (ARC: recall-backed
//     deterministic compaction beat LLM summarization 99.4% vs 88.1% on
//     needle recovery.)
//
//  3. COMPACTION MODES
//     - "arc" (default): deterministic digest — terse action lines, tool
//       results as head/tail stubs, thinking dropped, no model call. Zero
//       latency and no paraphrase loss; recall recovers exact content.
//     - "checkpoint": LLM-written structured checkpoint (dsh
//       compaction-basic), prefix-cache-aligned with a shrink guarantee.
//     - "off": pi default compaction.
//
// Config: `context` block in geocine.json — see geocine.example.json.

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { convertToLlm } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { type ContextConfig, DEFAULT_LOCAL_PROVIDERS, loadConfig, logDir } from "../lib/config.ts";
import { appendRecord, newCid, nowIso } from "../lib/consult-log.ts";

const PRUNED_STASH_TYPE = "geocine-pruned";
const PRUNE_MARKER_PREFIX = "\n[geocine-pi: trimmed ";
const ARC_DIGEST_BUDGET = 10_000; // chars; ~2.5k tokens — always far smaller than the span
const DEFAULTS = {
	maxTokens: 4096,
	prunerThresholdChars: 6000,
	prunerHeadChars: 1500,
	prunerTailChars: 1500,
};

type ContextMode = "arc" | "checkpoint" | "off";

function ctxCfg(cwd: string): ContextConfig {
	return loadConfig(cwd).context ?? {};
}

function contextMode(cfg: ContextConfig): ContextMode {
	if (cfg.mode === "arc" || cfg.mode === "checkpoint" || cfg.mode === "off") return cfg.mode;
	// Legacy boolean: checkpoint:false meant "pi default".
	if (cfg.checkpoint === false) return "off";
	return "arc";
}

function mainModelId(ctx: ExtensionContext): string | undefined {
	const model = ctx.model as { provider?: string; id?: string } | undefined;
	return model ? `${model.provider}/${model.id}` : undefined;
}

// ---------- shared text helpers ----------

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

function blocksText(blocks: TextBlock[]): string {
	return blocks
		.filter((b) => b.type === "text" && typeof b.text === "string")
		.map((b) => b.text)
		.join("\n");
}

/** Single-line, whitespace-collapsed, length-capped. */
function flat(text: string, limit: number): string {
	const t = text.replace(/\s+/g, " ").trim();
	return t.length <= limit ? t : `${t.slice(0, limit)}...`;
}

function headTail(text: string, head: number, tail: number): string {
	const t = text.trim();
	if (t.length <= head + tail + 40) return flat(t, head + tail);
	return `${flat(t.slice(0, head), head)} [...] ${flat(t.slice(-tail), tail)}`;
}

// ---------- 1. ingestion pruner ----------

/** Head/tail-trim one oversized output at capture time (tail append: the
 *  prefix cache is never touched). Returns null when under threshold. */
function pruneAtIngestion(
	blocks: TextBlock[],
	cfg: { thresholdChars: number; headChars: number; tailChars: number },
): { blocks: TextBlock[]; originalText: string; removed: number } | null {
	const total = measure(blocks);
	if (total <= cfg.thresholdChars) return null;
	const text = blocksText(blocks);
	const removed = text.length - cfg.headChars - cfg.tailChars;
	if (removed <= 0) return null;
	const marker = `${PRUNE_MARKER_PREFIX}${removed} chars from the middle of this large output at capture time. The full output is preserved in the session transcript — search it with the recall tool.]\n`;
	const trimmed = text.slice(0, cfg.headChars) + marker + text.slice(-cfg.tailChars);
	const out: TextBlock[] = blocks.filter((b) => b.type !== "text");
	out.unshift({ type: "text", text: trimmed });
	return { blocks: out, originalText: text, removed };
}

// ---------- 2. recall (raw-transcript search) ----------

interface EntryLike {
	type?: string;
	customType?: string;
	data?: { toolCallId?: string; toolName?: string; text?: string };
	timestamp?: string | number;
	message?: {
		role?: string;
		toolName?: string;
		content?: unknown;
	};
}

/** Flatten one session entry into searchable text. */
function entryText(entry: EntryLike): string {
	if (entry.type === "custom" && entry.customType === PRUNED_STASH_TYPE) {
		return entry.data?.text ?? "";
	}
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

function entryLabel(entry: EntryLike): string | undefined {
	if (entry.type === "message") {
		const tool = entry.message?.toolName ? ` tool=${entry.message.toolName}` : "";
		return `${entry.message?.role ?? "?"}${tool}`;
	}
	if (entry.type === "custom" && entry.customType === PRUNED_STASH_TYPE) {
		return `full output (pruned at capture) tool=${entry.data?.toolName ?? "?"}`;
	}
	return undefined;
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
		const label = entryLabel(entry);
		if (!label) continue;
		const text = entryText(entry);
		const m = re.exec(text);
		if (!m) continue;
		total++;
		if (snippets.length >= maxResults) continue;
		const at = m.index;
		const from = Math.max(0, at - 250);
		const to = Math.min(text.length, at + 350);
		const snippet = `${from > 0 ? "..." : ""}${text.slice(from, to)}${to < text.length ? "..." : ""}`;
		const ts = entry.timestamp ? ` ${String(entry.timestamp)}` : "";
		snippets.push(`--- [#${i} ${label}${ts}] ---\n${snippet}`);
	}
	return { total, snippets };
}

// ---------- 3a. ARC-style deterministic digest ----------

/** One terse line per message; thinking dropped, tool results stubbed. */
function messageLine(m: Record<string, unknown>): string | undefined {
	const role = String(m.role ?? "");
	const blocks: TextBlock[] = Array.isArray(m.content)
		? (m.content as TextBlock[])
		: typeof m.content === "string"
			? [{ type: "text", text: m.content }]
			: [];
	const texts = blocksText(blocks);
	if (role === "user") return texts ? `[user] ${flat(texts, 400)}` : undefined;
	if (role === "assistant") {
		const parts: string[] = [];
		if (texts) parts.push(flat(texts, 280));
		for (const b of blocks as unknown as Array<Record<string, unknown>>) {
			if (b.type === "toolCall") {
				parts.push(`-> ${String(b.name ?? "?")}(${flat(JSON.stringify(b.arguments ?? {}), 140)})`);
			}
		}
		return parts.length ? `[assistant] ${parts.join(" ")}` : undefined;
	}
	if (role === "toolResult") {
		const name = String(m.toolName ?? "tool");
		const err = m.isError ? " ERROR" : "";
		return `[${name}${err}] ${headTail(texts, 180, 180)} (${texts.length} chars)`;
	}
	if (role === "bashExecution") return `[bash] ${flat(String(m.command ?? ""), 200)}`;
	if (texts) return `[${role}] ${flat(texts, 200)}`;
	return undefined;
}

const RECALL_FOOTER =
	"\n\n(Older context was compacted away. The full raw transcript is still searchable with the recall tool — use it before re-reading files or re-running commands to recover details like exact error text, earlier tool output, or prior decisions.)";

/** Deterministic compaction summary: no model call, no paraphrase loss.
 *  Budgeted; oldest lines drop first and the recall tool covers the rest. */
function arcDigest(all: Array<Record<string, unknown>>, previousSummary: string | undefined): string {
	const lines: string[] = [];
	for (const m of all) {
		const line = messageLine(m);
		if (line) lines.push(line);
	}
	let prev = "";
	if (previousSummary) {
		const cleaned = previousSummary.replace(RECALL_FOOTER, "").trim();
		const cap = Math.floor(ARC_DIGEST_BUDGET * 0.4);
		prev =
			cleaned.length <= cap
				? cleaned
				: `${cleaned.slice(0, cap)}\n... (older digest truncated — use the recall tool)`;
	}
	const remaining = Math.max(1000, ARC_DIGEST_BUDGET - prev.length);
	const kept: string[] = [];
	let used = 0;
	let omitted = 0;
	// Keep newest lines; once the budget is hit everything older is omitted.
	for (let i = lines.length - 1; i >= 0; i--) {
		if (used + lines[i].length + 1 > remaining) {
			omitted = i + 1;
			break;
		}
		kept.unshift(lines[i]);
		used += lines[i].length + 1;
	}
	const parts: string[] = [
		"Deterministic digest of the compacted history (exact contents of every step below are recoverable with the recall tool):",
	];
	if (prev) parts.push(`\n--- Carried forward from an earlier compaction ---\n${prev}`);
	parts.push("\n--- Action log ---");
	if (omitted > 0) parts.push(`... ${omitted} earlier steps omitted (searchable via recall)`);
	parts.push(kept.join("\n"));
	return parts.join("\n") + RECALL_FOOTER;
}

// ---------- 3b. LLM checkpoint instruction (dsh compaction-basic) ----------

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

export default function contextKeeper(pi: ExtensionAPI) {
	// -- 0. early + idle compaction --
	//
	// Fires on agent_settled, NOT turn_end: mid-run the next LLM request is
	// already in flight, and compact() aborts it. reserveTokens can't do
	// this natively: it is global, and a value tuned for a 262k local
	// window breaks smaller cloud models.
	let compactPending = false;
	let idleTimer: ReturnType<typeof setTimeout> | undefined;
	const clearIdleTimer = () => {
		if (idleTimer !== undefined) {
			clearTimeout(idleTimer);
			idleTimer = undefined;
		}
	};
	pi.on("session_compact", () => {
		compactPending = false;
	});
	pi.on("session_compact_failed", () => {
		compactPending = false;
	});
	pi.on("agent_start", async () => {
		clearIdleTimer();
	});
	pi.on("session_shutdown", async () => {
		clearIdleTimer();
	});
	pi.on("agent_settled", async (_event, ctx) => {
		const full = loadConfig(ctx.cwd);
		const at = full.context?.compactAtTokens;
		if (!at || at <= 0 || compactPending) return;
		const provider = (ctx.model as { provider?: string } | undefined)?.provider;
		const locals = full.rescue?.localProviders ?? DEFAULT_LOCAL_PROVIDERS;
		if (!provider || !locals.includes(provider)) return;
		const usage = ctx.getContextUsage();
		if (usage?.tokens == null) return;

		if (usage.tokens >= at) {
			compactPending = true;
			ctx.compact({
				onError: () => {
					compactPending = false;
				},
			});
			return;
		}

		// dsh compactNow(): even below the threshold, compact after N idle
		// minutes so the cost lands while nobody is waiting. Soft floor of
		// half the threshold avoids pointless tiny compactions.
		const idleMin = full.context?.idleCompactMinutes;
		if (!idleMin || idleMin <= 0 || usage.tokens < Math.max(10_000, Math.floor(at / 2))) return;
		clearIdleTimer();
		idleTimer = setTimeout(
			() => {
				idleTimer = undefined;
				if (compactPending) return;
				compactPending = true;
				ctx.compact({
					onError: () => {
						compactPending = false;
					},
				});
			},
			idleMin * 60_000,
		);
	});

	// -- 1. ingestion pruner: trim huge shell outputs once, at capture --
	pi.on("tool_result", async (event, ctx) => {
		if (event.toolName !== "bash" && event.toolName !== "powershell") return;
		const cfg = ctxCfg(ctx.cwd);
		if (cfg.pruner === false) return;
		const content = Array.isArray(event.content) ? (event.content as TextBlock[]) : [];
		const pruned = pruneAtIngestion(content, {
			thresholdChars: cfg.prunerThresholdChars ?? DEFAULTS.prunerThresholdChars,
			headChars: cfg.prunerHeadChars ?? DEFAULTS.prunerHeadChars,
			tailChars: cfg.prunerTailChars ?? DEFAULTS.prunerTailChars,
		});
		if (!pruned) return;
		// Stash the full output in the session (never sent to the LLM) so
		// the recall tool can search it later.
		pi.appendEntry(PRUNED_STASH_TYPE, {
			toolCallId: event.toolCallId,
			toolName: event.toolName,
			text: pruned.originalText,
		});
		return { content: pruned.blocks as never };
	});

	// -- 2. recall tool: agent-controlled search over the raw transcript --
	pi.registerTool({
		name: "recall",
		label: "Recall",
		description:
			"Search this session's FULL raw transcript — including history that was compacted away or trimmed from large tool outputs. Use it to recover exact error messages, earlier command output, file contents you already read, or decisions made earlier, instead of re-running commands or re-reading files. Regex or plain text; newest matches first.",
		promptSnippet: "Search the full session transcript (survives compaction) for forgotten details",
		promptGuidelines: [
			"After a context compaction, use recall to recover specifics the digest dropped (exact errors, paths, earlier outputs) before redoing work.",
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

	// -- 3. compaction: arc (deterministic) / checkpoint (LLM) / off --
	pi.on("session_before_compact", async (event, ctx) => {
		const cfg = ctxCfg(ctx.cwd);
		const mode = contextMode(cfg);
		if (mode === "off") return; // pi default compaction
		const started = Date.now();
		const { preparation, signal, reason } = event;
		const { messagesToSummarize, turnPrefixMessages, tokensBefore, firstKeptEntryId, previousSummary } = preparation;
		const all = [...messagesToSummarize, ...turnPrefixMessages];
		if (all.length === 0) return;

		const log = (
			outcome: "arc" | "custom" | "fallback_empty" | "fallback_error" | "fallback_not_smaller",
			summarizer: string,
			summaryChars: number,
			error?: string,
		) => {
			appendRecord(logDir(loadConfig(ctx.cwd)), {
				type: "compaction",
				cid: newCid(),
				ts: nowIso(),
				cwd: ctx.cwd,
				mainModel: mainModelId(ctx),
				reason,
				summarizer,
				tokensBefore,
				messagesSummarized: all.length,
				summaryChars,
				outcome,
				elapsedMs: Date.now() - started,
				...(error ? { error } : {}),
			});
		};

		// --- arc mode: deterministic, no model call, effectively instant ---
		if (mode === "arc") {
			const summary = arcDigest(all as unknown as Array<Record<string, unknown>>, previousSummary);
			log("arc", "deterministic", summary.length);
			return {
				compaction: {
					summary,
					firstKeptEntryId,
					tokensBefore,
				},
			};
		}

		// --- checkpoint mode: LLM-written structured checkpoint ---
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
				log("fallback_empty", summarizerName, 0);
				return; // pi default takes over
			}
			// Shrink guarantee (deepseek-harness): a checkpoint that is not
			// clearly smaller than what it replaces makes things worse.
			const spanChars = JSON.stringify(llmMessages).length;
			if (summary.length >= spanChars * 0.5) {
				log("fallback_not_smaller", summarizerName, summary.length);
				return;
			}

			log("custom", summarizerName, summary.length);
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
				log("fallback_error", summarizerName, 0, message);
				ctx.ui.notify(`Checkpoint compaction failed (${message}); using pi default`, "warning");
			}
			return; // pi default takes over
		} finally {
			clearInterval(ticker);
			ctx.ui.setStatus("context-keeper", `last compaction ${fmtElapsed()}`);
		}
	});
}
