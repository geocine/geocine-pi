// /calibration: is the judge earning its confidence?
//
// The fabric's thresholds (gate nudges above judge.minConfidence, consult
// auto-approval above approval.approveThreshold) assume the probabilities
// behind them track reality. This command reads the decision log back and
// shows the join: nudge confidence vs whether the nudged task actually
// resolved, approve-node probability vs what the user then decided. Use
// it to tune the thresholds on evidence instead of vibes — the analysis
// itself lives in lib/calibration.ts.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { calibrationReport } from "../lib/calibration.ts";
import { loadConfig, logDir } from "../lib/config.ts";

export default function calibration(pi: ExtensionAPI) {
	pi.registerCommand("calibration", {
		description: "Judge calibration report: logged confidences vs what actually happened (nudge outcomes, approval agreement)",
		handler: async (_args, ctx) => {
			const cfg = loadConfig(ctx.cwd);
			ctx.ui.notify(calibrationReport(logDir(cfg)).join("\n"), "info");
		},
	});
}
