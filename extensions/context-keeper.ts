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
//     needle recovery.) Exact regex match is primary (Codex's history
//     search is a literal substring; exact match is right for error
//     strings/paths); a BM25 fallback ranks by keyword relevance when the
//     exact query misses — paraphrase tolerance for a local model that is
//     weak at query reformulation. `entry` reads one entry back in FULL
//     (Codex history.read_item): a snippet tells you where, a read gives
//     you the bytes, and re-derivation is the cost compression papers warn
//     about (2608.16370).
//
//  3. NOTE TOOL (model-written durable state) — Codex's notes insight: the
//     machine cannot know which fact is load-bearing; let the MODEL pin
//     short facts that must survive compaction VERBATIM. Notes are stored
//     as session entries and re-pinned word-for-word into every compaction
//     digest (budget-capped, newest win). A pre-compaction reminder tells
//     the model the cut is coming (Codex's token-budget reminder) so it can
//     pin state before older history is folded away.
//
//  4. COMPACTION MODES
//     - "arc" (default): deterministic digest — pinned notes, terse action
//       lines, tool results as head/tail stubs, thinking dropped, no model
//       call. Zero latency and no paraphrase loss; recall recovers exact
//       content.
//     - "checkpoint": LLM-written structured checkpoint (dsh
//       compaction-basic), prefix-cache-aligned with a shrink guarantee;
//       pinned notes are appended verbatim after the checkpoint.
//     - "off": pi default compaction (notes are not pinned).
//
// Division of responsibility: the MACHINE decides what leaves the window
// (deterministic digest), the MODEL decides what survives verbatim (notes),
// everything else is recoverable on demand (recall: exact -> BM25 -> full
// read-back), and the model sees the budget coming (reminder).
//
// Config: `context` block in geocine.json — see geocine.example.json.

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { convertToLlm } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { type ContextConfig, contextManaged, loadConfig, logDir } from "../lib/config.ts";
import { appendRecord, newCid, nowIso } from "../lib/consult-log.ts";
import { judge, modelBaseUrl, noulOf, scoreOf } from "../lib/judge/index.ts";

const PRUNED_STASH_TYPE = "geocine-pruned";
const NOTE_TYPE = "geocine-note";
const PRUNE_MARKER_PREFIX = "\n[geocine-pi: trimmed ";
const ARC_DIGEST_BUDGET = 10_000; // chars; ~2.5k tokens — always far smaller than the span
const NOTES_BUDGET = 4000; // chars of pinned notes per digest; newest win
const NOTE_MAX_CHARS = 1000; // per note; notes are facts, not essays
const READ_CHUNK_CHARS = 10_000; // recall entry read-back page size
const DEFAULTS = {
	maxTokens: 4096,
	prunerThresholdChars: 6000,
	prunerHeadChars: 1500,
	prunerTailChars: 1500,
	reminderTokens: 8000, // pre-compaction reminder lead
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

/** Whether context-keeper machinery applies to the active model. Registry
 *  first: a model in the `models` collection opts in via its "local" class;
 *  unregistered models fall back to context.providers. Everything else gets
 *  pi's built-in behavior untouched (see contextManaged in lib/config). */
function keeperApplies(ctx: ExtensionContext): boolean {
	return contextManaged(ctx.model, loadConfig(ctx.cwd));
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

// BM25 fallback: when the exact query misses, rank entries by keyword
// relevance instead of returning nothing. Exact match stays primary (it is
// deterministic and right for error strings/paths — Codex's history search
// is literal-substring only); BM25 covers paraphrased queries ("what did we
// decide about X") where no literal token survives.
function tokenize(text: string): string[] {
	return text
		.toLowerCase()
		.split(/[^a-z0-9_./-]+/)
		.filter((t) => t.length >= 2 && t.length <= 60);
}

function bm25Search(entries: EntryLike[], query: string, maxResults: number): string[] {
	const qTerms = [...new Set(tokenize(query))];
	if (qTerms.length === 0) return [];
	interface Doc {
		i: number;
		label: string;
		ts: string;
		text: string;
		tf: Map<string, number>;
		len: number;
	}
	const docs: Doc[] = [];
	for (let i = 0; i < entries.length; i++) {
		const label = entryLabel(entries[i]);
		if (!label) continue;
		const text = entryText(entries[i]);
		if (!text) continue;
		const terms = tokenize(text);
		const tf = new Map<string, number>();
		for (const t of terms) tf.set(t, (tf.get(t) ?? 0) + 1);
		docs.push({ i, label, ts: entries[i].timestamp ? ` ${String(entries[i].timestamp)}` : "", text, tf, len: terms.length });
	}
	if (docs.length === 0) return [];
	const avgLen = docs.reduce((s, d) => s + d.len, 0) / docs.length || 1;
	const idf = new Map<string, number>();
	for (const term of qTerms) {
		let df = 0;
		for (const d of docs) if (d.tf.has(term)) df++;
		idf.set(term, Math.log(1 + (docs.length - df + 0.5) / (df + 0.5)));
	}
	const k1 = 1.2;
	const b = 0.75;
	const scored = docs
		.map((d) => {
			let score = 0;
			for (const term of qTerms) {
				const tf = d.tf.get(term) ?? 0;
				if (tf === 0) continue;
				score += (idf.get(term) ?? 0) * ((tf * (k1 + 1)) / (tf + k1 * (1 - b + (b * d.len) / avgLen)));
			}
			return { d, score };
		})
		.filter((s) => s.score > 0)
		.sort((a, b2) => b2.score - a.score)
		.slice(0, maxResults);

	return scored.map(({ d }) => {
		// Snippet around the rarest matching query term.
		const present = qTerms.filter((t) => d.tf.has(t)).sort((a, b2) => (idf.get(b2) ?? 0) - (idf.get(a) ?? 0));
		const at = present.length > 0 ? Math.max(0, d.text.toLowerCase().indexOf(present[0])) : 0;
		const from = Math.max(0, at - 250);
		const to = Math.min(d.text.length, at + 350);
		const snippet = `${from > 0 ? "..." : ""}${d.text.slice(from, to)}${to < d.text.length ? "..." : ""}`;
		return `--- [#${d.i} ${d.label}${d.ts}] ---\n${snippet}`;
	});
}

// Fabric node "recall": rerank BM25 fallback results before the model sees
// them. Exact-regex matches are literal hits and never reranked; fuzzy
// keyword candidates can be junk a weak model will happily chase. One judge
// call scores every snippet in parallel (one noul per result); only
// confidently-irrelevant ones are dropped — uncertainty keeps the result.
// No judge, timeout, or rate cap = pass-through.
const RERANK_DROP_P = 0.35;

async function rerankResults(
	cwd: string,
	query: string,
	ranked: string[],
	workerBaseUrl: string | undefined,
): Promise<{ kept: string[]; dropped: number }> {
	const full = loadConfig(cwd);
	if (full.context?.rerank === false || ranked.length < 2) return { kept: ranked, dropped: 0 };
	const questions: Record<string, { type: "noul"; instructions: string; criteria: { true: string; false: string } }> = {};
	for (let i = 0; i < ranked.length; i++) {
		questions[`r${i}`] = {
			type: "noul",
			instructions: `Does search result r${i} contain information relevant to the query "${query.slice(0, 200)}"? The results are fuzzy keyword matches from a coding-session transcript; judge whether this one would actually help answer the query.`,
			criteria: {
				true: "Relevant: addresses the query's subject or contains the sought detail",
				false: "Irrelevant: only shares incidental keywords with the query",
			},
		};
	}
	const result = await judge(
		full.judge,
		{
			state: {
				query: query.slice(0, 300),
				results: Object.fromEntries(ranked.map((r, i) => [`r${i}`, r.slice(0, 400)])),
			},
			questions,
		},
		{ node: "recall", timeoutMs: 2500, workerBaseUrl },
	);
	if (!result) return { kept: ranked, dropped: 0 };
	const kept = ranked.filter((_, i) => {
		const p = noulOf(result, `r${i}`);
		return p === undefined || p > RERANK_DROP_P;
	});
	// Never filter down to nothing: a wrong empty answer is worse than junk.
	if (kept.length === 0) return { kept: ranked, dropped: 0 };
	return { kept, dropped: ranked.length - kept.length };
}

// ---------- pinned notes ----------

/** All note texts in session order (oldest first). */
function collectNotes(entries: EntryLike[]): string[] {
	const notes: string[] = [];
	for (const entry of entries) {
		if (entry.type === "custom" && entry.customType === NOTE_TYPE && typeof entry.data?.text === "string") {
			notes.push(entry.data.text);
		}
	}
	return notes;
}

/** Render notes verbatim under a budget; newest win, oldest drop first. */
function renderPinnedNotes(notes: string[]): string {
	if (notes.length === 0) return "";
	const kept: string[] = [];
	let used = 0;
	let omitted = 0;
	for (let i = notes.length - 1; i >= 0; i--) {
		const line = `- ${notes[i].replace(/\s+/g, " ").trim()}`;
		if (used + line.length + 1 > NOTES_BUDGET) {
			omitted = i + 1;
			break;
		}
		kept.unshift(line);
		used += line.length + 1;
	}
	const parts = ["--- Pinned notes (model-written; kept verbatim across compactions) ---"];
	if (omitted > 0) parts.push(`... ${omitted} older notes omitted (searchable via recall)`);
	parts.push(kept.join("\n"));
	return parts.join("\n");
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

/** Digest line paired with its source message, for judge-directed expansion. */
interface DigestPair {
	line: string;
	msg: Record<string, unknown>;
}

function digestPairs(all: Array<Record<string, unknown>>): DigestPair[] {
	const pairs: DigestPair[] = [];
	for (const m of all) {
		const line = messageLine(m);
		if (line) pairs.push({ line, msg: m });
	}
	return pairs;
}

/** Verbatim expansion of one step ("store"): same line shape, much larger
 *  excerpt — used when the judge says the exact contents are still needed. */
function expandedLine(m: Record<string, unknown>): string | undefined {
	const role = String(m.role ?? "");
	const blocks: TextBlock[] = Array.isArray(m.content)
		? (m.content as TextBlock[])
		: typeof m.content === "string"
			? [{ type: "text", text: m.content }]
			: [];
	const texts = blocksText(blocks);
	if (role === "toolResult") {
		const name = String(m.toolName ?? "tool");
		const err = m.isError ? " ERROR" : "";
		return `[${name}${err} — kept verbatim] ${headTail(texts, 450, 450)}`;
	}
	if (role === "bashExecution") return `[bash] ${flat(String(m.command ?? ""), 400)}`;
	if (texts) return `[${role} — kept verbatim] ${flat(texts, 800)}`;
	return undefined;
}

// Judge-scored digest (fabric node "compact"): classifier-decided
// compaction under pi's constraint that compaction returns one summary text.
// Instead of dropping digest steps oldest-first, one classifier call scores
// every non-user step 0/1/2 — drop (no longer needed; recall recovers it),
// keep the one-liner, or EXPAND to a verbatim excerpt (the exact error/value
// is still load-bearing). The judge sees the WHOLE digest state, not
// isolated units — scoring units independently is how hard compressors
// split dependency pairs (referential dangling, arXiv:2608.04569); user
// lines are never candidates (they define the task), and everything dropped
// stays recoverable via recall, which is the restoration path the dangling
// paper had to bolt on. Drops additionally require a CALIBRATED tier
// (naive-llm may expand, never delete). No judge / timeout / rate cap =
// untouched lines.
const DIGEST_JUDGE_MAX = 36; // newest candidates scored; older fall to the budget as before
const DIGEST_DROP_CONFIDENCE = 0.6;

async function judgeDigestLines(
	cwd: string,
	pairs: DigestPair[],
	signal: AbortSignal | undefined,
	workerBaseUrl: string | undefined,
): Promise<{ lines: string[]; dropped: number; expanded: number } | undefined> {
	const full = loadConfig(cwd);
	if (full.context?.judgeDigest === false) return undefined;
	const candidates: number[] = [];
	for (let i = 0; i < pairs.length; i++) {
		if (!pairs[i].line.startsWith("[user]")) candidates.push(i);
	}
	const scored = candidates.slice(-DIGEST_JUDGE_MAX);
	if (scored.length < 6) return undefined; // not worth a call

	const questions: Record<string, { type: "score"; instructions: string; criteria: string[] }> = {};
	for (const i of scored) {
		questions[`s${i}`] = {
			type: "score",
			instructions: `Step ${i} of the digest: is it still needed for the remaining work?`,
			criteria: [
				"no longer needed — a completed detour, superseded attempt, or noise; safe to drop (the recall tool recovers it)",
				"keep as this one-line step — knowing it happened still matters",
				"exact contents still needed — expand to a verbatim excerpt (error text, value, path, or output the work still depends on)",
			],
		};
	}
	const result = await judge(
		full.judge,
		{
			state: {
				task: "This is a compaction digest of a coding session, one numbered step per line. Steps marked [user] define the task and are always kept.",
				steps: pairs.map((p, i) => `${i}: ${p.line.slice(0, 220)}`).join("\n"),
			},
			questions,
		},
		{ node: "compact", timeoutMs: 6000, signal, workerBaseUrl },
	);
	if (!result) return undefined;

	// Drops remove content the deterministic digest would have KEPT, so they
	// need calibrated probabilities — the naive-llm tier's self-reported
	// confidence may expand (verbatim add, harmless) but never delete.
	const canDrop = result.calibrated === true;
	let dropped = 0;
	let expanded = 0;
	const lines: string[] = [];
	for (let i = 0; i < pairs.length; i++) {
		const answer = scoreOf(result, `s${i}`);
		if (!answer) {
			lines.push(pairs[i].line);
			continue;
		}
		if (canDrop && answer.score <= 0.5 && answer.confidence >= DIGEST_DROP_CONFIDENCE) {
			dropped++;
			continue;
		}
		if (answer.score >= 1.5) {
			const big = expandedLine(pairs[i].msg);
			lines.push(big ?? pairs[i].line);
			if (big) expanded++;
			continue;
		}
		lines.push(pairs[i].line);
	}
	return { lines, dropped, expanded };
}

// Judge-gated note expiry (fabric node "notes"): pinned notes are verbatim
// and newest-win under a char budget — blind recency can evict a constraint
// that still binds while keeping a stale one. When notes overflow, one
// classifier call marks confidently-obsolete notes ("merge/remove": the
// classifier cannot rewrite two notes into one, but it can drop the one the
// newer note supersedes). Uncertainty keeps the note; no judge = newest-win.
async function judgeExpireNotes(
	cwd: string,
	goal: string,
	notes: string[],
	signal: AbortSignal | undefined,
	workerBaseUrl: string | undefined,
): Promise<string[]> {
	const full = loadConfig(cwd);
	if (full.context?.judgeDigest === false) return notes;
	const totalChars = notes.reduce((s, n) => s + n.length, 0);
	if (notes.length < 6 || totalChars <= NOTES_BUDGET) return notes;
	const questions: Record<string, { type: "noul"; instructions: string; criteria: { true: string; false: string } }> = {};
	for (let i = 0; i < notes.length; i++) {
		questions[`n${i}`] = {
			type: "noul",
			instructions: `Is note n${i} still load-bearing for the ongoing work?`,
			criteria: {
				true: "Still binds: a live constraint, decision, value, or gotcha",
				false: "Obsolete: superseded by a newer note or about finished work",
			},
		};
	}
	const result = await judge(
		full.judge,
		{
			state: {
				goal: goal.slice(0, 600),
				notes: notes.map((n, i) => `n${i} (${i === notes.length - 1 ? "newest" : `age ${notes.length - 1 - i}`}): ${n.slice(0, 300)}`).join("\n"),
			},
			questions,
		},
		{ node: "notes", timeoutMs: 4000, signal, workerBaseUrl },
	);
	if (!result) return notes;
	const kept = notes.filter((_, i) => {
		const p = noulOf(result, `n${i}`);
		return p === undefined || p > 0.35;
	});
	// Never expire everything; the newest note always survives.
	return kept.length > 0 ? kept : notes.slice(-1);
}

/** Deterministic compaction summary: no model call, no paraphrase loss.
 *  Pinned notes survive verbatim; action lines are budgeted (oldest drop
 *  first) and the recall tool covers everything omitted. */
function arcDigest(
	lines: string[],
	previousSummary: string | undefined,
	notes: string[],
	judgeNote?: string,
): string {
	const pinned = renderPinnedNotes(notes);
	let prev = "";
	if (previousSummary) {
		// Strip the footer and the previous pinned-notes section: notes are
		// re-collected from the session every compaction, so carrying the old
		// section forward would duplicate them.
		const cleaned = previousSummary
			.replace(RECALL_FOOTER, "")
			.replace(/--- Pinned notes[\s\S]*?(?=\n--- |$)/, "")
			.trim();
		const cap = Math.floor(ARC_DIGEST_BUDGET * 0.4);
		prev =
			cleaned.length <= cap
				? cleaned
				: `${cleaned.slice(0, cap)}\n... (older digest truncated — use the recall tool)`;
	}
	const remaining = Math.max(1000, ARC_DIGEST_BUDGET - prev.length - pinned.length);
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
	if (pinned) parts.push(`\n${pinned}`);
	if (prev) parts.push(`\n--- Carried forward from an earlier compaction ---\n${prev}`);
	parts.push("\n--- Action log ---");
	if (judgeNote) parts.push(judgeNote);
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
	let reminderSent = false;
	let idleTimer: ReturnType<typeof setTimeout> | undefined;
	const clearIdleTimer = () => {
		if (idleTimer !== undefined) {
			clearTimeout(idleTimer);
			idleTimer = undefined;
		}
	};
	pi.on("session_compact", () => {
		compactPending = false;
		reminderSent = false; // re-arm for the next compaction cycle
	});
	pi.on("session_compact_failed", () => {
		compactPending = false;
		reminderSent = false;
	});

	// Pre-compaction reminder (Codex's token-budget reminder in pi terms):
	// once per compaction cycle, when the context is within reminderTokens of
	// the early threshold, tell the model the cut is coming so it can pin
	// load-bearing facts with `note` BEFORE older history folds into the
	// digest. Fires on turn_end so long tool loops get it mid-run; injecting
	// a message is a tail append, so the provider prefix cache is untouched.
	pi.on("turn_end", async (_event, ctx) => {
		const full = loadConfig(ctx.cwd);
		const cfg = full.context ?? {};
		const at = cfg.compactAtTokens;
		if (!at || at <= 0 || reminderSent || cfg.notes === false) return;
		const lead = cfg.reminderTokens ?? DEFAULTS.reminderTokens;
		if (lead <= 0) return;
		if (!keeperApplies(ctx)) return;
		const usage = ctx.getContextUsage();
		if (usage?.tokens == null || usage.tokens < at - lead) return;
		reminderSent = true;
		const remaining = Math.max(0, at - usage.tokens);
		pi.sendMessage(
			{
				customType: "context-keeper-reminder",
				content:
					`[context-keeper] This context window is approaching compaction (~${remaining} tokens before older history is folded into a digest). ` +
					"If any decisions, constraints, exact values, paths, or in-progress state must survive VERBATIM, record each one now with the note tool (one short note per fact). " +
					"Recent turns are kept as-is; everything older stays searchable with recall.",
				display: false,
			},
			{ deliverAs: "steer" },
		);
	});

	// -- task-start memory gate (fabric node "memory") --
	//
	// Zero-Mem's regime (arXiv:2607.29377) applied at task start: once a
	// compaction or pruning has happened, details a NEW task depends on may
	// live only in the raw transcript — and a cheap worker will re-read files
	// or re-run commands to rediscover them. Deterministic retrieval (BM25,
	// query = the task text) proposes candidates; one judge call scores
	// relevance; only confidently-relevant snippets are steered in, hard-
	// capped. The bar is the inverse of recall rerank: rerank drops only
	// confident junk (the model asked for those results), the gate injects
	// only confident hits (the model asked for nothing). No judge = inject
	// nothing — a wrong injection costs context tokens on every turn after.
	const MEMORY_INJECT_P = 0.75;
	const MEMORY_MAX_SNIPPETS = 2;
	const injectedMemory = new Set<string>(); // entry ids already steered in; never repeat
	pi.on("input", async (event, ctx) => {
		const text = typeof (event as { text?: unknown }).text === "string" ? (event as { text: string }).text : "";
		if (!text || text.startsWith("/") || text.length < 24) return;
		const full = loadConfig(ctx.cwd);
		const cfg = full.context ?? {};
		if (cfg.memory === false || !keeperApplies(ctx)) return;
		const entries = ctx.sessionManager.getEntries() as EntryLike[];
		const compacted = entries.some(
			(e) =>
				(e.type === "message" && (e.message as { role?: string } | undefined)?.role === "compactionSummary") ||
				(e.type === "custom" && e.customType === PRUNED_STASH_TYPE),
		);
		if (!compacted) return; // everything is still in context

		// Fire and forget: the hits land as a steer while turn 1 runs.
		void (async () => {
			const ranked = bm25Search(entries, text, 5).filter((r) => {
				const id = /#\d+/.exec(r)?.[0];
				return !id || !injectedMemory.has(id);
			});
			if (ranked.length === 0) return;
			const questions: Record<string, { type: "noul"; instructions: string; criteria: { true: string; false: string } }> = {};
			for (let i = 0; i < ranked.length; i++) {
				questions[`m${i}`] = {
					type: "noul",
					instructions: `Result m${i} was retrieved from this coding session's compacted history because it shares keywords with the NEW task. Would its contents materially help someone starting that task — a prior decision, an exact value, an error already diagnosed, work already done?`,
					criteria: {
						true: "Materially helps: the new task builds on or repeats this",
						false: "Coincidental keyword overlap; the new task does not need it",
					},
				};
			}
			const result = await judge(
				full.judge,
				{
					state: {
						new_task: text.slice(0, 500),
						results: Object.fromEntries(ranked.map((r, i) => [`m${i}`, r.slice(0, 450)])),
					},
					questions,
				},
				{ node: "memory", timeoutMs: 3000, workerBaseUrl: modelBaseUrl(ctx.model) },
			);
			// Injection mutates what the worker reads for the rest of the
			// session — a wrong snippet is a false premise it cannot detect.
			// Only calibrated probabilities may authorize it; the naive-llm
			// tier's self-reported 0.85 must never put words in the context.
			if (!result?.calibrated) return;
			const hits = ranked
				.map((r, i) => ({ r, p: noulOf(result, `m${i}`) }))
				.filter((h): h is { r: string; p: number } => h.p !== undefined && h.p >= MEMORY_INJECT_P)
				.sort((a, b) => b.p - a.p)
				.slice(0, MEMORY_MAX_SNIPPETS);
			if (hits.length === 0) return;
			for (const h of hits) {
				const id = /#\d+/.exec(h.r)?.[0];
				if (id) injectedMemory.add(id);
			}
			try {
				pi.sendMessage(
					{
						customType: "context-keeper-memory",
						content:
							"[memory] Earlier work in this session (compacted out of context) looks relevant to this task — verify with the recall tool before relying on it:\n\n" +
							hits.map((h) => h.r.slice(0, 500)).join("\n\n"),
						display: false,
					},
					{ deliverAs: "steer" },
				);
				ctx.ui.setStatus("context-keeper", `memory: ${hits.length} snippet${hits.length > 1 ? "s" : ""} recalled`);
			} catch {
				// steer window closed; the next turn can still use recall
			}
		})();
	});

	// -- note tool: model-written durable state, pinned into every digest --
	pi.registerTool({
		name: "note",
		label: "Note",
		description:
			"Record ONE short durable fact that must survive context compaction VERBATIM: a decision and its reason, a user constraint, an exact value/path/command, or a gotcha discovered the hard way. Notes are pinned word-for-word into every future compaction digest (newest win under a budget), so keep each note to 1-3 sentences. Do NOT note things that are easy to rediscover (file contents, command output) — those stay searchable with the recall tool.",
		promptSnippet: "Pin one short fact so it survives context compaction verbatim",
		promptGuidelines: [
			"Write a note the moment a decision, constraint, or hard-won discovery is made — do not wait for the pre-compaction reminder.",
		],
		parameters: Type.Object({
			text: Type.String({ description: "The fact to pin, 1-3 sentences. Include exact values/paths, not references to the conversation." }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const cfg = ctxCfg(ctx.cwd);
			if (cfg.notes === false) {
				return { content: [{ type: "text", text: "notes are disabled in geocine.json (context.notes)." }], details: {} };
			}
			let text = params.text.trim();
			if (!text) {
				return { content: [{ type: "text", text: "Empty note ignored." }], details: {} };
			}
			if (text.length > NOTE_MAX_CHARS) text = `${text.slice(0, NOTE_MAX_CHARS)}...`;
			pi.appendEntry(NOTE_TYPE, { text });
			const all = collectNotes(ctx.sessionManager.getEntries() as EntryLike[]);
			const used = all.reduce((s, n) => s + n.length + 3, 0);
			return {
				content: [
					{
						type: "text",
						text: `Noted — will be pinned verbatim into future compaction digests. ${all.length} note(s), ~${used}/${NOTES_BUDGET} chars pinned (oldest drop first past the budget).`,
					},
				],
				details: { count: all.length },
			};
		},
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
		if (!keeperApplies(ctx)) return;
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
		if (!keeperApplies(ctx)) return;
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
			"Search this session's FULL raw transcript — including history that was compacted away or trimmed from large tool outputs. Use it to recover exact error messages, earlier command output, file contents you already read, or decisions made earlier, instead of re-running commands or re-reading files. Regex or plain text; newest matches first; if the exact query misses, the closest entries by keyword relevance are returned instead. Results are labeled [#N ...] — pass `entry: N` to read that entry IN FULL (paged with offsetChars) when a snippet is not enough, e.g. to retrieve the trimmed middle of a large output.",
		promptSnippet: "Search the full session transcript (survives compaction); read any [#N] entry back in full",
		promptGuidelines: [
			"After a context compaction, use recall to recover specifics the digest dropped (exact errors, paths, earlier outputs) before redoing work.",
			"When a recall snippet is not enough, read the whole entry with recall's `entry` parameter instead of re-running the command.",
		],
		parameters: Type.Object({
			query: Type.String({
				description: "Regex (case-insensitive) or literal text to find, e.g. 'ENOENT|permission denied' or a function name. Ignored when `entry` is set.",
			}),
			maxResults: Type.Optional(Type.Number({ description: "Max snippets to return. Default 5." })),
			entry: Type.Optional(
				Type.Number({ description: "Read entry [#N] from earlier results in full instead of searching." }),
			),
			offsetChars: Type.Optional(
				Type.Number({ description: "With `entry`: zero-based char offset to continue a long read. Default 0." }),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const cfg = ctxCfg(ctx.cwd);
			if (cfg.recall === false) {
				return { content: [{ type: "text", text: "recall is disabled in geocine.json (context.recall)." }], details: {} };
			}
			const entries = ctx.sessionManager.getEntries() as EntryLike[];

			// Full entry read-back (Codex history.read_item): snippets locate,
			// reads retrieve — cheaper than re-running the command.
			if (params.entry !== undefined) {
				const idx = Math.trunc(params.entry);
				const entry = entries[idx];
				const label = entry ? entryLabel(entry) : undefined;
				if (!entry || !label) {
					return {
						content: [{ type: "text", text: `No readable transcript entry #${idx}. Use a recall search first; results are labeled [#N ...].` }],
						details: {},
					};
				}
				const text = entryText(entry);
				const off = Math.max(0, Math.trunc(params.offsetChars ?? 0));
				const slice = text.slice(off, off + READ_CHUNK_CHARS);
				const more = off + slice.length < text.length;
				return {
					content: [
						{
							type: "text",
							text:
								`[#${idx} ${label}] chars ${off}-${off + slice.length} of ${text.length}:\n${slice}` +
								(more ? `\n\n(more — call recall again with entry: ${idx}, offsetChars: ${off + slice.length})` : ""),
						},
					],
					details: { entry: idx, totalChars: text.length },
				};
			}

			const max = Math.min(Math.max(1, params.maxResults ?? 5), 20);
			const { total, snippets } = searchTranscript(entries, params.query, max);
			let text: string;
			if (total > 0) {
				text = `${total} match(es) in the raw transcript (showing ${snippets.length}, newest first):\n\n${snippets.join("\n\n")}`;
			} else {
				// Exact query missed: fall back to BM25 keyword relevance so a
				// paraphrased query still lands near the right entries, then
				// let the judge drop confidently-irrelevant candidates.
				const ranked = bm25Search(entries, params.query, max);
				const { kept, dropped } = await rerankResults(ctx.cwd, params.query, ranked, modelBaseUrl(ctx.model));
				const droppedNote = dropped > 0 ? ` ${dropped} low-relevance candidate(s) filtered.` : "";
				text =
					kept.length === 0
						? `No transcript matches for: ${params.query}`
						: `No exact matches for "${params.query}". Closest ${kept.length} entries by keyword relevance (not exact hits — verify before relying on them).${droppedNote}\n\n${kept.join("\n\n")}`;
			}
			return { content: [{ type: "text", text: text.slice(0, 12_000) }], details: { total } };
		},
	});

	// -- 3. compaction: arc (deterministic) / checkpoint (LLM) / off --
	pi.on("session_before_compact", async (event, ctx) => {
		const cfg = ctxCfg(ctx.cwd);
		const mode = contextMode(cfg);
		if (mode === "off") return; // pi default compaction
		// Models outside context.providers always get pi's built-in
		// compaction — the digest override is a local-server optimization,
		// not a global replacement.
		if (!keeperApplies(ctx)) return;
		const started = Date.now();
		const { preparation, signal, reason } = event;
		const { messagesToSummarize, turnPrefixMessages, tokensBefore, firstKeptEntryId, previousSummary } = preparation;
		const all = [...messagesToSummarize, ...turnPrefixMessages];
		if (all.length === 0) return;
		const pairs = digestPairs(all as unknown as Array<Record<string, unknown>>);
		const goal = [...pairs].reverse().find((p) => p.line.startsWith("[user]"))?.line.slice(7, 607) ?? "";
		let notes = cfg.notes === false ? [] : collectNotes(ctx.sessionManager.getEntries() as EntryLike[]);
		notes = await judgeExpireNotes(ctx.cwd, goal, notes, signal, modelBaseUrl(ctx.model));

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
				notesPinned: notes.length,
				outcome,
				elapsedMs: Date.now() - started,
				...(error ? { error } : {}),
			});
		};

		// --- arc mode: deterministic skeleton, judge-scored content ---
		// The classifier (when configured) decides drop/keep/expand per step;
		// without it the digest is exactly the deterministic newest-first cut.
		if (mode === "arc") {
			const judged = await judgeDigestLines(ctx.cwd, pairs, signal, modelBaseUrl(ctx.model));
			const lines = judged?.lines ?? pairs.map((p) => p.line);
			const judgeNote = judged
				? `(classifier-scored: ${judged.dropped} stale steps dropped — recall recovers them — ${judged.expanded} kept verbatim)`
				: undefined;
			const summary = arcDigest(lines, previousSummary, notes, judgeNote);
			log("arc", judged ? "deterministic+judge" : "deterministic", summary.length);
			return {
				compaction: {
					summary,
					firstKeptEntryId,
					tokensBefore,
				},
			};
		}

		// --- checkpoint mode: LLM-written structured checkpoint ---
		// Summarizer: a named registry entry's model, or the session's own model
		// (which keeps the call on the warm KV cache of a local server).
		let model = ctx.model;
		let summarizerName = mainModelId(ctx) ?? "main";
		if (cfg.summarizer) {
			const entry = loadConfig(ctx.cwd).models[cfg.summarizer];
			const found = entry?.provider ? ctx.modelRegistry.find(entry.provider, entry.model) : undefined;
			if (found) {
				model = found;
				summarizerName = `${entry.provider}/${entry.model}`;
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
			// Pinned notes ride along verbatim: the LLM checkpoint may
			// paraphrase, but notes are exactly what the model asked to keep.
			const pinned = renderPinnedNotes(notes);
			return {
				compaction: {
					summary: summary + (pinned ? `\n\n${pinned}` : "") + RECALL_FOOTER,
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
