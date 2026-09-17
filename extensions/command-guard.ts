// command-guard: the fabric's "risky?" node for shell commands.
//
// A deterministic prefilter catches destructive-looking commands
// (recursive deletes, hard resets, force pushes, DROP TABLE, ...) — rare
// enough that the judge only ever sees suspects, so the hot path pays no
// latency. The judge then answers one question with the task as context:
// does this command serve the task, or is it likely collateral damage?
// Confident collateral damage is blocked via the tool_call event; the
// model sees the reason and must adjust or ask the user (ask_user tool).
//
// Degradation: no judge configured, timeout, or rate cap = allow — pi's
// own tool-approval flow remains the real gate. This node only ADDS a
// task-aware check on top; it never replaces pi's permissions. Every
// judged command is a GuardRecord for the flywheel.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadConfig, logDir } from "../lib/config.ts";
import { appendRecord, newCid, nowIso } from "../lib/consult-log.ts";
import { judge, noulOf, resolveJudge } from "../lib/judge/index.ts";

/**
 * Clearly destructive shapes only — a false positive here costs one judge
 * call (~200 ms), a broad pattern would add latency to routine commands.
 */
const DESTRUCTIVE: RegExp[] = [
	/\brm\s+-\w*(r\w*f|f\w*r)\w*\b/i, // rm -rf, -fr, -rvf, ...
	/\brm\s+-\w*r\w*\s+("?\/|[a-z]:|\*|~)/i, // rm -r on absolute path, drive, wildcard, home
	/\bgit\s+reset\s+--hard\b/,
	/\bgit\s+clean\s+-[a-z]*f/,
	/\bgit\s+(checkout|restore)\s+(--\s+)?(\.|\*)(\s|$)/,
	/\bgit\s+push\s+.*(--force\b|-f\b)/,
	/\bgit\s+branch\s+-D\b/,
	/\bgit\s+stash\s+(drop|clear)\b/,
	/\b(rd|rmdir)\s+\/s\b/i,
	/\bdel\s+(\/[a-z]\s+)*\/s\b/i,
	/remove-item\s+.*-recurse.*-force|remove-item\s+.*-force.*-recurse/i,
	/\bmkfs\b|\bdiskpart\b|\bformat\s+[a-z]:/i,
	/\bdd\s+.*of=\/dev\//,
	/\bdrop\s+(table|database|schema)\b/i,
	/\btruncate\s+table\b/i,
	/\bchmod\s+-R\s+777\b/,
];

export default function commandGuard(pi: ExtensionAPI) {
	let lastUserMessage = "";

	pi.on("input", async (event) => {
		const text = typeof (event as { text?: unknown }).text === "string" ? (event as { text: string }).text : "";
		if (text && !text.startsWith("/")) lastUserMessage = text;
	});

	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== "bash" && event.toolName !== "powershell") return;
		const command = typeof (event.input as { command?: unknown })?.command === "string"
			? (event.input as { command: string }).command
			: "";
		if (!command || !DESTRUCTIVE.some((p) => p.test(command))) return;

		const cfg = loadConfig(ctx.cwd);
		if (cfg.guard?.enabled === false) return;
		if (!resolveJudge(cfg.judge)) return; // degrade: pi's approval flow is the gate

		const result = await judge(
			cfg.judge,
			{
				state: {
					command,
					task: lastUserMessage.slice(0, 1000) || "(unknown)",
					cwd: ctx.cwd,
				},
				questions: {
					risky: {
						type: "noul",
						instructions:
							"The coding agent wants to run `command` in `cwd` while working on `task`. Would executing it risk destroying work or state BEYOND what the task plainly requires? A destructive command the task itself asks for (e.g. the task says to reset or delete) is not collateral damage; broad recursive deletes, hard resets, or force pushes nobody asked for are.",
						criteria: {
							true: "Likely collateral damage — the task does not require this destruction",
							false: "Serves the task, or is safely scoped to throwaway state",
						},
					},
				},
			},
			{ node: "guard", timeoutMs: 2500 },
		);
		const riskyP = noulOf(result, "risky");
		const threshold = cfg.guard?.blockThreshold ?? 0.8;
		const blocked = riskyP !== undefined && riskyP >= threshold;

		appendRecord(logDir(cfg), {
			type: "guard",
			cid: newCid(),
			ts: nowIso(),
			cwd: ctx.cwd,
			command: command.slice(0, 300),
			task: lastUserMessage.slice(0, 200),
			riskyP,
			blocked,
			tool: event.toolName,
		});

		if (!blocked) return;
		ctx.ui.setStatus("guard", `guard: blocked destructive command (p=${riskyP.toFixed(2)})`);
		return {
			block: true,
			reason:
				`[command-guard] Blocked: this command looks like collateral damage the task does not require (risk ${riskyP.toFixed(2)}). ` +
				`Do not retry it as-is. Either scope it down to exactly what the task needs, or ask the user for explicit approval first (ask_user tool), stating what would be destroyed and why.`,
		};
	});
}
