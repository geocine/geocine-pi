// Grok model harness: xAI models (grok-*), used here both interactively and
// as the "frontier" model via OAuth.
//
// Trained dialect verified against D:\PL\coding-agents\grok-build (default
// GrokBuild toolset in xai-grok-agent/src/config.rs, wire names after
// name_override): run_terminal_command (string command, ms timeout),
// read_file (target_file), search_replace (old_string/new_string),
// list_dir (target_directory), write (file_path), and a Claude-style grep
// (-i/-C/head_limit). Default GrokBuild has no file-glob tool, so pi's find
// stays canonical. All differences are dialect-level renames; no paradigm
// tools (apply_patch is only in grok-build's Codex preset, not the RL
// default).

import { msToSeconds, rekey, secondsToMs, type ToolAlias } from "./aliases.ts";
import type { ModelHarness } from "./types.ts";
import { modelBlob, modelProvider } from "./types.ts";

type JsonObject = Record<string, unknown>;

const str = (description: string) => ({ type: "string", description });
const int = (description: string) => ({ type: "integer", description });
const bool = (description: string) => ({ type: "boolean", description });

const GROK_ALIASES: ToolAlias[] = [
	{
		canonical: "bash",
		advertised: "run_terminal_command",
		parameters: {
			type: "object",
			properties: {
				command: str("The terminal command to execute"),
				description: str("Clear, concise description of what this command does in 5-10 words"),
				timeout: { type: "number", description: "Timeout in milliseconds (default 120000)" },
				background: bool("Run the command in the background"),
			},
			required: ["command", "description"],
		},
		// pi bash has no description/background; timeout is seconds there.
		toCanonicalArgs: (a) => {
			const out: JsonObject = { command: a.command };
			const seconds = msToSeconds(a.timeout);
			if (seconds !== undefined) out.timeout = seconds;
			return out;
		},
		toAdvertisedArgs: (a) => {
			const out: JsonObject = { command: a.command };
			const ms = secondsToMs(a.timeout);
			if (ms !== undefined) out.timeout = ms;
			return out;
		},
	},
	{
		canonical: "read",
		advertised: "read_file",
		parameters: {
			type: "object",
			properties: {
				target_file: str("Path of the file to read"),
				offset: int("1-based line number to start reading from"),
				limit: int("Maximum number of lines to read"),
			},
			required: ["target_file"],
		},
		toCanonicalArgs: (a) => rekey(a, { target_file: "path" }, ["path", "offset", "limit"]),
		toAdvertisedArgs: (a) => rekey(a, { path: "target_file" }, ["target_file", "offset", "limit"]),
	},
	{
		canonical: "edit",
		advertised: "search_replace",
		parameters: {
			type: "object",
			properties: {
				file_path: str("Path of the file to modify"),
				old_string: str("Exact literal text to replace (include enough context to be unique)"),
				new_string: str("Exact replacement text"),
				replace_all: bool("Replace all occurrences (default false)"),
			},
			required: ["file_path", "old_string", "new_string"],
		},
		toCanonicalArgs: (a) => {
			if (a.old_string === undefined && a.new_string === undefined) return a;
			return {
				path: a.file_path ?? a.path,
				edits: [{ oldText: a.old_string ?? "", newText: a.new_string ?? "" }],
			};
		},
		toAdvertisedArgs: (a) => {
			const edits = Array.isArray(a.edits) ? (a.edits as Array<Record<string, unknown>>) : [];
			if (edits.length !== 1) return a;
			return {
				file_path: a.path ?? a.file_path,
				old_string: edits[0].oldText,
				new_string: edits[0].newText,
			};
		},
	},
	{
		// Same name, grok schema spelling (file_path instead of path).
		canonical: "write",
		advertised: "write",
		parameters: {
			type: "object",
			properties: {
				file_path: str("Path of the file to write"),
				content: str("Content to write to the file"),
			},
			required: ["file_path", "content"],
		},
		toCanonicalArgs: (a) => rekey(a, { file_path: "path" }, ["path", "content"]),
		toAdvertisedArgs: (a) => rekey(a, { path: "file_path" }, ["file_path", "content"]),
	},
	{
		canonical: "ls",
		advertised: "list_dir",
		parameters: {
			type: "object",
			properties: {
				target_directory: str("Path of the directory to list"),
			},
			required: ["target_directory"],
		},
		toCanonicalArgs: (a) => rekey(a, { target_directory: "path" }, ["path"]),
		toAdvertisedArgs: (a) => rekey(a, { path: "target_directory" }, ["target_directory"]),
	},
	{
		// Same name, grok schema (Claude-style flags). pi grep lacks type/
		// multiline; -A/-B collapse into pi's symmetric context.
		canonical: "grep",
		advertised: "grep",
		parameters: {
			type: "object",
			properties: {
				pattern: str("The regular expression pattern to search for"),
				path: str("File or directory to search in"),
				glob: str("Glob pattern to filter files (e.g. *.ts)"),
				"-i": bool("Case insensitive search"),
				"-C": int("Number of lines to show before and after each match"),
				head_limit: int("Limit output to the first N matches"),
			},
			required: ["pattern"],
		},
		toCanonicalArgs: (a) => {
			const out: JsonObject = rekey(a, { head_limit: "limit" }, ["pattern", "path", "glob", "limit"]);
			if (a["-i"] !== undefined) out.ignoreCase = a["-i"];
			const context = a["-C"] ?? a["-A"] ?? a["-B"];
			if (typeof context === "number") out.context = context;
			return out;
		},
		toAdvertisedArgs: (a) => {
			const out: JsonObject = rekey(a, { limit: "head_limit" }, ["pattern", "path", "glob", "head_limit"]);
			if (a.ignoreCase !== undefined) out["-i"] = a.ignoreCase;
			if (a.context !== undefined) out["-C"] = a.context;
			return out;
		},
	},
	{
		// grok-build todo_write: merge-by-id semantics, four statuses.
		canonical: "todo",
		advertised: "todo_write",
		parameters: {
			type: "object",
			properties: {
				merge: bool("Merge into the existing list by id instead of replacing it"),
				todos: {
					type: "array",
					description: "The task items to write",
					items: {
						type: "object",
						properties: {
							id: str("Unique identifier for the task"),
							content: str("The task description"),
							status: {
								type: "string",
								enum: ["pending", "in_progress", "completed", "cancelled"],
								description: "Current task state",
							},
						},
						required: ["id"],
					},
				},
			},
			required: ["todos"],
		},
		toCanonicalArgs: (a) => {
			const items = Array.isArray(a.todos) ? (a.todos as Array<Record<string, unknown>>) : [];
			const out: JsonObject = {
				todos: items.map((t, i) => ({
					id: t.id ?? String(i + 1),
					content: t.content ?? "",
					status: t.status ?? "pending",
				})),
			};
			if (a.merge !== undefined) out.merge = a.merge;
			return out;
		},
		toAdvertisedArgs: (a) => rekey(a, {}, ["todos", "merge"]),
	},
	{
		// Same name, grok-build schema: url only.
		canonical: "web_fetch",
		advertised: "web_fetch",
		parameters: {
			type: "object",
			properties: {
				url: str("The URL to fetch content from"),
			},
			required: ["url"],
		},
		toCanonicalArgs: (a) => rekey(a, {}, ["url"]),
		toAdvertisedArgs: (a) => rekey(a, {}, ["url"]),
	},
	// web_search: grok-build's schema (query + allowed_domains) matches the
	// canonical tool exactly, so no alias entry is needed.
	{
		// grok-build ask_user_question: multi-question envelope over pi's
		// single-question ask_user. Only the first question is asked.
		canonical: "ask_user",
		advertised: "ask_user_question",
		parameters: {
			type: "object",
			properties: {
				questions: {
					type: "array",
					description: "Questions for the user (ask one per call)",
					items: {
						type: "object",
						properties: {
							question: str("The question to ask"),
							options: {
								type: "array",
								description: "Answer choices",
								items: {
									type: "object",
									properties: {
										label: str("The choice shown to the user"),
										description: str("One-line explanation of the choice"),
									},
									required: ["label"],
								},
							},
							multi_select: bool("Allow selecting multiple options"),
						},
						required: ["question", "options"],
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
					question: a.question ?? "",
					options: (Array.isArray(a.options) ? (a.options as unknown[]) : []).map((label) => ({
						label: String(label),
					})),
				},
			],
		}),
	},
];

export const grokHarness: ModelHarness = {
	id: "grok",
	behaviors: [
		"advertises the grok-build trained tool dialect (run_terminal_command, read_file target_file, search_replace, write file_path, list_dir, Claude-style grep, todo_write merge, web_fetch, web_search, ask_user_question)",
	],
	summary: "grok-build tool dialect (terminal, search_replace, Claude-style grep, web tools)",
	matches: (ctx) => modelProvider(ctx) === "xai" || modelBlob(ctx).includes("grok"),
	toolAliases: GROK_ALIASES,
	// Shared with the qwen harness; hidden from every other model.
	ownedTools: ["web_fetch", "web_search"],
};
