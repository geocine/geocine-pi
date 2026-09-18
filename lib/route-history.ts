// Routing memory: the consult-log fed back into the route node.
//
// The log already carries the labels that say how a past consult went —
// user overrides (proposed X, user picked Y), denials, refusals — and
// every record names the WORKER that was active (`mainModel`), because
// preferences are conditional: the rescuer you want under a 27B local
// worker is not the one you want under a frontier main model. This module
// aggregates those records into per-consultant outcome counts (overall +
// per worker base) plus the most recent user-choice exemplars, and the
// advisor injects the projection for the current worker into the route
// node's state. The judge does the generalizing — no task taxonomy here.
//
// Identity: registry keys are just labels and get renamed, so records are
// aggregated by their stable `consultantModel` (provider/model) when
// present, falling back to the key for legacy rows; at projection time
// either identity resolves to the CURRENT registry entry, so history
// survives a rename and stale keys age out naturally.
//
// Memory has two layers: the portable calibration snapshot
// (calibration-snapshot.ts) is the long-term baseline — everything folded
// behind its watermark — and the recent months of the raw log supply what
// happened since. Reading = snapshot + records newer than the watermark,
// so folding never double-counts. The judge trace remains the offline
// horizon (training rows for a routing head).

import * as fs from "node:fs";
import * as path from "node:path";
import {
	loadSnapshot,
	MAX_EXEMPLARS,
	type ModelOutcomes,
	type UserChoiceExemplar,
	type WorkerOutcomes,
} from "./calibration-snapshot.ts";
import { logDir, modelLabel, type GeocineConfig, type ModelConfig } from "./config.ts";

export type { ModelOutcomes, UserChoiceExemplar, WorkerOutcomes };

/** Months of consult-log history scanned for the live layer. */
const HISTORY_MONTHS = 3;
/** Reparse the log files at most this often. */
const CACHE_TTL_MS = 60_000;
const MAX_TASK_CHARS = 160;

export interface HistoryAggregate {
	/** Keyed by stable identity (provider/model) or legacy registry key. */
	models: Record<string, ModelOutcomes>;
	exemplars: UserChoiceExemplar[];
}

interface CacheEntry {
	ts: number;
	aggregate: HistoryAggregate;
}

const cache = new Map<string, CacheEntry>();

function monthFiles(dir: string): string[] {
	const now = new Date();
	const files: string[] = [];
	for (let i = HISTORY_MONTHS - 1; i >= 0; i--) {
		const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
		files.push(path.join(dir, `${d.toISOString().slice(0, 7)}.jsonl`));
	}
	return files;
}

function emptyOutcomes(): WorkerOutcomes {
	return { consults: 0, refused: 0, overriddenAway: 0, overriddenTo: 0, denied: 0 };
}

function outcomes(models: Record<string, ModelOutcomes>, key: string): ModelOutcomes {
	let m = models[key];
	if (!m) {
		m = { ...emptyOutcomes(), perWorker: {} };
		models[key] = m;
	}
	return m;
}

function perWorker(m: ModelOutcomes, worker: string | undefined): WorkerOutcomes {
	const key = worker ?? "(unknown)";
	let w = m.perWorker[key];
	if (!w) {
		w = emptyOutcomes();
		m.perWorker[key] = w;
	}
	return w;
}

interface LoggedRecord {
	type?: string;
	ts?: string;
	consultant?: string;
	consultantModel?: string;
	proposedConsultant?: string;
	proposedConsultantModel?: string;
	chosenBy?: string;
	approval?: string;
	refusalSuspected?: boolean;
	question?: string;
	mainModel?: string;
}

/**
 * Aggregate routing outcomes from log records inside a ts window
 * (afterTs, beforeTs]. ISO timestamps compare lexicographically; "" means
 * unbounded. The fold in calibration.ts uses the same window semantics,
 * which is what makes snapshot + live additive instead of overlapping.
 */
export function aggregateRoutingWindow(dir: string, afterTs: string, beforeTs = ""): HistoryAggregate {
	const models: Record<string, ModelOutcomes> = {};
	const exemplars: UserChoiceExemplar[] = [];
	for (const file of monthFiles(dir)) {
		let text: string;
		try {
			text = fs.readFileSync(file, "utf8");
		} catch {
			continue; // month without records
		}
		for (const line of text.split("\n")) {
			if (!line) continue;
			let rec: LoggedRecord;
			try {
				rec = JSON.parse(line) as LoggedRecord;
			} catch {
				continue;
			}
			const ts = rec.ts ?? "";
			if (afterTs && ts <= afterTs) continue;
			if (beforeTs && ts > beforeTs) continue;
			const key = rec.consultantModel ?? rec.consultant;
			if (!key) continue;
			if (rec.type === "consult_result") {
				if (rec.refusalSuspected) {
					const m = outcomes(models, key);
					m.refused++;
					perWorker(m, rec.mainModel).refused++;
				}
				continue;
			}
			if (rec.type !== "consult_request") continue;
			const denied = rec.approval === "user_no";
			const m = outcomes(models, key);
			if (denied) {
				m.denied++;
				perWorker(m, rec.mainModel).denied++;
			} else {
				m.consults++;
				perWorker(m, rec.mainModel).consults++;
			}
			const proposed = rec.proposedConsultant;
			if (rec.chosenBy === "user_override" && proposed && proposed !== rec.consultant) {
				const away = outcomes(models, rec.proposedConsultantModel ?? proposed);
				away.overriddenAway++;
				perWorker(away, rec.mainModel).overriddenAway++;
				m.overriddenTo++;
				perWorker(m, rec.mainModel).overriddenTo++;
				exemplars.push({
					task: (rec.question ?? "").slice(0, MAX_TASK_CHARS),
					proposed: rec.proposedConsultantModel ?? proposed,
					action: "override",
					chose: key,
					worker: rec.mainModel,
				});
			} else if (denied && proposed) {
				exemplars.push({
					task: (rec.question ?? "").slice(0, MAX_TASK_CHARS),
					proposed: rec.proposedConsultantModel ?? proposed,
					action: "denied",
					worker: rec.mainModel,
				});
			}
		}
	}
	return { models, exemplars: exemplars.slice(-MAX_EXEMPLARS) };
}

/**
 * Long-term snapshot baseline + live records newer than its watermark.
 * The two layers are disjoint by construction (the fold moves records
 * behind the watermark), so merging them is pure addition.
 */
function loadAggregate(cfg: GeocineConfig): HistoryAggregate {
	const dir = logDir(cfg);
	const hit = cache.get(dir);
	if (hit && Date.now() - hit.ts < CACHE_TTL_MS) return hit.aggregate;
	const snap = loadSnapshot(dir);
	const live = aggregateRoutingWindow(dir, snap.foldedThrough);
	const models: Record<string, ModelOutcomes> = {};
	for (const layer of [snap.routing.models, live.models]) {
		for (const [key, m] of Object.entries(layer)) addInto(outcomes(models, key), m);
	}
	const merged: HistoryAggregate = {
		models,
		exemplars: [...snap.routing.exemplars, ...live.exemplars].slice(-MAX_EXEMPLARS),
	};
	cache.set(dir, { ts: Date.now(), aggregate: merged });
	return merged;
}

/** Drop the cached aggregate for one log dir (the fold just moved the watermark). */
export function clearRouteHistoryCache(dir: string): void {
	cache.delete(dir);
}

export function addInto(target: ModelOutcomes, source: ModelOutcomes): void {
	target.consults += source.consults;
	target.refused += source.refused;
	target.overriddenAway += source.overriddenAway;
	target.overriddenTo += source.overriddenTo;
	target.denied += source.denied;
	// snapshot entries travel between machines as plain JSON; tolerate a missing split
	for (const [worker, w] of Object.entries(source.perWorker ?? {})) {
		const t = perWorker(target, worker);
		t.consults += w.consults;
		t.refused += w.refused;
		t.overriddenAway += w.overriddenAway;
		t.overriddenTo += w.overriddenTo;
		t.denied += w.denied;
	}
}

/**
 * Resolve the aggregate's identity keys onto the current pool: a key
 * matches an entry by registry name or by stable provider/model label.
 * Counts logged under an old key and a new label merge; keys matching
 * nothing (renamed-away consultants) drop out.
 */
function projectToPool(agg: HistoryAggregate, pool: Record<string, ModelConfig>): Record<string, ModelOutcomes> {
	const byIdentity = new Map<string, string>();
	for (const [name, c] of Object.entries(pool)) {
		byIdentity.set(name, name);
		byIdentity.set(modelLabel(c), name);
	}
	const projected: Record<string, ModelOutcomes> = {};
	for (const [key, m] of Object.entries(agg.models)) {
		const name = byIdentity.get(key);
		if (!name) continue;
		addInto(outcomes(projected, name), m);
	}
	return projected;
}

/**
 * The `history` state field for the route node: per-consultant outcome
 * counts with a `same_worker` projection for the CURRENT worker, plus the
 * newest user-choice exemplars. Only models present in `pool` appear (the
 * judge routes among those); undefined when the log holds nothing yet, so
 * an empty history adds no state noise.
 */
export function routeHistoryState(
	cfg: GeocineConfig,
	pool: Record<string, ModelConfig>,
	worker: string | undefined,
): Record<string, unknown> | undefined {
	const agg = loadAggregate(cfg);
	const models: Record<string, unknown> = {};
	for (const [name, m] of Object.entries(projectToPool(agg, pool))) {
		const same = worker ? m.perWorker[worker] : undefined;
		models[name] = {
			consults: m.consults,
			refused: m.refused,
			overridden_away: m.overriddenAway,
			overridden_to: m.overriddenTo,
			denied: m.denied,
			...(same
				? {
						same_worker: {
							consults: same.consults,
							refused: same.refused,
							overridden_away: same.overriddenAway,
							overridden_to: same.overriddenTo,
							denied: same.denied,
						},
					}
				: {}),
		};
	}
	if (Object.keys(models).length === 0 && agg.exemplars.length === 0) return undefined;
	return {
		worker: worker ?? "(unknown)",
		models,
		recent_user_choices: agg.exemplars,
	};
}

/** One-line outcome summary for /models (what the router sees), or undefined. */
export function historySummary(cfg: GeocineConfig, name: string): string | undefined {
	const m = projectToPool(loadAggregate(cfg), cfg.models)[name];
	if (!m) return undefined;
	const parts = [
		m.consults ? `${m.consults} consult${m.consults === 1 ? "" : "s"}` : "",
		m.refused ? `${m.refused} refused` : "",
		m.overriddenAway ? `${m.overriddenAway}x overridden away` : "",
		m.overriddenTo ? `${m.overriddenTo}x picked over proposal` : "",
		m.denied ? `${m.denied} denied` : "",
	].filter(Boolean);
	return parts.length ? parts.join(", ") : undefined;
}
