// Append-only decision log — the training-data flywheel (offload ladder rung 1).
//
// Every record carries decision-time features, never post-hoc reconstructions.
// Records of one consultation share a correlation id (`cid`), so a later
// /consult-export can join trigger -> staging -> prescreen -> outcome into
// labeled examples for fine-tuning.
//
// Files: <logDir>/YYYY-MM.jsonl, one JSON object per line, append-only.

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

export type LogRecord =
	| ConsultRequestRecord
	| StagingRecord
	| PrescreenRecord
	| ConsultResultRecord
	| WatchdogRecord
	| TriageRecord
	| GateRecord
	| GuardRecord
	| RescueRecord
	| CompactionRecord;

export interface BaseRecord {
	/** Record type discriminator. */
	type: string;
	/** Correlation id shared by all records of one consultation/incident. */
	cid: string;
	/** UTC ISO-8601 timestamp. */
	ts: string;
	/** Workspace the main session was in. */
	cwd: string;
	/** Main session model at the time (provider/id). */
	mainModel?: string;
}

export interface ConsultRequestRecord extends BaseRecord {
	type: "consult_request";
	consultant: string;
	source: "tool" | "command" | "watchdog";
	question: string;
	files: string[];
	contextNote?: string;
	/**
	 * How the consultation was authorized. "user_no" records are denied
	 * requests — direct training labels for "should not have consulted".
	 */
	approval?: "user_yes" | "user_no" | "always_allow" | "auto" | "headless" | "user_command";
	/**
	 * Routing provenance: which rescuer the model proposed vs who actually
	 * ran. A user override (proposed != consultant) is a routing label —
	 * "the model picked the wrong rescuer for this kind of problem".
	 */
	proposedConsultant?: string;
	chosenBy?: "model" | "default" | "judge" | "user_override" | "auto";
	/** Session mode active when the consult was requested (routing feature). */
	mode?: string;
}

export interface StagedFile {
	requested: string;
	stagedAs: string;
	bytes: number;
	lines?: string;
}

export interface StagingRecord extends BaseRecord {
	type: "staging";
	consultant: string;
	jail: "staged" | "docker" | "none";
	files: StagedFile[];
	totalBytes: number;
	briefingBytes: number;
	errors: string[];
}

export interface PrescreenRecord extends BaseRecord {
	type: "prescreen";
	consultant: string;
	screener: string;
	/** The screener's verdict as parsed (or raw text if parsing failed). */
	risk: "low" | "medium" | "high" | "unknown";
	triggers: string[];
	reframe?: string;
	rawResponse: string;
	elapsedMs: number;
}

export interface ConsultResultRecord extends BaseRecord {
	type: "consult_result";
	consultant: string;
	jail: "staged" | "docker" | "none";
	exitCode: number;
	refusalSuspected: boolean;
	/** Consultant's final advisory text (what went back to the worker). */
	advice: string;
	/** Staged files the consultant actually opened (utilization signal). */
	filesRead: string[];
	filesStaged: string[];
	turns: number;
	usage: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number };
	elapsedMs: number;
	error?: string;
}

export interface WatchdogRecord extends BaseRecord {
	type: "watchdog";
	/** 0 = counters, 1 = small-LLM verifier, "judge" = System One classifier. */
	tier: 0 | 1 | "judge";
	verdict: "ok" | "loop" | "stuck" | "drift" | "error";
	reason: string;
	/** The digest the verdict was computed from (decision-time features). */
	digest: string;
	hintSent: boolean;
	turnIndex: number;
	/** Judge's escalate-now probability from the same call, when asked. */
	escalateP?: number;
}

export interface GateRecord extends BaseRecord {
	type: "gate";
	/** The user task being verified (snippet). */
	task: string;
	/** Judge's "complete and correct" probability from the evidence. */
	doneP?: number;
	/** Judge's "worse than before — revert beats forward-fixing" probability. */
	revertP?: number;
	/** Risk that the diff breaks existing behavior beyond the task. */
	regressionP?: number;
	/** Probability the diff contains off-task changes. */
	scopeCreepP?: number;
	/** Probability the diff is structural rather than a local fix. */
	archP?: number;
	/** Probability the changed behavior lacks test evidence. */
	needsTestsP?: number;
	/** Probability a human decision point blocks — suppresses nudges. */
	needsHumanP?: number;
	next: "continue" | "stop" | "escalate";
	confidence: number;
	/** git diff --stat tail at decision time (evidence summary). */
	diffStat?: string;
	/** How many captured test/lint/build outputs fed the judgment. */
	checksSeen: number;
	contextTokens?: number;
	/** Turns in the settled run. */
	turns: number;
	/** An idle nudge was sent back into the session (continue/escalate). */
	nudged: boolean;
}

export interface GuardRecord extends BaseRecord {
	type: "guard";
	/** The destructive-looking command (truncated). */
	command: string;
	/** The user task it was judged against (snippet). */
	task: string;
	/** Judge's collateral-damage probability. */
	riskyP?: number;
	blocked: boolean;
	tool: string;
}

export interface TriageRecord extends BaseRecord {
	type: "triage";
	/** The user task as judged (snippet). */
	task: string;
	/** Difficulty score 0..3 over the triage levels (may land between). */
	difficulty?: number;
	route: "local" | "plan_first" | "frontier";
	confidence: number;
	/** Session stage at decision time. */
	contextTokens?: number;
	turnIndex: number;
	/** Rescuer the hint named, when one was sent. */
	rescuer?: string;
	hintSent: boolean;
}

export interface RescueToolEvent {
	tool: string;
	ok: boolean;
	preview: string;
}

/**
 * One manual-rescue episode: the user switched from the local model to a
 * stronger one mid-session, the stronger model worked, then the session
 * switched back (or ended). The failure context and the rescue trajectory
 * are the highest-value fine-tuning pairs the setup produces.
 */
export interface RescueRecord extends BaseRecord {
	type: "rescue";
	fromModel: string;
	toModel: string;
	/** Compact digest of the local model's failing tail (decision-time). */
	failureDigest: string;
	/** What the rescuer did, in order. */
	toolEvents: RescueToolEvent[];
	filesTouched: string[];
	rescuerTurns: number;
	rescuerFailedCalls: number;
	/** Rescuer's last assistant text (its own account of the fix). */
	rescuerSummary: string;
	endedBy: "switch_back" | "session_end";
	startedTs: string;
}

/**
 * One checkpoint compaction: how much context was replaced, what wrote the
 * summary, and whether the custom path succeeded or fell back to pi's
 * default. Utilization of the recall tool after a compaction is the signal
 * for what the checkpoint failed to carry forward.
 */
export interface CompactionRecord extends BaseRecord {
	type: "compaction";
	reason: "manual" | "threshold" | "overflow";
	summarizer: string;
	tokensBefore: number;
	messagesSummarized: number;
	summaryChars: number;
	/** Model-written notes pinned verbatim into the digest. */
	notesPinned?: number;
	outcome: "arc" | "custom" | "fallback_empty" | "fallback_error" | "fallback_not_smaller";
	elapsedMs: number;
	error?: string;
}

export function newCid(): string {
	return crypto.randomUUID();
}

export function appendRecord(dir: string, record: LogRecord): void {
	try {
		fs.mkdirSync(dir, { recursive: true });
		const file = path.join(dir, `${record.ts.slice(0, 7)}.jsonl`);
		fs.appendFileSync(file, `${JSON.stringify(record)}\n`, "utf8");
	} catch {
		// Logging must never break the session.
	}
}

export function nowIso(): string {
	return new Date().toISOString();
}
