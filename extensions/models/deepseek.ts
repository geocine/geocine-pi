// DeepSeek model harness: models served by the "deepseek" provider or whose
// id/name contains "deepseek".
//
// Trained dialect verified against D:\PL\coding-agents\deepseek-harness (the
// official DeepSeek Harness, `dsh`): the standard agent preset
// (packages/preset/agent-presets/presets/standard/agent.cordis.yml) plus the
// wire schemas in docs/tool-catalog.md. Model-facing names there: bash
// (command + required description, timeoutMs, workdir), read/write/edit on
// file_path (edit takes old_string/new_string/replace_all), glob, grep
// (include glob filter), todo_write (full replacement, no ids, three
// statuses), ask_user_question (multi-question envelope with per-question
// id), web_fetch (url only), web_search (queries array of 1-4).
//
// dsh tools with no pi equivalent (skill, goal, subagent, jobs, present,
// exit_plan_mode, run_code) are not aliased; the model simply doesn't see
// them. bash's run_in_background is omitted from the advertised schema:
// dsh itself removes the parameter when enableRunInBackground is false, so
// a schema without it is an in-distribution variant, and pi's bash has no
// background jobs to honor it with.

import { msToSeconds, rekey, secondsToMs, type ToolAlias } from "./aliases.ts";
import type { ModelHarness } from "./types.ts";
import { modelBlob, modelProvider } from "./types.ts";

type JsonObject = Record<string, unknown>;

const str = (description: string) => ({ type: "string", description });
const num = (description: string) => ({ type: "number", description });
const bool = (description: string) => ({ type: "boolean", description });

const DEEPSEEK_ALIASES: ToolAlias[] = [
	{
		// Same name, dsh schema: description is required, timeout is
		// milliseconds (timeoutMs), and workdir replaces cd-prefixing.
		canonical: "bash",
		advertised: "bash",
		parameters: {
			type: "object",
			properties: {
				command: str("The bash command to execute."),
				description: str(
					"Clear, concise description of what this command does in active voice, 5-10 words (shown in the UI).",
				),
				timeoutMs: num("Timeout in milliseconds. The executor applies its configured default and cap."),
				workdir: str("Working directory for this command. Defaults to the session workspace."),
			},
			required: ["command", "description"],
		},
		// pi bash has no description/workdir; timeout is seconds there.
		toCanonicalArgs: (a) => {
			let command = typeof a.command === "string" ? a.command : String(a.command ?? "");
			const workdir = typeof a.workdir === "string" ? a.workdir : undefined;
			if (workdir && !/^\s*cd\s/.test(command)) {
				command = `cd "${workdir.replace(/"/g, '\\"')}" && ${command}`;
			}
			const out: JsonObject = { command };
			const seconds = msToSeconds(a.timeoutMs);
			if (seconds !== undefined) out.timeout = seconds;
			return out;
		},
		toAdvertisedArgs: (a) => {
			const out: JsonObject = { command: a.command };
			const ms = secondsToMs(a.timeout);
			if (ms !== undefined) out.timeoutMs = ms;
			return out;
		},
	},
	{
		// Same name, dsh schema spelling (file_path instead of path).
		canonical: "read",
		advertised: "read",
		parameters: {
			type: "object",
			properties: {
				file_path: str("Path to read, resolved by the filesystem backend."),
				offset: num("1-based first line to return. Defaults to 1."),
				limit: num("Maximum number of lines to return. Defaults to 2000."),
			},
			required: ["file_path"],
		},
		toCanonicalArgs: (a) => rekey(a, { file_path: "path" }, ["path", "offset", "limit"]),
		toAdvertisedArgs: (a) => rekey(a, { path: "file_path" }, ["file_path", "offset", "limit"]),
	},
	{
		canonical: "write",
		advertised: "write",
		parameters: {
			type: "object",
			properties: {
				file_path: str("Path to write, resolved by the filesystem backend."),
				content: str("Full UTF-8 text content to write."),
			},
			required: ["file_path", "content"],
		},
		toCanonicalArgs: (a) => rekey(a, { file_path: "path" }, ["path", "content"]),
		toAdvertisedArgs: (a) => rekey(a, { path: "file_path" }, ["file_path", "content"]),
	},
	{
		// Same name, dsh schema: old_string/new_string on file_path, not
		// pi's edits array.
		canonical: "edit",
		advertised: "edit",
		parameters: {
			type: "object",
			properties: {
				file_path: str("Path to edit, resolved by the filesystem backend."),
				old_string: str("Literal text to replace. Must match exactly."),
				new_string: str("Literal replacement text. Use an empty string to delete the match."),
				replace_all: bool("Replace all matches. Defaults to false; when false, old_string must appear exactly once."),
			},
			required: ["file_path", "old_string", "new_string"],
		},
		toCanonicalArgs: (a) => {
			if (a.old_string === undefined && a.new_string === undefined) return a; // already canonical
			return {
				path: a.file_path ?? a.path,
				edits: [{ oldText: a.old_string ?? "", newText: a.new_string ?? "" }],
			};
		},
		toAdvertisedArgs: (a) => {
			const edits = Array.isArray(a.edits) ? (a.edits as Array<Record<string, unknown>>) : [];
			if (edits.length !== 1) return a; // multi-edit has no trained single-pair form
			return {
				file_path: a.path ?? a.file_path,
				old_string: edits[0].oldText,
				new_string: edits[0].newText,
			};
		},
	},
	{
		canonical: "find",
		advertised: "glob",
		parameters: {
			type: "object",
			properties: {
				pattern: str('Glob pattern to match file paths against (e.g. "**/*.ts", "src/**/*.test.js").'),
				path: str("Directory to search in. Defaults to the session workspace."),
			},
			required: ["pattern"],
		},
		toCanonicalArgs: (a) => rekey(a, {}, ["pattern", "path"]),
		toAdvertisedArgs: (a) => rekey(a, {}, ["pattern", "path"]),
	},
	{
		// Same name, dsh schema: one "include" glob filter instead of pi's
		// glob/ignoreCase/literal/context/limit spread.
		canonical: "grep",
		advertised: "grep",
		parameters: {
			type: "object",
			properties: {
				pattern: str("Regular expression to search for (ripgrep syntax)."),
				path: str("File or directory to search. Defaults to the session workspace."),
				include: str('One glob filter for which files to search (e.g. "*.ts", "*.{js,jsx}").'),
			},
			required: ["pattern"],
		},
		toCanonicalArgs: (a) => rekey(a, { include: "glob" }, ["pattern", "path", "glob"]),
		toAdvertisedArgs: (a) => rekey(a, { glob: "include" }, ["pattern", "path", "include"]),
	},
	{
		// dsh todo_write: full-replacement list, content+status only (no ids),
		// three statuses.
		canonical: "todo",
		advertised: "todo_write",
		parameters: {
			type: "object",
			properties: {
				todos: {
					type: "array",
					description: "The COMPLETE task list, replacing any previous list.",
					items: {
						type: "object",
						properties: {
							content: str("What the task is — a short imperative line."),
							status: {
								type: "string",
								enum: ["pending", "in_progress", "completed"],
								description: "pending (not started) | in_progress (now) | completed (done).",
							},
						},
						required: ["content", "status"],
					},
				},
			},
			required: ["todos"],
		},
		toCanonicalArgs: (a) => {
			const items = Array.isArray(a.todos) ? (a.todos as Array<Record<string, unknown>>) : [];
			return {
				todos: items.map((t, i) => ({
					id: t.id ?? String(i + 1),
					content: t.content ?? "",
					status: t.status ?? "pending",
				})),
			};
		},
		toAdvertisedArgs: (a) => {
			const items = Array.isArray(a.todos) ? (a.todos as Array<Record<string, unknown>>) : [];
			return {
				todos: items.map((t) => ({
					content: t.content ?? "",
					status: t.status === "cancelled" ? "completed" : (t.status ?? "pending"),
				})),
			};
		},
	},
	{
		// dsh ask_user_question: multi-question envelope with per-question id
		// over pi's single-question ask_user. Only the first question is asked.
		canonical: "ask_user",
		advertised: "ask_user_question",
		parameters: {
			type: "object",
			properties: {
				questions: {
					type: "array",
					description: "Questions to ask the user before continuing.",
					items: {
						type: "object",
						properties: {
							id: str("Stable id for this question; echoed in the answer."),
							question: str("The specific question to ask the user."),
							header: str('Optional short heading for the question, such as "Confirm" or "Choose Mode".'),
							options: {
								type: "array",
								description:
									'Optional choices to show the user. If you recommend one, put it first and append "(Recommended)" to that label.',
								items: {
									type: "object",
									properties: {
										label: str("Short user-facing option label."),
										description: str("One sentence explaining the tradeoff or impact."),
									},
									required: ["label"],
								},
							},
							multi_select: bool("Whether the user may select more than one option. Defaults to false."),
						},
						required: ["id", "question"],
					},
				},
			},
			required: ["questions"],
		},
		toCanonicalArgs: (a) => {
			const questions = Array.isArray(a.questions) ? (a.questions as Array<Record<string, unknown>>) : [];
			const first = questions[0] ?? {};
			const options = Array.isArray(first.options)
				? (first.options as Array<Record<string, unknown>>).map((o) => String(o.label ?? "")).filter(Boolean)
				: [];
			const out: JsonObject = { question: first.question ?? "" };
			if (options.length > 0) out.options = options;
			return out;
		},
		toAdvertisedArgs: (a) => ({
			questions: [
				{
					id: "q1",
					question: a.question ?? "",
					options: (Array.isArray(a.options) ? (a.options as unknown[]) : []).map((label) => ({
						label: String(label),
					})),
				},
			],
		}),
	},
	{
		// Same name, dsh schema: url only.
		canonical: "web_fetch",
		advertised: "web_fetch",
		parameters: {
			type: "object",
			properties: {
				url: str("The HTTP(S) URL to fetch."),
			},
			required: ["url"],
		},
		toCanonicalArgs: (a) => rekey(a, {}, ["url"]),
		toAdvertisedArgs: (a) => rekey(a, {}, ["url"]),
	},
	{
		// Same name, dsh schema: a queries ARRAY (1-4, results merged). The
		// canonical provider searches one query, so the first query answers
		// the call; the model can follow up for the rest.
		canonical: "web_search",
		advertised: "web_search",
		parameters: {
			type: "object",
			properties: {
				queries: {
					type: "array",
					description: "Required search queries; accepts 1-4 items and merges their results.",
					items: { type: "string" },
				},
			},
			required: ["queries"],
		},
		toCanonicalArgs: (a) => {
			const queries = Array.isArray(a.queries)
				? (a.queries as unknown[]).map((q) => String(q)).filter((q) => q.trim() !== "")
				: [];
			return { query: queries[0] ?? String(a.query ?? "") };
		},
		toAdvertisedArgs: (a) => ({ queries: [String(a.query ?? "")] }),
	},
];

export const deepseekHarness: ModelHarness = {
	id: "deepseek",
	behaviors: [
		"advertises the DeepSeek Harness (dsh) trained tool dialect (bash timeoutMs/workdir, read/write/edit on file_path with old/new_string, glob, grep include, todo_write, ask_user_question, web_fetch, web_search queries[])",
	],
	summary: "dsh tool dialect (bash workdir, file_path fs tools, glob, todo_write, web tools)",
	matches: (ctx) => modelProvider(ctx) === "deepseek" || modelBlob(ctx).includes("deepseek"),
	toolAliases: DEEPSEEK_ALIASES,
	// dsh trains client web tools (tool-web in the standard preset); shared
	// with the qwen/grok harnesses and hidden from every other model.
	ownedTools: ["web_fetch", "web_search"],
};
