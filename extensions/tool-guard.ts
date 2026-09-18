// tool-guard: the fabric's call-level "wasteful?" node.
//
// The watchdog catches thrashing at TURN granularity; weak local models
// waste most tokens at CALL granularity — re-reading a file already in
// context, retrying an identical call that just failed, repeating a call
// whose output cannot have changed. A deterministic prefilter tracks
// exact-call repeats, per-file read counts, and identical retries after
// failure, so the hot path pays nothing and only suspects reach the judge.
// The judge then decides with the task and recent calls in view: redundant
// thrash is blocked with a corrective reason the model reads (use recall,
// change the approach, say what NEW information the call would produce);
// legitimate repeats — re-reading after an edit, re-running a build after a
// fix — are allowed through.
//
// Cheap workers only (rescue.localProviders — local or budget cloud; the
// worker is whatever pi's model picker has active): a frontier main model
// is trusted with its own calls. Degradation: no judge, timeout, or rate cap
// = allow. Blocks are capped per task and cooled down between hits so the
// guard corrects, never nags. Every judged call is a tool_guard record.

import { createHash } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isLocalWorker, loadConfig, logDir } from "../lib/config.ts";
import { appendRecord, newCid, nowIso } from "../lib/consult-log.ts";
import { judge, modelBaseUrl, noulOf, resolveJudge } from "../lib/judge/index.ts";

const RING_MAX = 30;
const COOLDOWN_CALLS = 4;
const READ_TOOLS = ["read", "grep", "find", "ls"];

interface CallEntry {
	key: string;
	preview: string;
	isError: boolean;
}

function callKey(toolName: string, input: unknown): string {
	const hash = createHash("sha1");
	hash.update(toolName);
	hash.update(JSON.stringify(input ?? {}));
	return hash.digest("hex").slice(0, 16);
}

function callPreview(toolName: string, input: unknown): string {
	const args = (input ?? {}) as Record<string, unknown>;
	if (typeof args.command === "string") return `${toolName}: ${args.command}`.slice(0, 100);
	const p = args.path ?? args.file_path;
	if (typeof p === "string") return `${toolName} ${p}`.slice(0, 100);
	return `${toolName} ${JSON.stringify(args)}`.slice(0, 100);
}

export default function toolGuard(pi: ExtensionAPI) {
	let task = "";
	let ring: CallEntry[] = [];
	let callCounts = new Map<string, number>();
	let failedKeys = new Set<string>();
	let readCounts = new Map<string, number>();
	let blocksThisTask = 0;
	let callsSinceBlock = COOLDOWN_CALLS;

	const reset = () => {
		ring = [];
		callCounts = new Map();
		failedKeys = new Set();
		readCounts = new Map();
		blocksThisTask = 0;
		callsSinceBlock = COOLDOWN_CALLS;
	};

	pi.on("session_start", async () => reset());

	pi.on("input", async (event) => {
		const text = typeof (event as { text?: unknown }).text === "string" ? (event as { text: string }).text : "";
		if (text && !text.startsWith("/")) {
			task = text;
			reset(); // new task = fresh signals
		}
	});

	pi.on("tool_result", async (event) => {
		const key = callKey(event.toolName, event.input);
		callCounts.set(key, (callCounts.get(key) ?? 0) + 1);
		if (event.isError) failedKeys.add(key);
		if (READ_TOOLS.includes(event.toolName)) {
			const p = ((event.input ?? {}) as Record<string, unknown>).path;
			if (typeof p === "string") {
				const norm = p.replace(/\\/g, "/").toLowerCase();
				readCounts.set(norm, (readCounts.get(norm) ?? 0) + 1);
			}
		}
		ring.push({ key, preview: callPreview(event.toolName, event.input), isError: Boolean(event.isError) });
		if (ring.length > RING_MAX) ring.shift();
	});

	pi.on("tool_call", async (event, ctx) => {
		callsSinceBlock++;
		const cfg = loadConfig(ctx.cwd);
		if (cfg.toolGuard?.enabled === false) return;
		if (!isLocalWorker(ctx.model, cfg)) return; // frontier workers are trusted
		if (!resolveJudge(cfg.judge)) return; // degrade: no judge, no blocks
		if (blocksThisTask >= (cfg.toolGuard?.maxBlocksPerTask ?? 3)) return;
		if (callsSinceBlock <= COOLDOWN_CALLS) return;

		// Deterministic prefilter: only completed-call history can trigger.
		const key = callKey(event.toolName, event.input);
		const repeats = callCounts.get(key) ?? 0;
		let trigger: "duplicate" | "retry_after_fail" | "reread" | undefined;
		if (failedKeys.has(key)) trigger = "retry_after_fail";
		else if (repeats >= 2) trigger = "duplicate";
		else if (READ_TOOLS.includes(event.toolName)) {
			const p = ((event.input ?? {}) as Record<string, unknown>).path;
			const norm = typeof p === "string" ? p.replace(/\\/g, "/").toLowerCase() : undefined;
			if (norm && (readCounts.get(norm) ?? 0) >= 3) trigger = "reread";
		}
		if (!trigger) return;

		const preview = callPreview(event.toolName, event.input);
		const result = await judge(
			cfg.judge,
			{
				state: {
					task: task.slice(0, 800) || "(unknown)",
					this_call: preview,
					trigger,
					recent_calls: ring.slice(-10).map((e) => `${e.isError ? "FAIL" : "ok"} ${e.preview}`),
				},
				questions: {
					wasteful: {
						type: "noul",
						instructions:
							"A local coding agent working on `task` wants to run `this_call`, flagged by `trigger` (duplicate = identical call already ran, retry_after_fail = identical call already FAILED, reread = same file read 3+ times). Judge against `recent_calls`: is this redundant thrash — repeating work whose result cannot have changed, or retrying a failed approach unchanged? A repeat AFTER something modified the state (an edit, a fix, a config change visible in recent_calls) is legitimate.",
						criteria: {
							true: "Wasteful: nothing changed since the identical call — the result will be the same",
							false: "Legitimate: state changed since, or the repeat serves a clear purpose",
						},
					},
				},
			},
			{ node: "toolcall", timeoutMs: 2500, workerBaseUrl: modelBaseUrl(ctx.model) },
		);
		const wastefulP = noulOf(result, "wasteful");
		const threshold = cfg.toolGuard?.blockThreshold ?? 0.8;
		const blocked = wastefulP !== undefined && wastefulP >= threshold;

		appendRecord(logDir(cfg), {
			type: "tool_guard",
			cid: newCid(),
			ts: nowIso(),
			cwd: ctx.cwd,
			tool: event.toolName,
			call: preview.slice(0, 200),
			trigger,
			task: task.slice(0, 200),
			wastefulP,
			blocked,
		});

		if (!blocked) return;
		blocksThisTask++;
		callsSinceBlock = 0;
		ctx.ui.setStatus("toolguard", `tool-guard: blocked ${trigger} call (p=${wastefulP.toFixed(2)})`);
		const advice =
			trigger === "retry_after_fail"
				? "That exact call already failed — retrying it unchanged will fail the same way. Change the approach: fix the cause first, or state what you expect to be different."
				: "You already have this result. Use the recall tool to retrieve earlier output instead of re-running, or explain what NEW information this repeat would produce.";
		return {
			block: true,
			reason: `[tool-guard] Blocked (${trigger}, p=${wastefulP.toFixed(2)}): ${advice}`,
		};
	});
}
