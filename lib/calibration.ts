// Calibration: does the judge's confidence mean anything — and can the
// answer travel with you?
//
// The decision fabric acts on thresholds (gate nudges above
// judge.minConfidence, the approve node auto-clears consults above
// approval.approveThreshold), but a threshold is only as good as the
// probability behind it. This module joins each confident decision to
// what actually happened next:
//
//   gate      a nudged verdict's outcome is the NEXT gate record for the
//             same cwd+task — did it reach stop / high doneP (the nudge
//             worked), stay unfinished (it didn't), or never re-settle
//             (the user stepped in)? Split by confidence bin: if high-
//             confidence nudges don't resolve more often than low ones,
//             the confidence is noise and the threshold is guesswork.
//   approve   when the approve node answered but stayed below the auto
//             threshold, the USER decided — approveP vs user_yes/user_no
//             is a direct calibration pair.
//   triage /  volume and mix over the recent window, so drift is visible
//   watchdog  ("why is everything suddenly frontier-routed?").
//
// Persistence is two-layer: foldCalibration() compacts old log records
// into the portable snapshot (calibration-snapshot.ts) behind a ts
// watermark, and every reader combines snapshot + newer records — so the
// smartness survives log rotation, stays one small file, and moves to a
// new workstation by copying it. resetCalibration() starts learning fresh
// from "now" without touching the logs. Surfaced by /calibration.

import * as fs from "node:fs";
import * as path from "node:path";
import {
	type ApproveStats,
	emptyGateStats,
	emptySnapshot,
	type GateStats,
	loadSnapshot,
	MAX_EXEMPLARS,
	saveSnapshot,
	snapshotFile,
} from "./calibration-snapshot.ts";
import { addInto, aggregateRoutingWindow, clearRouteHistoryCache } from "./route-history.ts";

/** Months of consult-log history scanned for the live layer. */
const HISTORY_MONTHS = 3;
/** doneP at which a post-nudge verdict counts as resolved even without "stop". */
const RESOLVED_DONE_P = 0.6;
/**
 * Records younger than this are never folded: a nudge's outcome is the
 * NEXT verdict for its task, which may not have settled yet. Folding a
 * nudge before its follow-up arrives would freeze it as "no follow-up".
 */
const FOLD_MARGIN_MS = 60 * 60 * 1000;
/** Confidence bin edges; length must equal calibration-snapshot BIN_COUNT. */
const BINS = [
	{ label: "<0.70", min: 0, max: 0.7 },
	{ label: "0.70–0.84", min: 0.7, max: 0.85 },
	{ label: "≥0.85", min: 0.85, max: 1.01 },
];

interface GateRow {
	ts: string;
	cwd: string;
	task: string;
	next: string;
	confidence: number;
	doneP?: number;
	wantsChangesP?: number;
	nudged?: boolean;
}

interface RawRecord {
	type?: string;
	ts?: string;
	cwd?: string;
	task?: string;
	next?: string;
	confidence?: number;
	doneP?: number;
	wantsChangesP?: number;
	nudged?: boolean;
	approval?: string;
	approveP?: number;
	route?: string;
	verdict?: string;
	hintSent?: boolean;
}

/** Log records inside the ts window (afterTs, beforeTs]; "" = unbounded. */
function readRecords(dir: string, afterTs: string, beforeTs = ""): RawRecord[] {
	const now = new Date();
	const records: RawRecord[] = [];
	for (let i = HISTORY_MONTHS - 1; i >= 0; i--) {
		const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
		let text: string;
		try {
			text = fs.readFileSync(path.join(dir, `${d.toISOString().slice(0, 7)}.jsonl`), "utf8");
		} catch {
			continue; // month without records
		}
		for (const line of text.split("\n")) {
			if (!line) continue;
			try {
				const rec = JSON.parse(line) as RawRecord;
				const ts = rec.ts ?? "";
				if (afterTs && ts <= afterTs) continue;
				if (beforeTs && ts > beforeTs) continue;
				records.push(rec);
			} catch {
				// skip corrupt lines
			}
		}
	}
	return records;
}

function count<T>(items: T[], key: (item: T) => string | undefined): Map<string, number> {
	const map = new Map<string, number>();
	for (const item of items) {
		const k = key(item);
		if (!k) continue;
		map.set(k, (map.get(k) ?? 0) + 1);
	}
	return map;
}

function mix(counts: Record<string, number> | Map<string, number>): string {
	const entries = counts instanceof Map ? [...counts.entries()] : Object.entries(counts);
	return entries
		.filter(([, n]) => n > 0)
		.sort((a, b) => b[1] - a[1])
		.map(([k, n]) => `${k} ${n}`)
		.join(", ");
}

function mean(values: number[]): number | undefined {
	return values.length ? values.reduce((a, b) => a + b, 0) / values.length : undefined;
}

/**
 * Gate stats from raw records: verdict mix plus the nudge-outcome join —
 * every nudged verdict paired with the next verdict for the same
 * cwd+task. That later record IS the nudge's outcome: the nudge restarted
 * the worker, and the gate re-judged the same task when it settled again.
 */
function gateStatsFrom(records: RawRecord[]): GateStats {
	const stats = emptyGateStats();
	const gates = records.filter(
		(r): r is GateRow & RawRecord =>
			r.type === "gate" && !!r.ts && !!r.cwd && !!r.task && !!r.next && r.confidence !== undefined,
	);
	for (const g of gates) {
		stats.verdicts[g.next] = (stats.verdicts[g.next] ?? 0) + 1;
		if (g.wantsChangesP !== undefined && g.wantsChangesP < 0.5) stats.informational++;
	}
	const groups = new Map<string, GateRow[]>();
	for (const g of gates) {
		const key = `${g.cwd}\u0000${g.task}`;
		const list = groups.get(key) ?? [];
		list.push(g);
		groups.set(key, list);
	}
	for (const list of groups.values()) {
		list.sort((a, b) => a.ts.localeCompare(b.ts));
		for (const [i, g] of list.entries()) {
			if (!g.nudged) continue;
			stats.nudgesSent++;
			const after = list[i + 1];
			if (!after) {
				stats.noFollowUp++;
				continue;
			}
			const resolved = after.next === "stop" || (after.doneP !== undefined && after.doneP >= RESOLVED_DONE_P);
			if (resolved) stats.resolved++;
			else stats.stalled++;
			const bin = BINS.findIndex((b) => g.confidence >= b.min && g.confidence < b.max);
			if (bin >= 0) {
				stats.bins[bin].followed++;
				if (resolved) stats.bins[bin].resolved++;
			}
		}
	}
	return stats;
}

function approveStatsFrom(records: RawRecord[]): ApproveStats {
	const stats: ApproveStats = { auto: 0, yesCount: 0, yesSumP: 0, noCount: 0, noSumP: 0 };
	for (const r of records) {
		if (r.type !== "consult_request" || r.approveP === undefined) continue;
		if (r.approval === "judge_auto") stats.auto++;
		else if (r.approval === "user_yes") {
			stats.yesCount++;
			stats.yesSumP += r.approveP;
		} else if (r.approval === "user_no") {
			stats.noCount++;
			stats.noSumP += r.approveP;
		}
	}
	return stats;
}

function mergeGate(target: GateStats, source: GateStats): void {
	for (const [k, n] of Object.entries(source.verdicts)) target.verdicts[k] = (target.verdicts[k] ?? 0) + n;
	target.informational += source.informational;
	target.nudgesSent += source.nudgesSent;
	target.resolved += source.resolved;
	target.stalled += source.stalled;
	target.noFollowUp += source.noFollowUp;
	for (const [i, bin] of source.bins.entries()) {
		target.bins[i].resolved += bin.resolved;
		target.bins[i].followed += bin.followed;
	}
}

function mergeApprove(target: ApproveStats, source: ApproveStats): void {
	target.auto += source.auto;
	target.yesCount += source.yesCount;
	target.yesSumP += source.yesSumP;
	target.noCount += source.noCount;
	target.noSumP += source.noSumP;
}

/**
 * Fold log records older than the margin into the portable snapshot and
 * advance the watermark. Idempotent: re-running folds nothing new. The
 * routing aggregate uses the same window semantics, so snapshot + live
 * stays purely additive.
 */
export function foldCalibration(dir: string): { folded: number; through: string; file: string } {
	const snap = loadSnapshot(dir);
	const before = new Date(Date.now() - FOLD_MARGIN_MS).toISOString();
	const file = snapshotFile(dir);
	if (snap.foldedThrough && before <= snap.foldedThrough) return { folded: 0, through: snap.foldedThrough, file };
	const records = readRecords(dir, snap.foldedThrough, before);
	if (records.length) {
		mergeGate(snap.gate, gateStatsFrom(records));
		mergeApprove(snap.approve, approveStatsFrom(records));
		const routing = aggregateRoutingWindow(dir, snap.foldedThrough, before);
		for (const [key, m] of Object.entries(routing.models)) {
			const existing = snap.routing.models[key];
			if (existing) addInto(existing, m);
			else snap.routing.models[key] = m;
		}
		snap.routing.exemplars = [...snap.routing.exemplars, ...routing.exemplars].slice(-MAX_EXEMPLARS);
	}
	snap.foldedThrough = before;
	saveSnapshot(dir, snap); // also bumps updatedAt, which paces the auto-fold
	clearRouteHistoryCache(dir);
	return { folded: records.length, through: before, file };
}

/**
 * Start learning fresh from now: an empty snapshot whose watermark is the
 * present, so past log records stop counting. The logs stay untouched —
 * this resets the memory, not the evidence.
 */
export function resetCalibration(dir: string): string {
	saveSnapshot(dir, emptySnapshot(new Date().toISOString()));
	clearRouteHistoryCache(dir);
	return snapshotFile(dir);
}

/** When the snapshot was last folded, for the auto-fold pacing check. */
export function snapshotAgeMs(dir: string): number {
	const snap = loadSnapshot(dir);
	if (!snap.updatedAt) return Number.POSITIVE_INFINITY;
	const t = Date.parse(snap.updatedAt);
	return Number.isNaN(t) ? Number.POSITIVE_INFINITY : Date.now() - t;
}

/** The /calibration report: judge confidence vs realized outcomes, as display lines. */
export function calibrationReport(dir: string): string[] {
	const snap = loadSnapshot(dir);
	const live = readRecords(dir, snap.foldedThrough);
	const lines: string[] = ["Judge calibration — portable snapshot + live decision log"];

	// --- gate ---
	const gate = emptyGateStats();
	mergeGate(gate, snap.gate);
	mergeGate(gate, gateStatsFrom(live));
	const verdictTotal = Object.values(gate.verdicts).reduce((a, b) => a + b, 0);
	if (verdictTotal) {
		lines.push("");
		lines.push(`gate: ${verdictTotal} verdicts (${mix(gate.verdicts)})${gate.informational ? ` · informational ${gate.informational}` : ""}`);
		if (gate.nudgesSent) {
			lines.push(`  nudges: ${gate.nudgesSent} sent → resolved ${gate.resolved}, stalled ${gate.stalled}, no follow-up ${gate.noFollowUp}`);
			const binParts = BINS.map((b, i) => {
				const s = gate.bins[i];
				return s.followed ? `${b.label} → ${s.resolved}/${s.followed} resolved` : "";
			}).filter(Boolean);
			if (binParts.length) lines.push(`  by confidence: ${binParts.join(" · ")}`);
			lines.push("  reading: high-confidence nudges should resolve more often than low ones; if they don't, judge.minConfidence is cutting on noise");
		} else {
			lines.push("  nudges: none sent yet — no outcome labels to calibrate on");
		}
	}

	// --- approve node ---
	const approve: ApproveStats = { auto: 0, yesCount: 0, yesSumP: 0, noCount: 0, noSumP: 0 };
	mergeApprove(approve, snap.approve);
	mergeApprove(approve, approveStatsFrom(live));
	const judged = approve.auto + approve.yesCount + approve.noCount;
	if (judged) {
		lines.push("");
		lines.push(`approve: ${judged} judged consults · auto-approved ${approve.auto} · left to you: yes ${approve.yesCount}, no ${approve.noCount}`);
		if (approve.yesCount || approve.noCount) {
			const meanYes = approve.yesCount ? (approve.yesSumP / approve.yesCount).toFixed(2) : "—";
			const meanNo = approve.noCount ? (approve.noSumP / approve.noCount).toFixed(2) : "—";
			lines.push(`  mean approveP when you said yes ${meanYes} vs no ${meanNo}`);
			lines.push("  reading: a wide yes/no gap means the node ranks well — approval.approveThreshold can come down; no gap means it can't tell and the threshold only buys silence");
		}
	}

	// --- triage / watchdog volume + mix (recent window only; drift info, not folded) ---
	const triage = live.filter((r) => r.type === "triage");
	if (triage.length) {
		const conf = mean(triage.map((r) => r.confidence).filter((c): c is number => c !== undefined));
		const hints = triage.filter((r) => r.hintSent).length;
		lines.push("");
		lines.push(
			`triage (recent): ${triage.length} judged tasks (${mix(count(triage, (r) => r.route))})${conf !== undefined ? ` · mean confidence ${conf.toFixed(2)}` : ""}${hints ? ` · hints ${hints}` : ""}`,
		);
	}
	const watchdog = live.filter((r) => r.type === "watchdog");
	if (watchdog.length) {
		const hints = watchdog.filter((r) => r.hintSent).length;
		lines.push("");
		lines.push(`watchdog (recent): ${watchdog.length} verdicts (${mix(count(watchdog, (r) => r.verdict))})${hints ? ` · hints ${hints}` : ""}`);
	}

	if (lines.length === 1) {
		lines.push(`No decision records or snapshot data under ${dir} yet — run some sessions first.`);
	} else {
		lines.push("");
		lines.push(
			`snapshot: ${snapshotFile(dir)} — ${snap.foldedThrough ? `folded through ${snap.foldedThrough.slice(0, 16)}Z` : "nothing folded yet"}. Copy this file to move workstations; /calibration fold compacts now, /calibration reset recalibrates from today.`,
		);
	}
	return lines;
}
