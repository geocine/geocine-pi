// rescue: capture manual local→frontier rescue episodes as training data.
//
// The pattern this records: the local model is grinding on something and
// failing, the user explicitly /model-switches to a frontier model, the
// frontier model fixes it, and the session switches back (or ends). Each
// such episode is the single highest-value training pair this setup
// produces: (task + local model's failing tail) → (what the strong model
// actually did).
//
// Capture is automatic and passive. On episode end a `rescue` record lands
// in the consult-log with the decision-time failure digest, the rescuer's
// tool trajectory, touched files, and its own final summary.
//
// /distill [--last] then turns the newest episode into a DRAFT lesson under
// ~/.pi/agent/rescue-lessons/. Drafts are never loaded into any prompt —
// promoting one into AGENTS.md or a skill is a deliberate human step
// (aiterator's rules-store discipline: the prompt never grows without a
// human decision).
//
// Historical sessions are mined separately: scripts/mine-rescues.mjs walks
// ~/.pi/agent/sessions/*.jsonl, which stamps every model change and every
// assistant message with its model.

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DEFAULT_LOCAL_PROVIDERS, loadConfig, logDir } from "../lib/config.ts";
import { appendRecord, newCid, nowIso, type RescueRecord, type RescueToolEvent } from "../lib/consult-log.ts";
import { distillRescue, latestRescueRecord } from "../lib/distill.ts";

const MAX_TOOL_EVENTS = 60;

interface Episode {
	cid: string;
	startedTs: string;
	fromModel: string;
	toModel: string;
	failureDigest: string;
	toolEvents: RescueToolEvent[];
	filesTouched: Set<string>;
	rescuerTurns: number;
	rescuerFailedCalls: number;
	rescuerSummary: string;
}

function modelId(model: any): string {
	if (!model) return "unknown";
	return `${model.provider ?? "?"}/${model.id ?? model.modelId ?? "?"}`;
}

function isLocal(model: any, localProviders: string[]): boolean {
	return localProviders.includes(String(model?.provider ?? ""));
}

function previewToolInput(toolName: string, input: any): string {
	if (toolName === "bash" && typeof input?.command === "string") return input.command.slice(0, 120);
	const p = input?.path ?? input?.file_path;
	if (typeof p === "string") return `${toolName} ${p}`.slice(0, 120);
	return `${toolName} ${JSON.stringify(input ?? {}).slice(0, 100)}`;
}

/** Compact digest of the session tail: what the local model was failing at. */
function buildFailureDigest(ctx: ExtensionContext): string {
	const lines: string[] = [];
	try {
		const entries = (ctx.sessionManager as any).getEntries?.() ?? [];
		const tail = entries.slice(-30);
		for (const entry of tail) {
			if (entry.type !== "message" || !entry.message) continue;
			const m = entry.message;
			if (m.role === "user") {
				const text = (m.content ?? [])
					.filter((c: any) => c.type === "text")
					.map((c: any) => c.text)
					.join(" ");
				if (text && !text.startsWith("[watchdog]")) lines.push(`USER: ${text.slice(0, 300)}`);
			} else if (m.role === "assistant") {
				for (const c of m.content ?? []) {
					if (c.type === "text" && c.text?.trim()) lines.push(`ASSISTANT: ${c.text.slice(0, 200)}`);
					else if (c.type === "toolCall") lines.push(`CALL: ${previewToolInput(c.name, c.arguments)}`);
				}
			} else if (m.role === "toolResult") {
				const text = (m.content ?? [])
					.filter((c: any) => c.type === "text")
					.map((c: any) => c.text)
					.join(" ");
				lines.push(`${m.isError ? "FAIL" : "ok"}: ${text.slice(0, m.isError ? 300 : 120)}`);
			}
		}
	} catch {
		lines.push("(failure digest unavailable)");
	}
	// Keep the most recent ~4KB.
	let digest = lines.join("\n");
	if (digest.length > 4096) digest = digest.slice(digest.length - 4096);
	return digest;
}

export default function rescue(pi: ExtensionAPI) {
	let episode: Episode | undefined;
	let lastRecord: RescueRecord | undefined;

	function finishEpisode(ctx: ExtensionContext, endedBy: "switch_back" | "session_end"): void {
		if (!episode) return;
		const cfg = loadConfig(ctx.cwd);
		const record: RescueRecord = {
			type: "rescue",
			cid: episode.cid,
			ts: nowIso(),
			cwd: ctx.cwd,
			mainModel: episode.fromModel,
			fromModel: episode.fromModel,
			toModel: episode.toModel,
			failureDigest: episode.failureDigest,
			toolEvents: episode.toolEvents,
			filesTouched: [...episode.filesTouched],
			rescuerTurns: episode.rescuerTurns,
			rescuerFailedCalls: episode.rescuerFailedCalls,
			rescuerSummary: episode.rescuerSummary.slice(0, 4000),
			endedBy,
			startedTs: episode.startedTs,
		};
		appendRecord(logDir(cfg), record);
		lastRecord = record;
		const summary = `rescue episode captured: ${episode.fromModel} → ${episode.toModel}, ${episode.rescuerTurns} turns, ${episode.filesTouched.size} file(s) touched`;
		episode = undefined;
		try {
			ctx.ui.setStatus("rescue", undefined);
			ctx.ui.notify(`${summary}. Run /distill to draft a lesson from it.`, "info");
		} catch {
			// headless
		}
	}

	pi.on("model_select", async (event: any, ctx) => {
		const cfg = loadConfig(ctx.cwd);
		if (cfg.rescue?.enabled === false) return;
		const localProviders = cfg.rescue?.localProviders ?? DEFAULT_LOCAL_PROVIDERS;
		const prev = event.previousModel;
		const next = event.model;
		if (!prev || !next) return;

		if (episode && isLocal(next, localProviders)) {
			// Back to a local model: the rescue is over.
			finishEpisode(ctx, "switch_back");
			return;
		}
		if (!episode && isLocal(prev, localProviders) && !isLocal(next, localProviders)) {
			// Local → frontier: start capturing.
			episode = {
				cid: newCid(),
				startedTs: nowIso(),
				fromModel: modelId(prev),
				toModel: modelId(next),
				failureDigest: buildFailureDigest(ctx),
				toolEvents: [],
				filesTouched: new Set(),
				rescuerTurns: 0,
				rescuerFailedCalls: 0,
				rescuerSummary: "",
			};
			try {
				ctx.ui.setStatus("rescue", `rescue: recording ${episode.toModel}`);
			} catch {
				// headless
			}
		}
	});

	pi.on("tool_result", async (event: any) => {
		if (!episode) return;
		if (episode.toolEvents.length < MAX_TOOL_EVENTS) {
			episode.toolEvents.push({
				tool: event.toolName,
				ok: !event.isError,
				preview: previewToolInput(event.toolName, event.input),
			});
		}
		if (event.isError) episode.rescuerFailedCalls++;
		if (event.toolName === "write" || event.toolName === "edit") {
			const p = event.input?.path ?? event.input?.file_path;
			if (typeof p === "string") episode.filesTouched.add(p);
		}
	});

	pi.on("turn_end", async (event: any) => {
		if (!episode) return;
		episode.rescuerTurns++;
		const msg = event.message;
		if (msg?.role === "assistant") {
			for (const c of msg.content ?? []) {
				if (c.type === "text" && c.text?.trim()) episode.rescuerSummary = c.text;
			}
		}
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		if (episode) finishEpisode(ctx, "session_end");
	});

	pi.registerCommand("distill", {
		description: "Draft a reusable lesson from the latest rescue episode (written to ~/.pi/agent/rescue-lessons/, never auto-loaded)",
		handler: async (_args, ctx) => {
			const cfg = loadConfig(ctx.cwd);
			const record = lastRecord ?? latestRescueRecord(cfg);
			if (!record) {
				ctx.ui.notify("No rescue episode found (neither this session nor the consult-log).", "error");
				return;
			}
			ctx.ui.setStatus("rescue", "distilling…");
			const outcome = await distillRescue(cfg, record, ctx.cwd);
			ctx.ui.setStatus("rescue", undefined);
			ctx.ui.notify(outcome.message, outcome.ok ? "info" : "error");
		},
	});
}
