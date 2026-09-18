// /geocine — one hub menu for the whole plugin set.
//
// Everything custom lives behind a single command so the surface stays
// discoverable as it grows: models (inspect, set default, consult),
// watchdog and rescue-capture toggles, distilling the latest rescue,
// consult-log stats, lesson drafts, and direct config editing.
//
// Toggles write ~/.pi/agent/geocine.json. The other extensions re-read the
// config on every event, so changes apply immediately — no /reload. A
// project-level .pi/geocine.json still overrides the global file.
//
// Jump straight to a section: /geocine models|approval|context|watchdog|judge|rescue|data|distill|log|lessons|config

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	Container,
	type SettingItem,
	SettingsList,
	type SettingsListTheme,
	Text,
} from "@earendil-works/pi-tui";
import { offlineModels } from "../lib/availability.ts";
import {
	CONFIG_FILE,
	modelHandle,
	modelLabel,
	DEFAULT_CONTEXT_PROVIDERS,
	defaultModelName,
	type GeocineConfig,
	loadConfig,
	logDir,
	updateGlobalConfig,
} from "../lib/config.ts";
import { distillRescue, latestRescueRecord, LESSONS_DIR } from "../lib/distill.ts";
import { judgeFabricStats, judgeStatus, modelBaseUrl } from "../lib/judge/index.ts";
import { richSelect, type SelectItem } from "../lib/rich-select.ts";
import { harnessHubLine, harnessMenu } from "./models/index.ts";

const SECTIONS = ["models", "approval", "context", "harness", "watchdog", "judge", "rescue", "data", "distill", "log", "lessons", "config"] as const;
type Section = (typeof SECTIONS)[number];

function onOff(v: boolean): string {
	return v ? "ON" : "OFF";
}

async function modelsMenu(ctx: ExtensionContext, cfg: GeocineConfig): Promise<void> {
	const names = Object.keys(cfg.models);
	if (names.length === 0) {
		ctx.ui.notify(`No models configured. Edit ${CONFIG_FILE} (see /geocine config).`, "warning");
		return;
	}
	const defaultName = defaultModelName(cfg);
	const offline = await offlineModels(cfg.models, ctx.modelRegistry);
	const items: SelectItem[] = names.map((n) => {
		const c = cfg.models[n];
		const flags = [
			offline.has(n) ? "OFFLINE" : "",
			`{${c.classes?.join(", ") || "unclassed"}}`,
			c.rank !== undefined ? `rank ${c.rank}` : "",
			c.jail ?? "staged",
			c.prescreen ? "prescreen" : "",
			c.autoApprove ? "auto-approved" : "",
		]
			.filter(Boolean)
			.join(" · ");
		return {
			value: n,
			label: `${n === defaultName ? "* " : "  "}${modelLabel(c)}`,
			description: `${c.role ?? "general consultant"} — ${flags}`,
		};
	});
	const name = await richSelect(ctx, "Models (* = default rescuer)", items, {
		header: offline.size > 0 ? [...offline].map(([n, why]) => `offline: ${n} — ${why}`) : undefined,
	});
	if (!name) return;
	const c = cfg.models[name];
	const handle = modelHandle(cfg, name);

	const actions: SelectItem[] = [
		{ value: "consult", label: "Consult now", description: `prefill "/consult @${handle} " in the editor` },
		...(c.classes?.includes("default")
			? []
			: [{ value: "default", label: "Set as default", description: 'moves the "default" class here (used when nothing else picks)' }]),
		{ value: "details", label: "Show details", description: "provider, jail, prescreen, notes" },
	];
	const action = await richSelect(ctx, modelLabel(c), actions, {
		header: [c.role ?? "general consultant"],
	});
	if (action === "consult") {
		ctx.ui.setEditorText(`/consult @${handle} `);
	} else if (action === "default") {
		updateGlobalConfig((g) => {
			for (const [n, cc] of Object.entries(g.models ?? {})) {
				if (n === name) cc.classes = [...new Set([...(cc.classes ?? []), "default"])];
				else if (cc.classes?.includes("default")) cc.classes = cc.classes.filter((cls) => cls !== "default");
			}
		});
		ctx.ui.notify(`Default rescuer: ${modelLabel(c)} (carries the "default" class now)`, "info");
	} else if (action === "details") {
		ctx.ui.notify(
			[
				`${modelLabel(c)} {${c.classes?.join(", ") || "unclassed"}}`,
				`jail: ${c.jail ?? "staged"} | prescreen: ${c.prescreen ? "yes" : "no"} | thinking: ${c.thinking ?? "default"}`,
				c.notes ? `notes: ${c.notes}` : "",
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

// Hub sections that leave the panel to run their own flow (richSelect
// chains, the config editor). Everything else changes in place.
type HubExit = "models" | "harness" | "data" | "config";

function onOffValue(v: boolean): string {
	return v ? "ON" : "OFF";
}

function contextSummary(cfg: GeocineConfig): string {
	const c = cfg.context ?? {};
	const mode = c.mode ?? (c.checkpoint === false ? "off" : "arc");
	return `${mode.toUpperCase()} · pruner ${onOffValue(c.pruner !== false)} · recall ${onOffValue(c.recall !== false)}`;
}

/**
 * The /geocine hub as a persistent settings panel (same machinery as pi's
 * /settings): enter cycles a row's value IN PLACE and the cursor stays on
 * the row — no close-and-reopen, so the selection never jumps back to the
 * top. Approval and the context keeper are nested submenus; SettingsList
 * restores the cursor to their row when they close. Only the rows returned
 * as HubExit close the panel, because their flows need the full screen.
 */
async function hubPanel(ctx: ExtensionContext, initial?: Section): Promise<HubExit | null> {
	const cfg = loadConfig(ctx.cwd);
	const total = Object.keys(cfg.models).length;
	const defaultName = defaultModelName(cfg);
	const defaultLabel = defaultName ? modelLabel(cfg.models[defaultName]) : "none";
	const approvalMode = cfg.approval?.consultTool ?? "ask";
	const autoApproved = Object.entries(cfg.models)
		.filter(([, c]) => c.autoApprove)
		.map(([n]) => n);

	return await ctx.ui.custom<HubExit | null>((tui, theme, _keybindings, done) => {
		const listTheme: SettingsListTheme = {
			label: (t, selected) => (selected ? theme.fg("accent", theme.bold(t)) : t),
			value: (t, selected) => (selected ? theme.fg("accent", t) : theme.fg("muted", t)),
			description: (t) => theme.fg("muted", t),
			cursor: theme.fg("accent", "> "),
			hint: (t) => theme.fg("dim", t),
		};

		// A submenu is a heading + its own SettingsList; input goes to the
		// list (the outer list delegates while a submenu is open).
		function submenu(title: string, items: SettingItem[], onChange: (id: string, value: string) => void, onClose: () => void): Component {
			const box = new Container();
			box.addChild(new Text(theme.fg("accent", theme.bold(title))));
			const list = new SettingsList(items, Math.min(items.length, 10), listTheme, onChange, onClose);
			box.addChild(list);
			return {
				render: (width: number) => box.render(width),
				invalidate: () => box.invalidate(),
				handleInput: (data: string) => list.handleInput(data),
			};
		}

		const items: SettingItem[] = [
			{
				id: "models",
				label: "Models",
				currentValue: `${total} registered · default ${defaultLabel}`,
				values: [`${total} registered · default ${defaultLabel}`],
				description: "Inspect, consult, or set the default rescuer (opens the model list)",
			},
			{
				id: "approval",
				label: "Approval",
				currentValue: approvalMode.toUpperCase(),
				description:
					"Gate for LLM-invoked consults: ask prompts, judge auto-approves clear consults, auto never asks. Enter opens; always-allowed models can be revoked there.",
				submenu: (_currentValue, close) => {
					let mode = cfg.approval?.consultTool ?? "ask";
					const subItems: SettingItem[] = [
						{
							id: "mode",
							label: "Mode",
							currentValue: mode,
							values: ["ask", "judge", "auto"],
							description:
								"ask: prompt before every LLM-invoked consult · judge: fabric auto-approves clear consults, asks when unsure · auto: never asks",
						},
						...autoApproved.map((n) => ({
							id: `revoke:${n}`,
							label: n,
							currentValue: "always-allowed",
							values: ["always-allowed", "prompts again"],
							description: "Enter toggles whether this model's consults skip the approval prompt",
						})),
					];
					return submenu(
						"Consult approval",
						subItems,
						(id, value) => {
							if (id === "mode") {
								mode = value as "ask" | "judge" | "auto";
								updateGlobalConfig((g) => {
									g.approval = { ...(g.approval ?? {}), consultTool: mode };
								});
							} else {
								const name = id.slice("revoke:".length);
								updateGlobalConfig((g) => {
									if (g.models?.[name]) g.models[name].autoApprove = value === "always-allowed";
								});
							}
						},
						() => close(mode.toUpperCase()),
					);
				},
			},
			{
				id: "context",
				label: "Context keeper",
				currentValue: contextSummary(cfg),
				description: `Applies to registered models classed "local" (fallback providers: ${(cfg.context?.providers ?? DEFAULT_CONTEXT_PROVIDERS).join(", ")}); others use pi built-in`,
				submenu: (_currentValue, close) => {
					const c = loadConfig(ctx.cwd).context ?? {};
					const subItems: SettingItem[] = [
						{
							id: "mode",
							label: "Compaction",
							currentValue: c.mode ?? (c.checkpoint === false ? "off" : "arc"),
							values: ["arc", "checkpoint", "off"],
							description: "arc: deterministic digest (recall recovers exact content) · checkpoint: LLM-written · off: pi default",
						},
						{
							id: "pruner",
							label: "Pruner",
							currentValue: onOffValue(c.pruner !== false),
							values: ["ON", "OFF"],
							description: "Trims oversized shell outputs at ingestion (full output stashed for recall)",
						},
						{
							id: "recall",
							label: "Recall tool",
							currentValue: onOffValue(c.recall !== false),
							values: ["ON", "OFF"],
							description: "Transcript search + entry read-back",
						},
						{
							id: "notes",
							label: "Note tool",
							currentValue: onOffValue(c.notes !== false),
							values: ["ON", "OFF"],
							description: "Model notes pinned verbatim into digests",
						},
					];
					return submenu(
						"Context keeper",
						subItems,
						(id, value) => {
							updateGlobalConfig((g) => {
								g.context = { ...(g.context ?? {}) };
								if (id === "mode") {
									g.context.mode = value as "arc" | "checkpoint" | "off";
									delete g.context.checkpoint; // retire the legacy boolean
								} else {
									g.context[id as "pruner" | "recall" | "notes"] = value === "ON";
								}
							});
						},
						() => close(contextSummary(loadConfig(ctx.cwd))),
					);
				},
			},
			{
				id: "harness",
				label: "Model harness",
				currentValue: harnessHubLine(ctx),
				values: [harnessHubLine(ctx)],
				description: "Per-model-family trained dialects and thinking controls (opens the harness registry)",
			},
			{
				id: "watchdog",
				label: "Watchdog",
				currentValue: onOffValue(cfg.watchdog?.enabled !== false),
				values: ["ON", "OFF"],
				description: "Stuck/drift detection every turn (persisted; /watchdog on|off is the session-only switch)",
			},
			{
				id: "judge",
				label: "Judge (System One)",
				currentValue: onOffValue(cfg.judge?.enabled !== false),
				values: ["ON", "OFF"],
				description: `${judgeStatus(cfg.judge, modelBaseUrl(ctx.model))} — the decision fabric behind watchdog, triage, gate, guards, recall, and routing (/geocine judge prints details)`,
			},
			{
				id: "rescue",
				label: "Rescue capture",
				currentValue: onOffValue(cfg.rescue?.enabled !== false),
				values: ["ON", "OFF"],
				description: "Capture manual local→frontier /model switches as rescue episodes for /distill",
			},
			{
				id: "data",
				label: "Training data",
				currentValue: "consult-log · distill · lessons",
				values: ["consult-log · distill · lessons"],
				description: "Consult-log stats, rescue distilling, lesson drafts (opens the data menu)",
			},
			{
				id: "config",
				label: "Config",
				currentValue: CONFIG_FILE,
				values: [CONFIG_FILE],
				description: "Edit the geocine.json config in place",
			},
		];

		const list = new SettingsList(
			items,
			12,
			listTheme,
			(id, value) => {
				switch (id) {
					case "models":
					case "harness":
					case "data":
					case "config":
						done(id);
						return;
					case "watchdog":
						updateGlobalConfig((g) => {
							g.watchdog = { ...(g.watchdog ?? {}), enabled: value === "ON" };
						});
						return;
					case "judge":
						updateGlobalConfig((g) => {
							g.judge = { ...(g.judge ?? {}), enabled: value === "ON" };
						});
						return;
					case "rescue":
						updateGlobalConfig((g) => {
							g.rescue = { ...(g.rescue ?? {}), enabled: value === "ON" };
						});
						return;
					// approval/context: submenu already wrote the config; the
					// value passed here is just the refreshed row summary.
					case "approval":
					case "context":
						return;
				}
			},
			() => done(null),
		);
		if (initial) list.selectItem(initial);

		const container = new Container();
		container.addChild(new DynamicBorder((s: string) => theme.fg("borderAccent", s)));
		container.addChild(new Text(theme.fg("accent", theme.bold("geocine-pi"))));
		container.addChild(list);
		container.addChild(new DynamicBorder((s: string) => theme.fg("borderAccent", s)));

		return {
			render: (width: number) => container.render(width),
			invalidate: () => container.invalidate(),
			handleInput: (data: string) => {
				list.handleInput(data);
				tui.requestRender();
			},
		};
	});
}

async function runSection(section: Section, ctx: ExtensionContext): Promise<void> {
	const cfg = loadConfig(ctx.cwd);
	switch (section) {
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
		case "models":
			await modelsMenu(ctx, cfg);
			return;
		case "approval": {
			const autoApproved = Object.entries(cfg.models)
				.filter(([, c]) => c.autoApprove)
				.map(([n]) => n);
			const mode = cfg.approval?.consultTool ?? "ask";
			const MODES = [
				{ value: "ask", description: "prompt before every LLM-invoked consult" },
				{ value: "judge", description: "fabric auto-approves clear consults, asks when unsure (never auto-denies)" },
				{ value: "auto", description: "LLM-invoked consults run without asking" },
			] as const;
			const items: SelectItem[] = [
				...MODES.filter((m) => m.value !== mode).map((m) => ({
					value: `mode:${m.value}`,
					label: `Switch to ${m.value.toUpperCase()}`,
					description: m.description,
				})),
				...autoApproved.map((n) => ({
					value: `revoke:${n}`,
					label: `Revoke ${n}`,
					description: "this always-allowed model prompts again",
				})),
			];
			const picked = await richSelect(ctx, `Consult approval — currently ${mode.toUpperCase()}`, items);
			if (!picked) return;
			if (picked.startsWith("mode:")) {
				const next = picked.slice("mode:".length) as "ask" | "judge" | "auto";
				updateGlobalConfig((g) => {
					g.approval = { ...(g.approval ?? {}), consultTool: next };
				});
				ctx.ui.notify(`Consult approval mode: ${next.toUpperCase()}`, "info");
			} else {
				const name = picked.slice("revoke:".length);
				updateGlobalConfig((g) => {
					if (g.models?.[name]) g.models[name].autoApprove = false;
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
						`applies to: registered models classed "local" (fallback providers: ${(c.providers ?? DEFAULT_CONTEXT_PROVIDERS).join(", ")}); others use pi built-in`,
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
		case "harness":
			await harnessMenu(ctx);
			return;
		case "watchdog": {
			const next = cfg.watchdog?.enabled === false;
			updateGlobalConfig((g) => {
				g.watchdog = { ...(g.watchdog ?? {}), enabled: next };
			});
			ctx.ui.notify(`watchdog: ${onOff(next)} (persisted; /watchdog on|off is the session-only switch)`, "info");
			return;
		}
		case "judge": {
			const next = cfg.judge?.enabled === false;
			updateGlobalConfig((g) => {
				g.judge = { ...(g.judge ?? {}), enabled: next };
			});
			ctx.ui.notify(
				[
					`judge: ${onOff(next)} (persisted)`,
					`state: ${judgeStatus({ ...(cfg.judge ?? {}), enabled: next }, modelBaseUrl(ctx.model))}`,
					`trace: ${cfg.judge?.trace === false ? "OFF" : `ON → ${cfg.judge?.traceDir ?? "consult-log"}/judge-YYYY-MM.jsonl (offline-classifier training data)`}`,
					"Decision fabric nodes: watchdog (stuck/drift, every turn), triage (task difficulty + refusal risk + route; refusal hop lease with conversation-flow dwell/return), gate (outcome: continue/replan/stop/escalate), guard (destructive-command risk), toolcall (wasteful repeats/retries from local workers), recall (rerank fuzzy transcript-search results), compact (drop/keep/expand per digest step), notes (expire stale pinned notes), memory (steer compacted history into new tasks), route (assigns the model per consult), approve (auto-approves clear consults), prescreen (refusal risk). Heuristics and pi's own approvals remain the fallbacks.",
					...judgeFabricStats().map((line) => `  ${line}`),
				].join("\n"),
				"info",
			);
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
		description: "geocine-pi hub: models, approval, context keeper, watchdog/rescue, training data, config",
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
			// Hub: a persistent settings panel (see hubPanel). Toggles and
			// submenus change in place with the cursor staying on the row;
			// only models/harness/data/config close the panel to run their
			// flow, and the hub reopens with the cursor back on that row.
			let reselect: Section | undefined;
			for (;;) {
				const picked = await hubPanel(ctx, reselect);
				if (!picked) return;
				await runSection(picked, ctx);
				if (picked === "models" || picked === "config") return;
				reselect = picked;
			}
		},
	});
}
