// OpenAI model harness: gpt-* / o-series models on the openai provider.
//
// Trained dialect verified against D:\PL\codex (codex-rs/core/src/tools/):
// the shell tool is exec_command with a STRING `cmd` (the old array-argv
// shell is gone), and file editing is apply_patch — a freeform patch
// envelope, not old_string/new_string edits. Codex has no workspace read
// tool at all (models read via exec_command), so pi's read/grep/find/ls are
// left as-is: extra capability, no trained-name conflict.
//
// apply_patch is a real registered tool (see apply-patch.ts) because one
// patch call can touch several files and must stay one call = one result.
// It is listed in ownedTools so the dispatcher only advertises it while
// this harness is active.

import { msToSeconds, secondsToMs, type ToolAlias } from "./aliases.ts";
import { registerApplyPatchTool } from "./apply-patch.ts";
import type { ModelHarness } from "./types.ts";
import { modelBlob, modelProvider } from "./types.ts";

type JsonObject = Record<string, unknown>;

const OPENAI_ALIASES: ToolAlias[] = [
	{
		canonical: "bash",
		advertised: "exec_command",
		parameters: {
			type: "object",
			properties: {
				cmd: { type: "string", description: "The shell command to execute" },
				workdir: { type: "string", description: "Working directory for the command" },
				yield_time_ms: { type: "number", description: "How long to wait for output before returning" },
			},
			required: ["cmd"],
		},
		toAdvertisedArgs: (a) => {
			const out: JsonObject = { cmd: a.command };
			const ms = secondsToMs(a.timeout);
			if (ms !== undefined) out.yield_time_ms = ms;
			return out;
		},
		toCanonicalArgs: (a) => {
			let command = typeof a.cmd === "string" ? a.cmd : String(a.cmd ?? "");
			const workdir = typeof a.workdir === "string" ? a.workdir : undefined;
			if (workdir && !/^\s*cd\s/.test(command)) {
				command = `cd "${workdir.replace(/"/g, '\\"')}" && ${command}`;
			}
			const out: JsonObject = { command };
			const seconds = msToSeconds(a.yield_time_ms);
			if (seconds !== undefined) out.timeout = seconds;
			return out;
		},
	},
	{
		// codex update_plan: step/status pairs, full replacement, no ids.
		canonical: "todo",
		advertised: "update_plan",
		parameters: {
			type: "object",
			properties: {
				explanation: { type: "string", description: "Optional note on why the plan changed" },
				plan: {
					type: "array",
					description: "The complete plan (replaces the previous one)",
					items: {
						type: "object",
						properties: {
							step: { type: "string", description: "The step description" },
							status: {
								type: "string",
								enum: ["pending", "in_progress", "completed"],
								description: "Current step state",
							},
						},
						required: ["step", "status"],
					},
				},
			},
			required: ["plan"],
		},
		toCanonicalArgs: (a) => {
			const plan = Array.isArray(a.plan) ? (a.plan as Array<Record<string, unknown>>) : [];
			return {
				todos: plan.map((p, i) => ({
					id: String(i + 1),
					content: p.step ?? "",
					status: p.status ?? "pending",
				})),
			};
		},
		toAdvertisedArgs: (a) => {
			const todos = Array.isArray(a.todos) ? (a.todos as Array<Record<string, unknown>>) : [];
			return {
				plan: todos.map((t) => ({
					step: t.content ?? "",
					status: t.status === "cancelled" ? "completed" : (t.status ?? "pending"),
				})),
			};
		},
	},
	{
		// codex view_image: attach a file by path. pi's read serves both text
		// and images; codex models read text via exec_command, so renaming
		// read to the trained view_image loses nothing they were trained on.
		canonical: "read",
		advertised: "view_image",
		parameters: {
			type: "object",
			properties: {
				path: { type: "string", description: "Local filesystem path of the image to attach" },
			},
			required: ["path"],
		},
		toCanonicalArgs: (a) => ({ path: a.path }),
		toAdvertisedArgs: (a) => ({ path: a.path }),
	},
];

export const openaiHarness: ModelHarness = {
	id: "openai",
	behaviors: [
		"advertises the codex trained shell dialect: exec_command with string cmd (mapped to bash)",
		"apply_patch: codex's freeform patch envelope (add/update/move/delete files) as a native tool",
		"update_plan mapped to the shared todo tool; view_image mapped to pi read (text reads go via exec_command, as trained)",
	],
	summary: "codex dialect: exec_command shell, apply_patch tool, update_plan/view_image",
	matches: (ctx) => modelProvider(ctx) === "openai" || modelBlob(ctx).includes("gpt-"),
	toolAliases: OPENAI_ALIASES,
	registerTools: registerApplyPatchTool,
	ownedTools: ["apply_patch"],
};
