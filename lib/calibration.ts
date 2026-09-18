// Calibration: does the judge's confidence mean anything?
//
// The decision fabric acts on thresholds (gate nudges above
// judge.minConfidence, the approve node auto-clears consults above
// approval.approveThreshold), but a threshold is only as good as the
// probability behind it. This module reads the consult log back and joins
// each confident decision to what actually happened next:
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
//   triage /  volume and mix, so drift is visible ("why is everything
//   watchdog  suddenly frontier-routed?").
//
// Pure read-side analysis of existing records; nothing here changes a
// decision. Surfaced by the /calibration command.

import * as fs from "node:fs";
import * as path from "node:path";

/** Months of consult-log history scanned (current + previous N-1). */
const HISTORY_MONTHS = 3;
/** doneP at which a post-nudge verdict counts as resolved even without "stop". */
const RESOLVED_DONE_P = 0.6;
/** Confidence bin edges for the gate's nudge analysis. */
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

function readRecords(dir: string): RawRecord[] {
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
				records.push(JSON.parse(line) as RawRecord);
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

function mix(counts: Map<string, number>): string {
	return [...counts.entries()]
		.sort((a, b) => b[1] - a[1])
		.map(([k, n]) => `${k} ${n}`)
		.join(", ");
}

function mean(values: number[]): number | undefined {
	return values.length ? values.reduce((a, b) => a + b, 0) / values.length : undefined;
}

interface NudgeOutcomes {
	sent: number;
	resolved: number;
	stalled: number;
	noFollowUp: number;
	/** resolved/followed per confidence bin, aligned with BINS. */
	bins: { resolved: number; followed: number }[];
}

/**
 * Join every nudged gate verdict to the next verdict for the same
 * cwd+task. That later record IS the nudge's outcome: the nudge restarted
 * the worker, and the gate re-judged the same task when it settled again.
 */
function nudgeOutcomes(gates: GateRow[]): NudgeOutcomes {
	const out: NudgeOutcomes = {
		sent: 0,
		resolved: 0,
		stalled: 0,
		noFollowUp: 0,
		bins: BINS.map(() => ({ resolved: 0, followed: 0 })),
	};
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
			out.sent++;
			const after = list[i + 1];
			if (!after) {
				out.noFollowUp++;
				continue;
			}
			const resolved = after.next === "stop" || (after.doneP !== undefined && after.doneP >= RESOLVED_DONE_P);
			if (resolved) out.resolved++;
			else out.stalled++;
			const bin = BINS.findIndex((b) => g.confidence >= b.min && g.confidence < b.max);
			if (bin >= 0) {
				out.bins[bin].followed++;
				if (resolved) out.bins[bin].resolved++;
			}
		}
	}
	return out;
}

/** The /calibration report: judge confidence vs realized outcomes, as display lines. */
export function calibrationReport(dir: string): string[] {
	const records = readRecords(dir);
	if (records.length === 0) return [`No decision records under ${dir} for the last ${HISTORY_MONTHS} months.`];
	const lines: string[] = [`Judge calibration — decision log, last ${HISTORY_MONTHS} months (${dir})`];

	// --- gate ---
	const gates = records
		.filter((r) => r.type === "gate" && r.ts && r.cwd && r.task && r.next && r.confidence !== undefined)
		.map((r) => r as GateRow & RawRecord);
	if (gates.length) {
		const informational = gates.filter((g) => g.wantsChangesP !== undefined && g.wantsChangesP < 0.5).length;
		lines.push("");
		lines.push(`gate: ${gates.length} verdicts (${mix(count(gates, (g) => g.next))})${informational ? ` · informational ${informational}` : ""}`);
		const n = nudgeOutcomes(gates);
		if (n.sent) {
			lines.push(`  nudges: ${n.sent} sent → resolved ${n.resolved}, stalled ${n.stalled}, no follow-up ${n.noFollowUp}`);
			const binParts = BINS.map((b, i) => {
				const s = n.bins[i];
				return s.followed ? `${b.label} → ${s.resolved}/${s.followed} resolved` : "";
			}).filter(Boolean);
			if (binParts.length) lines.push(`  by confidence: ${binParts.join(" · ")}`);
			lines.push("  reading: high-confidence nudges should resolve more often than low ones; if they don't, judge.minConfidence is cutting on noise");
		} else {
			lines.push("  nudges: none sent yet — no outcome labels to calibrate on");
		}
	}

	// --- approve node ---
	const judged = records.filter((r) => r.type === "consult_request" && r.approveP !== undefined);
	if (judged.length) {
		const auto = judged.filter((r) => r.approval === "judge_auto");
		const yes = judged.filter((r) => r.approval === "user_yes");
		const no = judged.filter((r) => r.approval === "user_no");
		const meanYes = mean(yes.map((r) => r.approveP as number));
		const meanNo = mean(no.map((r) => r.approveP as number));
		lines.push("");
		lines.push(`approve: ${judged.length} judged consults · auto-approved ${auto.length} · left to you: yes ${yes.length}, no ${no.length}`);
		if (meanYes !== undefined || meanNo !== undefined) {
			lines.push(
				`  mean approveP when you said yes ${meanYes !== undefined ? meanYes.toFixed(2) : "—"} vs no ${meanNo !== undefined ? meanNo.toFixed(2) : "—"}`,
			);
			lines.push("  reading: a wide yes/no gap means the node ranks well — approval.approveThreshold can come down; no gap means it can't tell and the threshold only buys silence");
		}
	}

	// --- triage / watchdog volume + mix (drift visibility) ---
	const triage = records.filter((r) => r.type === "triage");
	if (triage.length) {
		const conf = mean(triage.map((r) => r.confidence).filter((c): c is number => c !== undefined));
		const hints = triage.filter((r) => r.hintSent).length;
		lines.push("");
		lines.push(
			`triage: ${triage.length} judged tasks (${mix(count(triage, (r) => r.route))})${conf !== undefined ? ` · mean confidence ${conf.toFixed(2)}` : ""}${hints ? ` · hints ${hints}` : ""}`,
		);
	}
	const watchdog = records.filter((r) => r.type === "watchdog");
	if (watchdog.length) {
		const hints = watchdog.filter((r) => r.hintSent).length;
		lines.push("");
		lines.push(`watchdog: ${watchdog.length} verdicts (${mix(count(watchdog, (r) => r.verdict))})${hints ? ` · hints ${hints}` : ""}`);
	}

	if (lines.length === 1) lines.push("No gate/approve/triage/watchdog records yet — run some sessions first.");
	return lines;
}
