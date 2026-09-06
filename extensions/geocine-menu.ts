// /geocine — one hub menu for the whole plugin set.
//
// Everything custom lives behind a single command so the surface stays
// discoverable as it grows: consultants (inspect, set default, consult),
// watchdog and rescue-capture toggles, distilling the latest rescue,
// consult-log stats, lesson drafts, and direct config editing.
//
// Toggles write ~/.pi/agent/geocine.json. The other extensions re-read the
// config on every event, so changes apply immediately — no /reload. A
// project-level .pi/geocine.json still overrides the global file.
//
// Jump straight to a section: /geocine mode|consultants|approval|context|watchdog|rescue|data|distill|log|lessons|config

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	activeMode,
	CONFIG_FILE,
	type GeocineConfig,
	loadConfig,
	logDir,
	type ModeConfig,
	modeConsultants,
	setSessionMode,
	updateGlobalConfig,
} from "../lib/config.ts";
import { distillRescue, latestRescueRecord, LESSONS_DIR } from "../lib/distill.ts";

const SECTIONS = ["mode", "consultants", "approval", "context", "watchdog", "rescue", "data", "distill", "log", "lessons", "config"] as const;
type Section = (typeof SECTIONS)[number];

function onOff(v: boolean): string {
	return v ? "ON" : "OFF";
}

function describeMode(m: ModeConfig): string {
	const parts: string[] = [];
	if (m.description) parts.push(m.description);
	parts.push(m.consultants?.length ? m.consultants.join(", ") : "all consultants");
	parts.push(`prescreen ${m.prescreen ?? "per-consultant"}`);
	return parts.join(" · ");
}

const EXAMPLE_MODES = [
	'"mode": "coding",',
	'"modes": {',
	'  "coding":    { "description": "normal dev work", "consultants": ["frontier", "local-big"], "defaultConsultant": "frontier", "prescreen": "skip" },',
	'  "sensitive": { "description": "RE / sensitive content", "consultants": ["abliterated", "local-big"], "defaultConsultant": "abliterated", "prescreen": "force" }',
	"}",
].join("\n");

async function modeMenu(ctx: ExtensionContext, cfg: GeocineConfig): Promise<void> {
	// "$comment" and friends are JSON-comment convention keys, not modes.
	const modes = Object.entries(cfg.modes ?? {}).filter(([n]) => !n.startsWith("$"));
	if (modes.length === 0) {
		ctx.ui.notify(
			`No modes configured. A mode is a session profile: which consultants are selectable, who rescues by default, and whether staged consults get the guardrail prescreen. Add to ${CONFIG_FILE}:\n\n${EXAMPLE_MODES}`,
			"info",
		);
		return;
	}
	const active = activeMode(cfg);
	const labels = modes.map(([n, m]) => `${n === active?.name ? "* " : "  "}${n} — ${describeMode(m)}`);
	const NONE = `${active ? "  " : "* "}(no mode) — all consultants, per-consultant prescreen`;
	const picked = await ctx.ui.select(
		`Session mode (* = active${active?.sessionOverride ? ", session override" : ""}):`,
		[...labels, NONE],
	);
	if (!picked) return;
	const name = picked === NONE ? null : modes[labels.indexOf(picked)][0];
	const SESSION = "This session only";
	const PERSIST = "Save as default (geocine.json)";
	const scope = await ctx.ui.select(`Apply mode "${name ?? "none"}":`, [SESSION, PERSIST]);
	if (!scope) return;
	if (scope === SESSION) {
		setSessionMode(name);
		ctx.ui.notify(`Mode for this session: ${name ?? "none"}. (Config default returns next session.)`, "info");
	} else {
		setSessionMode(undefined);
		updateGlobalConfig((g) => {
			if (name) g.mode = name;
			else delete g.mode;
		});
		ctx.ui.notify(`Default mode: ${name ?? "none"} (persisted). Tip: pin a mode per project via .pi/geocine.json.`, "info");
	}
}

async function consultantsMenu(ctx: ExtensionContext, cfg: GeocineConfig): Promise<void> {
	const names = Object.keys(cfg.consultants);
	if (names.length === 0) {
		ctx.ui.notify(`No consultants configured. Edit ${CONFIG_FILE} (see /geocine config).`, "warning");
		return;
	}
	const labels = names.map((n) => {
		const c = cfg.consultants[n];
		const star = n === cfg.defaultConsultant ? "★ " : "  ";
		return `${star}${n} — ${c.role ?? `${c.provider ?? "?"}/${c.model}`} [${c.jail ?? "staged"}${c.prescreen ? ", prescreen" : ""}${c.autoApprove ? ", auto" : ""}]`;
	});
	const picked = await ctx.ui.select("Consultants (★ = default):", labels);
	if (!picked) return;
	const name = names[labels.indexOf(picked)];
	const c = cfg.consultants[name];

	const action = await ctx.ui.select(`${name}:`, [
		"Consult now…",
		name === cfg.defaultConsultant ? "(already default)" : "Set as default consultant",
		"Show details",
	]);
	if (action === "Consult now…") {
		ctx.ui.setEditorText(`/consult @${name} `);
	} else if (action === "Set as default consultant") {
		updateGlobalConfig((g) => {
			g.defaultConsultant = name;
		});
		ctx.ui.notify(`Default consultant: ${name}`, "info");
	} else if (action === "Show details") {
		ctx.ui.notify(
			[
				`${name}: ${c.provider ?? "(default provider)"}/${c.model}`,
				`jail: ${c.jail ?? "staged"} | prescreen: ${c.prescreen ? "yes" : "no"} | thinking: ${c.thinking ?? "default"}`,
				c.notes ? `notes: ${c.notes}` : "",
				c.envKeys?.length ? `env forwarded to docker: ${c.envKeys.join(", ")}` : "",
			]
				.filter(Boolean)
				.join("\n"),
			"info",
		);
	}
}

function logStats(ctx: ExtensionContext, cfg: GeocineConfig): void {
	const dir = logDir(cfg);
	const month = new Date().toISOString().slice(0, 7);
	const file = path.join(dir, `${month}.jsonl`);
	const counts: Record<string, number> = {};
	let total = 0;
	try {
		for (const line of fs.readFileSync(file, "utf8").split("\n")) {
			if (!line.trim()) continue;
			try {
				const r = JSON.parse(line);
				counts[r.type] = (counts[r.type] ?? 0) + 1;
				total++;
			} catch {
				// skip malformed line
			}
		}
	} catch {
		ctx.ui.notify(`No log for ${month} yet (${file}).`, "info");
		return;
	}
	const breakdown = Object.entries(counts)
		.sort((a, b) => b[1] - a[1])
		.map(([t, n]) => `${t}: ${n}`)
		.join(" | ");
	ctx.ui.notify(`consult-log ${month}: ${total} records\n${breakdown}\n${file}`, "info");
}

async function lessonsMenu(ctx: ExtensionContext): Promise<void> {
	let files: string[];
	try {
		files = fs
			.readdirSync(LESSONS_DIR)
			.filter((f) => f.endsWith(".md"))
			.sort()
			.reverse();
	} catch {
		files = [];
	}
	if (files.length === 0) {
		ctx.ui.notify(`No lesson drafts yet. Capture a rescue (switch local→frontier), then /distill.`, "info");
		return;
	}
	const picked = await ctx.ui.select("Lesson drafts (newest first):", files);
	if (!picked) return;
	const full = path.join(LESSONS_DIR, picked);
	const body = fs.readFileSync(full, "utf8");
	const title = /^# (.+)$/m.exec(body)?.[1] ?? picked;
	const action = await ctx.ui.select(title, ["Preview", "Paste into editor (to promote)", "Show path"]);
	if (action === "Preview") {
		ctx.ui.notify(body.slice(0, 1500), "info");
	} else if (action === "Paste into editor (to promote)") {
		ctx.ui.setEditorText(
			`Promote this lesson into the right place (AGENTS.md or a skill), then delete the draft ${full}:\n\n${body}`,
		);
	} else if (action === "Show path") {
		ctx.ui.notify(full, "info");
	}
}

async function editConfig(ctx: ExtensionContext): Promise<void> {
	let current = "";
	try {
		current = fs.readFileSync(CONFIG_FILE, "utf8");
	} catch {
		current = "{\n}\n";
	}
	const edited = await ctx.ui.editor(`Edit ${CONFIG_FILE}:`, current);
	if (edited === undefined || edited === current) return;
	try {
		JSON.parse(edited);
	} catch (err: any) {
		ctx.ui.notify(`Not saved — invalid JSON: ${err.message}`, "error");
		return;
	}
	fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
	fs.writeFileSync(CONFIG_FILE, edited, "utf8");
	ctx.ui.notify("Config saved. Applies immediately (extensions re-read it per event).", "info");
}

async function runSection(section: Section, ctx: ExtensionContext): Promise<void> {
	const cfg = loadConfig(ctx.cwd);
	switch (section) {
		case "mode":
			await modeMenu(ctx, cfg);
			return;
		case "data": {
			const latest = latestRescueRecord(cfg);
			const LOG = "Consult-log stats (this month)";
			const DISTILL = `Distill latest rescue${latest ? ` (${latest.toModel}, ${latest.ts.slice(0, 10)})` : " — none captured yet"}`;
			const LESSONS = "Lesson drafts";
			const picked = await ctx.ui.select("Training data:", [LOG, DISTILL, LESSONS]);
			if (picked === LOG) await runSection("log", ctx);
			else if (picked === DISTILL) await runSection("distill", ctx);
			else if (picked === LESSONS) await runSection("lessons", ctx);
			return;
		}
		case "consultants":
			await consultantsMenu(ctx, cfg);
			return;
		case "approval": {
			const autoApproved = Object.entries(cfg.consultants)
				.filter(([, c]) => c.autoApprove)
				.map(([n]) => n);
			const mode = cfg.approval?.consultTool ?? "ask";
			const options = [
				mode === "ask" ? "Switch to AUTO (never ask)" : "Switch to ASK (prompt per consult)",
				...autoApproved.map((n) => `Revoke always-allow for "${n}"`),
			];
			const picked = await ctx.ui.select(
				`Consult approval — mode: ${mode.toUpperCase()}${autoApproved.length ? `, always-allowed: ${autoApproved.join(", ")}` : ""}`,
				options,
			);
			if (!picked) return;
			if (picked.startsWith("Switch to")) {
				const next = mode === "ask" ? "auto" : "ask";
				updateGlobalConfig((g) => {
					g.approval = { ...(g.approval ?? {}), consultTool: next };
				});
				ctx.ui.notify(`Consult approval mode: ${next.toUpperCase()}`, "info");
			} else {
				const name = /"(.+)"/.exec(picked)?.[1];
				if (name) {
					updateGlobalConfig((g) => {
						if (g.consultants?.[name]) g.consultants[name].autoApprove = false;
					});
					ctx.ui.notify(`"${name}" will prompt again.`, "info");
				}
			}
			return;
		}
		case "context": {
			const c = cfg.context ?? {};
			const mode = c.mode ?? (c.checkpoint === false ? "off" : "arc");
			// pruner (ingestion-time, cache-neutral), recall, notes default ON.
			const state: Record<string, boolean> = {
				pruner: c.pruner !== false,
				recall: c.recall !== false,
				notes: c.notes !== false,
			};
			const rows = [
				`Compaction mode: ${mode.toUpperCase()} — cycle arc → checkpoint → off`,
				`Ingestion pruner (shell outputs): ${onOff(state.pruner)} — toggle`,
				`Recall tool: ${onOff(state.recall)} — toggle`,
				`Note tool + digest pinning: ${onOff(state.notes)} — toggle`,
			];
			const picked = await ctx.ui.select(
				`Context keeper (early compact: ${c.compactAtTokens ? `${c.compactAtTokens} tokens` : "pi default"}${c.idleCompactMinutes ? `, idle: ${c.idleCompactMinutes}m` : ""}):`,
				rows,
			);
			if (!picked) return;
			if (picked.startsWith("Compaction mode")) {
				const next = mode === "arc" ? "checkpoint" : mode === "checkpoint" ? "off" : "arc";
				updateGlobalConfig((g) => {
					g.context = { ...(g.context ?? {}), mode: next };
					delete g.context.checkpoint; // retire the legacy boolean
				});
				ctx.ui.notify(`context.mode: ${next} (persisted)`, "info");
				return;
			}
			const key = picked.startsWith("Ingestion") ? "pruner" : picked.startsWith("Note") ? "notes" : "recall";
			const next = !state[key];
			updateGlobalConfig((g) => {
				g.context = { ...(g.context ?? {}), [key]: next };
			});
			ctx.ui.notify(`context.${key}: ${onOff(next)} (persisted)`, "info");
			return;
		}
		case "watchdog": {
			const next = cfg.watchdog?.enabled === false;
			updateGlobalConfig((g) => {
				g.watchdog = { ...(g.watchdog ?? {}), enabled: next };
			});
			ctx.ui.notify(`watchdog: ${onOff(next)} (persisted; /watchdog on|off is the session-only switch)`, "info");
			return;
		}
		case "rescue": {
			const next = cfg.rescue?.enabled === false;
			updateGlobalConfig((g) => {
				g.rescue = { ...(g.rescue ?? {}), enabled: next };
			});
			ctx.ui.notify(`rescue capture: ${onOff(next)} (persisted)`, "info");
			return;
		}
		case "distill": {
			const record = latestRescueRecord(cfg);
			if (!record) {
				ctx.ui.notify("No rescue episode in the consult-log yet.", "info");
				return;
			}
			const ok = await ctx.ui.confirm(
				"Distill latest rescue?",
				`${record.fromModel} → ${record.toModel} (${record.ts})\n${record.filesTouched.join(", ") || "no files"}`,
			);
			if (!ok) return;
			ctx.ui.setStatus("geocine", "distilling…");
			const outcome = await distillRescue(cfg, record, ctx.cwd);
			ctx.ui.setStatus("geocine", undefined);
			ctx.ui.notify(outcome.message, outcome.ok ? "info" : "error");
			return;
		}
		case "log":
			logStats(ctx, cfg);
			return;
		case "lessons":
			await lessonsMenu(ctx);
			return;
		case "config":
			await editConfig(ctx);
			return;
	}
}

export default function geocineMenu(pi: ExtensionAPI) {
	pi.registerCommand("geocine", {
		description: "geocine-pi hub: session mode, consultants, approval, context keeper, watchdog/rescue, training data, config",
		getArgumentCompletions: (prefix: string) => {
			const items = SECTIONS.filter((s) => s.startsWith(prefix.toLowerCase())).map((s) => ({
				value: s,
				label: s,
			}));
			return items.length > 0 ? items : null;
		},
		handler: async (args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("/geocine needs the interactive TUI.", "error");
				return;
			}
			const jump = String(args ?? "").trim().toLowerCase() as Section;
			if (SECTIONS.includes(jump)) {
				await runSection(jump, ctx);
				return;
			}
			// Hub loop: stay in the menu until cancel/escape. Every row is
			// "Thing: current state" so the hub doubles as a status readout.
			for (;;) {
				const cfg = loadConfig(ctx.cwd);
				const active = activeMode(cfg);
				const pool = Object.keys(modeConsultants(cfg));
				const total = Object.keys(cfg.consultants).length;
				const defaultName = active?.mode.defaultConsultant ?? cfg.defaultConsultant ?? "none";
				const approvalMode = cfg.approval?.consultTool ?? "ask";
				const contextMode = cfg.context?.mode ?? (cfg.context?.checkpoint === false ? "off" : "arc");
				const entries: Array<{ label: string; section: Section }> = [
					{
						label: active
							? `Mode: ${active.name}${active.sessionOverride ? " (this session)" : ""} — ${describeMode(active.mode)}`
							: `Mode: none — all consultants, per-consultant prescreen`,
						section: "mode",
					},
					{
						label: `Consultants: ${pool.length < total ? `${pool.length} of ${total} in mode` : total} · default: ${defaultName}`,
						section: "consultants",
					},
					{
						label:
							approvalMode === "ask"
								? `Consult approval: ASK — prompts before LLM-invoked consults${Object.values(cfg.consultants).some((c) => c.autoApprove) ? " (some always-allowed)" : ""}`
								: "Consult approval: AUTO — LLM consults run without asking",
						section: "approval",
					},
					{
						label: `Context keeper: ${contextMode.toUpperCase()} · pruner ${onOff(cfg.context?.pruner !== false)} · recall ${onOff(cfg.context?.recall !== false)}`,
						section: "context",
					},
					{
						label: `Watchdog: ${onOff(cfg.watchdog?.enabled !== false)} — select to turn ${cfg.watchdog?.enabled !== false ? "OFF" : "ON"}`,
						section: "watchdog",
					},
					{
						label: `Rescue capture: ${onOff(cfg.rescue?.enabled !== false)} — select to turn ${cfg.rescue?.enabled !== false ? "OFF" : "ON"}`,
						section: "rescue",
					},
					{ label: "Training data: consult-log stats · rescue distill · lessons", section: "data" },
					{ label: "Edit geocine.json", section: "config" },
				];
				const picked = await ctx.ui.select("geocine-pi:", entries.map((e) => e.label));
				if (!picked) return;
				const section = entries.find((e) => e.label === picked)!.section;
				await runSection(section, ctx);
				if (section === "consultants" || section === "config") return;
			}
		},
	});
}
