// worked-timer: Codex-style run timing for pi's interactive mode.
//
// pi's per-tool "Took 0.2s" only measures the tool subprocess; nothing shows
// how long the agent has been working on the whole response. This extension:
//
//   1. Replaces the static "Working..." line with a live elapsed timer
//      ("Working... 2m 05s (esc to interrupt)").
//   2. When the run settles, prints a summary notice: worked time, turns,
//      and tool calls — like Codex's "Worked for 2m 03s".
//   3. Keeps the last run's time in the footer status bar.
//
// Time spent waiting on blocking extension UI prompts (e.g. the consult
// approval gate) is excluded: that is the human thinking, not the agent.

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const STATUS_ID = "worked-timer";

function formatDuration(ms: number): string {
	const totalSeconds = Math.max(0, Math.round(ms / 1000));
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const seconds = totalSeconds % 60;
	if (hours > 0) return `${hours}h ${minutes}m ${String(seconds).padStart(2, "0")}s`;
	if (minutes > 0) return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
	return `${seconds}s`;
}

export default function workedTimer(pi: ExtensionAPI) {
	let startedAt: number | undefined;
	let pausedMs = 0;
	let pauseStart: number | undefined;
	let turns = 0;
	let toolCalls = 0;
	let ticker: ReturnType<typeof setInterval> | undefined;

	function workedMs(): number {
		if (startedAt === undefined) return 0;
		const pausedNow = pauseStart !== undefined ? Date.now() - pauseStart : 0;
		return Date.now() - startedAt - pausedMs - pausedNow;
	}

	function stopTicker(ctx: ExtensionContext): void {
		if (ticker !== undefined) {
			clearInterval(ticker);
			ticker = undefined;
		}
		ctx.ui.setWorkingMessage(); // restore default
	}

	pi.on("agent_start", async (_event, ctx) => {
		if (ticker !== undefined) return; // continuation (retry/compaction) of the same run
		startedAt = Date.now();
		pausedMs = 0;
		pauseStart = undefined;
		turns = 0;
		toolCalls = 0;
		ticker = setInterval(() => {
			ctx.ui.setWorkingMessage(`Working... ${formatDuration(workedMs())} (esc to interrupt)`);
		}, 1000);
	});

	pi.on("turn_end", async () => {
		turns++;
	});

	pi.on("tool_execution_start", async () => {
		toolCalls++;
	});

	// Blocking extension prompts (consult approval, /geocine dialogs) are
	// user wait time, not agent work: pause the clock.
	pi.on("ui_prompt_start", async () => {
		if (startedAt !== undefined && pauseStart === undefined) pauseStart = Date.now();
	});
	pi.on("ui_prompt_end", async () => {
		if (pauseStart !== undefined) {
			pausedMs += Date.now() - pauseStart;
			pauseStart = undefined;
		}
	});

	pi.on("agent_settled", async (_event, ctx) => {
		if (startedAt === undefined) return;
		const worked = workedMs();
		stopTicker(ctx);
		startedAt = undefined;
		// Sub-5s runs are self-evident; do not add noise for them.
		if (worked >= 5000) {
			const parts = [`Worked for ${formatDuration(worked)}`];
			if (turns > 1) parts.push(`${turns} turns`);
			if (toolCalls > 0) parts.push(`${toolCalls} tool call${toolCalls === 1 ? "" : "s"}`);
			ctx.ui.notify(parts.join(" · "), "info");
		}
		ctx.ui.setStatus(STATUS_ID, `last run ${formatDuration(worked)}`);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		stopTicker(ctx);
		startedAt = undefined;
	});
}
