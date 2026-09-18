// Calibration snapshot: the setup's learned smartness in ONE portable file.
//
// The consult log is the source of truth, but it grows month by month and
// reads back with a rolling horizon. This snapshot is the distilled form:
// pure additive counters plus a few capped exemplars, folded forward from
// the log behind a `foldedThrough` watermark — records at or before the
// watermark live in the snapshot, and readers only add newer log records
// on top, so nothing is ever double-counted.
//
//   portable   copy <agent dir>/calibration.json to a new workstation and
//              routing memory + /calibration carry over; the raw logs can
//              stay behind.
//   bounded    counters never grow; exemplars, models, and per-worker
//              splits are capped on save.
//   resettable /calibration reset replaces it with an empty snapshot
//              whose watermark is "now" — learning restarts from today
//              without touching the logs.
//
// This module is dependency-free on purpose (types + load/save only), so
// route-history and calibration can both import it without cycles.

import * as fs from "node:fs";
import * as path from "node:path";

export const SNAPSHOT_VERSION = 1;
/** Confidence bins in GateStats.bins (calibration.ts BINS must match). */
export const BIN_COUNT = 3;
/** Exemplars kept (the judge sees the newest ones). */
export const MAX_EXEMPLARS = 10;
/** Consultant identities kept, largest consult counts win. */
const MAX_MODELS = 40;
/** Per-consultant worker splits kept, largest consult counts win. */
const MAX_WORKERS_PER_MODEL = 8;

export interface WorkerOutcomes {
	consults: number;
	refused: number;
	overriddenAway: number;
	overriddenTo: number;
	denied: number;
}

export interface ModelOutcomes extends WorkerOutcomes {
	/** The same counts split by the worker (`mainModel`) active at the time. */
	perWorker: Record<string, WorkerOutcomes>;
}

export interface UserChoiceExemplar {
	task: string;
	proposed: string;
	action: "override" | "denied";
	/** Who the user picked instead (override only). */
	chose?: string;
	/** Worker active when the choice was made. */
	worker?: string;
}

/** One confidence bin of the gate's nudge-outcome join (aligned with BINS). */
export interface NudgeBin {
	resolved: number;
	followed: number;
}

export interface GateStats {
	/** Verdict counts by next choice (continue/replan/stop/escalate). */
	verdicts: Record<string, number>;
	informational: number;
	nudgesSent: number;
	resolved: number;
	stalled: number;
	noFollowUp: number;
	/** Aligned with calibration.ts BINS; a version bump re-bins. */
	bins: NudgeBin[];
}

export interface ApproveStats {
	auto: number;
	yesCount: number;
	/** Sum of approveP over yes decisions — sums merge additively, means don't. */
	yesSumP: number;
	noCount: number;
	noSumP: number;
}

export interface CalibrationSnapshot {
	version: number;
	updatedAt: string;
	/** Log records with ts <= this are folded in; "" = nothing folded yet. */
	foldedThrough: string;
	routing: {
		/** Keyed by stable identity (provider/model) or legacy registry key. */
		models: Record<string, ModelOutcomes>;
		exemplars: UserChoiceExemplar[];
	};
	gate: GateStats;
	approve: ApproveStats;
}

export function emptyGateStats(): GateStats {
	return {
		verdicts: {},
		informational: 0,
		nudgesSent: 0,
		resolved: 0,
		stalled: 0,
		noFollowUp: 0,
		bins: Array.from({ length: BIN_COUNT }, () => ({ resolved: 0, followed: 0 })),
	};
}

export function emptySnapshot(foldedThrough = ""): CalibrationSnapshot {
	return {
		version: SNAPSHOT_VERSION,
		updatedAt: "",
		foldedThrough,
		routing: { models: {}, exemplars: [] },
		gate: emptyGateStats(),
		approve: { auto: 0, yesCount: 0, yesSumP: 0, noCount: 0, noSumP: 0 },
	};
}

/** The portable file: next to the log dir (default ~/.pi/agent/calibration.json). */
export function snapshotFile(logDirPath: string): string {
	return path.join(path.dirname(logDirPath), "calibration.json");
}

export function loadSnapshot(logDirPath: string): CalibrationSnapshot {
	try {
		const raw = JSON.parse(fs.readFileSync(snapshotFile(logDirPath), "utf8")) as CalibrationSnapshot;
		if (raw.version !== SNAPSHOT_VERSION || !raw.routing || !raw.gate || !raw.approve) {
			return emptySnapshot(); // unknown shape: start fresh, logs still hold the truth
		}
		// Re-binning across versions is not attempted; mismatched bins reset.
		if (!Array.isArray(raw.gate.bins) || raw.gate.bins.length !== BIN_COUNT) {
			raw.gate = { ...emptyGateStats(), verdicts: raw.gate.verdicts ?? {}, informational: raw.gate.informational ?? 0 };
		}
		return raw;
	} catch {
		return emptySnapshot();
	}
}

/** Keep the snapshot bounded: drop the smallest entries beyond the caps. */
function applyCaps(snap: CalibrationSnapshot): void {
	const models = Object.entries(snap.routing.models);
	if (models.length > MAX_MODELS) {
		models.sort((a, b) => b[1].consults - a[1].consults);
		snap.routing.models = Object.fromEntries(models.slice(0, MAX_MODELS));
	}
	for (const m of Object.values(snap.routing.models)) {
		const workers = Object.entries(m.perWorker);
		if (workers.length > MAX_WORKERS_PER_MODEL) {
			workers.sort((a, b) => b[1].consults - a[1].consults);
			m.perWorker = Object.fromEntries(workers.slice(0, MAX_WORKERS_PER_MODEL));
		}
	}
	snap.routing.exemplars = snap.routing.exemplars.slice(-MAX_EXEMPLARS);
}

/** Atomic write (tmp + rename): a crash mid-save must not corrupt the brain. */
export function saveSnapshot(logDirPath: string, snap: CalibrationSnapshot): void {
	try {
		applyCaps(snap);
		snap.updatedAt = new Date().toISOString();
		const file = snapshotFile(logDirPath);
		fs.mkdirSync(path.dirname(file), { recursive: true });
		const tmp = `${file}.tmp`;
		fs.writeFileSync(tmp, `${JSON.stringify(snap, null, "\t")}\n`, "utf8");
		fs.renameSync(tmp, file);
	} catch {
		// persisting the snapshot must never break a session
	}
}
