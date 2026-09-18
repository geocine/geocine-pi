// /calibration: is the judge earning its confidence — and where does that
// knowledge live?
//
// The fabric's thresholds (gate nudges above judge.minConfidence, consult
// auto-approval above approval.approveThreshold) assume the probabilities
// behind them track reality. This command reads the evidence back and
// manages the portable snapshot that carries it across workstations:
//
//   /calibration        report: nudge confidence vs whether the nudged
//                       task actually resolved, approve-node probability
//                       vs what the user then decided
//   /calibration fold   compact log records into the snapshot now
//   /calibration reset  recalibrate: learning restarts from today
//
// The snapshot (~/.pi/agent/calibration.json by default) also auto-folds
// about weekly on session start, so the smartness survives log rotation
// without anyone remembering to run fold. Analysis in lib/calibration.ts,
// snapshot format in lib/calibration-snapshot.ts.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { calibrationReport, foldCalibration, resetCalibration, snapshotAgeMs } from "../lib/calibration.ts";
import { loadConfig, logDir } from "../lib/config.ts";

/** Auto-fold when the snapshot is older than this (paced by updatedAt). */
const AUTO_FOLD_MS = 7 * 24 * 60 * 60 * 1000;

export default function calibration(pi: ExtensionAPI) {
	// Keep the snapshot current without ceremony: fold roughly weekly.
	pi.on("session_start", async (_event, ctx) => {
		try {
			const cfg = loadConfig(ctx.cwd);
			const dir = logDir(cfg);
			if (snapshotAgeMs(dir) > AUTO_FOLD_MS) foldCalibration(dir);
		} catch {
			// calibration upkeep must never break a session
		}
	});

	pi.registerCommand("calibration", {
		description:
			"Judge calibration: report (default), 'fold' compacts logs into the portable snapshot, 'reset' recalibrates from today",
		handler: async (args, ctx) => {
			const cfg = loadConfig(ctx.cwd);
			const dir = logDir(cfg);
			const arg = String(args ?? "").trim().toLowerCase();
			if (arg === "fold") {
				const r = foldCalibration(dir);
				ctx.ui.notify(
					r.folded
						? `Folded ${r.folded} record(s) into ${r.file} (through ${r.through.slice(0, 16)}Z).`
						: `Nothing new to fold — snapshot already covers everything older than an hour (${r.file}).`,
					"info",
				);
				return;
			}
			if (arg === "reset") {
				const file = resetCalibration(dir);
				ctx.ui.notify(`Calibration reset: ${file} cleared, learning restarts from today. The raw logs are untouched.`, "info");
				return;
			}
			ctx.ui.notify(calibrationReport(dir).join("\n"), "info");
		},
	});
}
