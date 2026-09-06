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
import { richSelect, type SelectItem } from "../lib/rich-select.ts";

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
	const NONE_VALUE = "\u0000none";
	const items: SelectItem[] = modes.map(([n, m]) => ({
		value: n,
		label: `${n === active?.name ? "* " : "  "}${n}`,
		description: describeMode(m),
	}));
	items.push({
		value: NONE_VALUE,
		label: `${active ? "  " : "* "}(no mode)`,
		description: "all consultants · per-consultant prescreen",
	});
	const picked = await richSelect(
		ctx,
		`Session mode (* = active${active?.sessionOverride ? ", session override" : ""})`,
		items,
	);
	if (!picked) return;
	const name = picked === NONE_VALUE ? null : picked;
	const scope = await richSelect(ctx, `Apply mode "${name ?? "none"}"`, [
		{ value: "session", label: "This session", description: "config default returns next session" },
		{ value: "persist", label: "Save as default", description: "writes geocine.json (project pins still win)" },
	]);
	if (!scope) return;
	if (scope === "session") {
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
	const active = activeMode(cfg);
	const pool = modeConsultants(cfg);
	const defaultName = active?.mode.defaultConsultant ?? cfg.defaultConsultant;
	const items: SelectItem[] = names.map((n) => {
		const c = cfg.consultants[n];
		const flags = [
			`${c.provider ?? "?"}/${c.model}`,
			c.jail ?? "staged",
			c.prescreen ? "prescreen" : "",
			c.autoApprove ? "auto-approved" : "",
			active && !pool[n] ? `NOT in mode ${active.name}` : "",
		]
			.filter(Boolean)
			.join(" · ");
		return {
			value: n,
			label: `${n === defaultName ? "* " : "  "}${n}`,
			description: `${c.role ?? "general consultant"} — ${flags}`,
		};
	});
	const name = await richSelect(ctx, "Consultants (* = default rescuer)", items);
	if (!name) return;
	const c = cfg.consultants[name];

	const actions: SelectItem[] = [
		{ value: "consult", label: "Consult now", description: `prefill "/consult @${name} " in the editor` },
		...(name === cfg.defaultConsultant
			? []
			: [{ value: "default", label: "Set as default", description: "used when no rescuer is named" }]),
		{ value: "details", label: "Show details", description: "provider, jail, prescreen, notes" },
	];
	const action = await richSelect(ctx, name, actions, {
		header: [c.role ?? "general consultant"],
	});
	if (action === "consult") {
		ctx.ui.setEditorText(`/consult @${name} `);
	} else if (action === "default") {
		updateGlobalConfig((g) => {
			g.defaultConsultant = name;
		});
		ctx.ui.notify(`Default consultant: ${name}`, "info");
	} else if (action === "details") {
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
	const items: SelectItem[] = files.map((f) => {
		let title: string | undefined;
		try {
			title = /^# (.+)$/m.exec(fs.readFileSync(path.join(LESSONS_DIR, f), "utf8"))?.[1];
		} catch {
			// unreadable draft; show the filename alone
		}
		return { value: f, label: f.replace(/\.md$/, ""), description: title ?? "" };
	});
	const picked = await richSelect(ctx, "Lesson drafts (newest first)", items);
	if (!picked) return;
	const full = path.join(LESSONS_DIR, picked);
	const body = fs.readFileSync(full, "utf8");
	const title = /^# (.+)$/m.exec(body)?.[1] ?? picked;
	const action = await richSelect(ctx, title, [
		{ value: "preview", label: "Preview", description: "first 1500 chars" },
		{ value: "promote", label: "Promote", description: "paste into the editor to move it into AGENTS.md or a skill" },
		{ value: "path", label: "Show path", description: full },
	]);
	if (action === "preview") {
		ctx.ui.notify(body.slice(0, 1500), "info");
	} else if (action === "promote") {
		ctx.ui.setEditorText(
			`Promote this lesson into the right place (AGENTS.md or a skill), then delete the draft ${full}:\n\n${body}`,
		);
	} else if (action === "path") {
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
			const picked = await richSelect(ctx, "Training data", [
				{ value: "log", label: "Consult-log", description: "record counts for this month" },
				{
					value: "distill",
					label: "Distill rescue",
					description: latest ? `latest: ${latest.toModel}, ${latest.ts.slice(0, 10)}` : "none captured yet",
				},
				{ value: "lessons", label: "Lesson drafts", description: "preview or promote distilled lessons" },
			]);
			if (picked === "log" || picked === "distill" || picked === "lessons") await runSection(picked, ctx);
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
			const items: SelectItem[] = [
				{
					value: "switch",
					label: `Switch to ${mode === "ask" ? "AUTO" : "ASK"}`,
					description:
						mode === "ask" ? "LLM-invoked consults run without asking" : "prompt before every LLM-invoked consult",
				},
				...autoApproved.map((n) => ({
					value: `revoke:${n}`,
					label: `Revoke ${n}`,
					description: "this always-allowed consultant prompts again",
				})),
			];
			const picked = await richSelect(ctx, `Consult approval — currently ${mode.toUpperCase()}`, items);
			if (!picked) return;
			if (picked === "switch") {
				const next = mode === "ask" ? "auto" : "ask";
				updateGlobalConfig((g) => {
					g.approval = { ...(g.approval ?? {}), consultTool: next };
				});
				ctx.ui.notify(`Consult approval mode: ${next.toUpperCase()}`, "info");
			} else {
				const name = picked.slice("revoke:".length);
				updateGlobalConfig((g) => {
					if (g.consultants?.[name]) g.consultants[name].autoApprove = false;
				});
				ctx.ui.notify(`"${name}" will prompt again.`, "info");
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
			const picked = await richSelect(
				ctx,
				"Context keeper",
				[
					{
						value: "cycle",
						label: "Compaction",
						description: `${mode.toUpperCase()} — enter cycles arc -> checkpoint -> off`,
					},
					{
						value: "pruner",
						label: "Pruner",
						description: `${onOff(state.pruner)} — trims oversized shell outputs at ingestion · enter toggles`,
					},
					{
						value: "recall",
						label: "Recall tool",
						description: `${onOff(state.recall)} — transcript search + entry read-back · enter toggles`,
					},
					{
						value: "notes",
						label: "Note tool",
						description: `${onOff(state.notes)} — model notes pinned verbatim into digests · enter toggles`,
					},
				],
				{
					header: [
						`early compact: ${c.compactAtTokens ? `${c.compactAtTokens} tokens` : "pi default"}${c.idleCompactMinutes ? ` · idle: ${c.idleCompactMinutes}m` : ""}`,
					],
				},
			);
			if (!picked) return;
			if (picked === "cycle") {
				const next = mode === "arc" ? "checkpoint" : mode === "checkpoint" ? "off" : "arc";
				updateGlobalConfig((g) => {
					g.context = { ...(g.context ?? {}), mode: next };
					delete g.context.checkpoint; // retire the legacy boolean
				});
				ctx.ui.notify(`context.mode: ${next} (persisted)`, "info");
				return;
			}
			const key = picked as "pruner" | "recall" | "notes";
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
			// Hub loop: stay in the menu until cancel/escape. Rendered as a
			// two-column panel (richSelect): setting name left, current state
			// right — the hub doubles as a status readout.
			for (;;) {
				const cfg = loadConfig(ctx.cwd);
				const active = activeMode(cfg);
				const pool = Object.keys(modeConsultants(cfg));
				const total = Object.keys(cfg.consultants).length;
				const defaultName = active?.mode.defaultConsultant ?? cfg.defaultConsultant ?? "none";
				const approvalMode = cfg.approval?.consultTool ?? "ask";
				const contextMode = cfg.context?.mode ?? (cfg.context?.checkpoint === false ? "off" : "arc");
				const watchdogOn = cfg.watchdog?.enabled !== false;
				const rescueOn = cfg.rescue?.enabled !== false;
				const items: Array<SelectItem & { value: Section }> = [
					{
						value: "mode",
						label: "Mode",
						description: active
							? `${active.name}${active.sessionOverride ? " (this session)" : ""} — ${describeMode(active.mode)}`
							: "none — all consultants · per-consultant prescreen",
					},
					{
						value: "consultants",
						label: "Consultants",
						description: `${pool.length < total ? `${pool.length} of ${total} in mode` : total} · default ${defaultName}`,
					},
					{
						value: "approval",
						label: "Approval",
						description:
							approvalMode === "ask"
								? `ASK — prompts before LLM-invoked consults${Object.values(cfg.consultants).some((c) => c.autoApprove) ? " (some always-allowed)" : ""}`
								: "AUTO — LLM consults run without asking",
					},
					{
						value: "context",
						label: "Context keeper",
						description: `${contextMode.toUpperCase()} · pruner ${onOff(cfg.context?.pruner !== false)} · recall ${onOff(cfg.context?.recall !== false)}${cfg.context?.compactAtTokens ? ` · compact at ${Math.round(cfg.context.compactAtTokens / 1000)}k` : ""}`,
					},
					{
						value: "watchdog",
						label: "Watchdog",
						description: `${onOff(watchdogOn)} — enter turns ${watchdogOn ? "OFF" : "ON"}`,
					},
					{
						value: "rescue",
						label: "Rescue capture",
						description: `${onOff(rescueOn)} — enter turns ${rescueOn ? "OFF" : "ON"}`,
					},
					{
						value: "data",
						label: "Training data",
						description: "consult-log stats · rescue distill · lesson drafts",
					},
					{ value: "config", label: "Config", description: `edit ${CONFIG_FILE}` },
				];
				const picked = (await richSelect(ctx, "geocine-pi", items)) as Section | undefined;
				if (!picked) return;
				await runSection(picked, ctx);
				if (picked === "consultants" || picked === "config") return;
			}
		},
	});
}
