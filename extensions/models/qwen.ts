// Qwen model harness: Pi + llama.cpp pairing for models whose id/name contains "qwen".
// Runtime is Pi, not Qwen Code. Qwen Code is a reference because Coder-Next
// trained on it as one of several scaffolds (also SWE-agent, OpenHands, Cline,
// Claude Code, Terminus). Cross-scaffold transfer is weak, so we recover the
// formats those scaffolds taught — we do not become Qwen Code.
// Do not inject Claude XML reminders, OpenAI "CRITICAL JSON" dumps, or the
// Qwen Code system prompt. This extension does not replace Pi's prompt. It:
//   1. Repairs Qwen-native tool calls (names, args, leaked XML) on any provider
//   2. On llama.cpp only: fixes tool schemas that crash the grammar converter,
//      wires enable_thinking / reasoning_budget_* to the real server fields,
//      and applies the Qwen3 report's sampling defaults
// Verified against a llama.cpp checkout (2026-08-31):
// tools/server/server-common.cpp, server-schema.cpp, common/chat.cpp
// (qwen3_coder handler), common/json-schema-to-grammar.cpp.
// llama-server --no-models-autoload --models-max 1 --host 127.0.0.1 --port 8080 -np 1 -ngl 99 -c 262144 -fa on --cache-type-k q4_0 --cache-type-v q4_0 --jinja

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadConfig, updateGlobalConfig } from "../../lib/config.ts";
import { type ModelHarness, modelBlob } from "./types.ts";

const XML_CALL_ID_PREFIX = "qwen-xml-";

const TOOL_NAME_ALIASES: Record<string, string> = {
	read_file: "read",
	write_file: "write",
	run_shell_command: "bash",
	shell: "bash",
	grep_search: "grep",
	search_file_content: "grep",
	glob: "find",
	list_directory: "ls",
	list_files: "ls",
	replace: "edit",
	todo_write: "todo",
};

const PATH_KEYS = ["file_path", "target_file", "target_directory", "dir_path", "directory"];

type JsonObject = Record<string, unknown>;

function isQwenModel(ctx: ExtensionContext | undefined): boolean {
	return modelBlob(ctx).includes("qwen");
}

function isLlamaCpp(ctx: ExtensionContext | undefined): boolean {
	return String(ctx?.model?.provider ?? "") === "llama.cpp";
}

function isQwenCoder(ctx: ExtensionContext | undefined): boolean {
	const blob = modelBlob(ctx);
	return /qwen[^\s]*-coder/.test(blob) || blob.includes("coder-model");
}

function canonicalToolName(name: string): string {
	const trimmed = name.trim();
	return TOOL_NAME_ALIASES[trimmed] ?? TOOL_NAME_ALIASES[trimmed.toLowerCase()] ?? trimmed;
}

function asObject(value: unknown): JsonObject | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	return value as JsonObject;
}

function decodeXmlEntities(value: string): string {
	if (!value.includes("&")) return value;
	return value
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'")
		.replace(/&amp;/g, "&");
}

function stripDelimitingNewlines(value: string): string {
	let result = value;
	if (result.startsWith("\n")) result = result.slice(1);
	if (result.endsWith("\n")) result = result.slice(0, -1);
	return result;
}

function parseParameterValue(value: string): unknown {
	const trimmed = value.trim();
	if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
		const parsed = tryParseJsonObject(trimmed);
		if (parsed) return parsed;
		const array = tryParseJson(trimmed);
		if (Array.isArray(array)) return array;
	}
	return value;
}

function tryParseJson(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		const repaired = repairJsonText(text);
		if (repaired === text) return undefined;
		try {
			return JSON.parse(repaired);
		} catch {
			return undefined;
		}
	}
}

function tryParseJsonObject(text: string): JsonObject | undefined {
	const value = tryParseJson(text);
	return asObject(value);
}

/** Close unclosed strings/braces (Qwen Code streaming parser is the reference). */
function repairJsonText(json: string): string {
	const stack: Array<"{" | "["> = [];
	let inString = false;
	let escape = false;
	for (const char of json) {
		if (inString) {
			if (char === '"' && !escape) inString = false;
			escape = char === "\\" && !escape;
			continue;
		}
		if (char === '"') inString = true;
		else if (char === "{" || char === "[") stack.push(char);
		else if (char === "}" || char === "]") stack.pop();
	}

	let repaired = json;
	if (inString) repaired += '"';
	while (stack.length > 0) {
		repaired += stack.pop() === "{" ? "}" : "]";
	}
	return repaired;
}

type ExtractedCall = { name: string; args: JsonObject };

const INVOKE_PATTERN = /<invoke\s+name=["']([^"']+)["']>([\s\S]*?)<\/invoke>/g;
const INVOKE_PARAM_PATTERN = /<parameter\s+name=["']([^"']+)["']>([\s\S]*?)<\/parameter>/g;
const QWEN_CODER_PATTERN =
	/<tool_call>\s*<function=([^>]+)>([\s\S]*?)<\/function>\s*<\/tool_call>/g;
const QWEN_CODER_PARAM_PATTERN = /<parameter=([^>]+)>([\s\S]*?)<\/parameter>/g;
const QWEN_VL_PATTERN = /<tool_call>\s*(\{[\s\S]*?\})\s*<\/tool_call>/g;
const BARE_FUNCTION_PATTERN = /<function=([^>]+)>([\s\S]*?)<\/function>/g;

function extractParams(block: string, pattern: RegExp): JsonObject {
	const args: JsonObject = {};
	pattern.lastIndex = 0;
	let match: RegExpExecArray | null;
	while ((match = pattern.exec(block)) !== null) {
		args[match[1]] = parseParameterValue(decodeXmlEntities(stripDelimitingNewlines(match[2])));
	}
	return args;
}

function extractInvokeCalls(text: string): ExtractedCall[] {
	const results: ExtractedCall[] = [];
	INVOKE_PATTERN.lastIndex = 0;
	let match: RegExpExecArray | null;
	while ((match = INVOKE_PATTERN.exec(text)) !== null) {
		if (isInsideFence(text, match.index)) continue;
		const args = extractParams(match[2], INVOKE_PARAM_PATTERN);
		if (match[1] && Object.keys(args).length > 0) {
			results.push({ name: match[1], args });
		}
	}
	return results;
}

function extractQwenCoderCalls(text: string): ExtractedCall[] {
	const results: ExtractedCall[] = [];
	QWEN_CODER_PATTERN.lastIndex = 0;
	let match: RegExpExecArray | null;
	while ((match = QWEN_CODER_PATTERN.exec(text)) !== null) {
		if (isInsideFence(text, match.index)) continue;
		const args = extractParams(match[2], QWEN_CODER_PARAM_PATTERN);
		// Full <tool_call><function=...> wrapper is distinctive enough to
		// trust zero-parameter calls; only the bare fallback requires args.
		if (match[1]) {
			results.push({ name: match[1].trim(), args });
		}
	}
	if (results.length > 0) return results;

	BARE_FUNCTION_PATTERN.lastIndex = 0;
	while ((match = BARE_FUNCTION_PATTERN.exec(text)) !== null) {
		if (isInsideFence(text, match.index)) continue;
		const args = extractParams(match[2], QWEN_CODER_PARAM_PATTERN);
		if (match[1] && Object.keys(args).length > 0) {
			results.push({ name: match[1].trim(), args });
		}
	}
	return results;
}

function extractQwenVlCalls(text: string): ExtractedCall[] {
	const results: ExtractedCall[] = [];
	QWEN_VL_PATTERN.lastIndex = 0;
	let match: RegExpExecArray | null;
	while ((match = QWEN_VL_PATTERN.exec(text)) !== null) {
		if (isInsideFence(text, match.index)) continue;
		const parsed = tryParseJson(match[1]);
		const obj = asObject(parsed);
		if (!obj) continue;
		const name = typeof obj.name === "string" ? obj.name : undefined;
		// Hermes/OpenAI wire format sometimes carries arguments as a JSON string.
		let rawArgs: unknown = obj.arguments ?? obj.parameters;
		if (typeof rawArgs === "string") rawArgs = tryParseJsonObject(rawArgs);
		const args = asObject(rawArgs) ?? {};
		// A parsed JSON object with a name inside <tool_call> is distinctive
		// enough to trust even with zero arguments.
		if (name) {
			results.push({ name, args });
		}
	}
	return results;
}

function extractXmlToolCalls(text: string): ExtractedCall[] {
	// Some Qwen releases mixed coder XML and Hermes JSON <tool_call> blocks in
	// one turn; the two patterns are disjoint, so collect both.
	const coder = [...extractQwenCoderCalls(text), ...extractQwenVlCalls(text)];
	if (coder.length > 0) return coder;
	return extractInvokeCalls(text);
}

function xmlBlocksDominate(text: string): boolean {
	const stripped = text
		.replace(INVOKE_PATTERN, "")
		.replace(QWEN_CODER_PATTERN, "")
		.replace(QWEN_VL_PATTERN, "")
		.replace(BARE_FUNCTION_PATTERN, "")
		.replace(/<function_calls>\s*<\/function_calls>/g, "")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
	if (text.length === 0) return false;
	return stripped.length / text.length <= 0.8;
}

function stripRecoveredXml(text: string): string {
	return text
		.replace(INVOKE_PATTERN, "")
		.replace(QWEN_CODER_PATTERN, "")
		.replace(QWEN_VL_PATTERN, "")
		.replace(BARE_FUNCTION_PATTERN, "")
		.replace(/<function_calls>\s*<\/function_calls>/g, "")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

function isInsideFence(text: string, index: number): boolean {
	let open: { delim: string; len: number } | null = null;
	for (const line of text.slice(0, index).split("\n")) {
		const m = /^ {0,3}((`{3,})|~{3,})/.exec(line);
		if (!m) continue;
		const delim = m[2] ? "`" : "~";
		const len = m[1].length;
		if (open === null) open = { delim, len };
		else if (open.delim === delim && len >= open.len && line.slice(m[0].length).trim() === "") {
			open = null;
		}
	}
	return open !== null;
}

function takeString(args: JsonObject, keys: string[], allowEmpty = false): string | undefined {
	for (const key of keys) {
		const value = args[key];
		if (typeof value === "string") {
			if (value.length > 0 || allowEmpty) return value;
			continue;
		}
		if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
			return String(value);
		}
	}
	return undefined;
}

function takeNumber(args: JsonObject, keys: string[]): number | undefined {
	for (const key of keys) {
		const value = args[key];
		if (typeof value === "number" && Number.isFinite(value)) return value;
		if (typeof value === "string" && value.trim() !== "") {
			const n = Number(value);
			if (Number.isFinite(n)) return n;
		}
	}
	return undefined;
}

function takeBoolean(args: JsonObject, keys: string[]): boolean | undefined {
	for (const key of keys) {
		const value = args[key];
		if (typeof value === "boolean") return value;
		if (typeof value === "string") {
			const lower = value.toLowerCase();
			if (lower === "true") return true;
			if (lower === "false") return false;
		}
	}
	return undefined;
}

function coerceScalar(value: unknown, kind: "string" | "number" | "boolean"): unknown {
	if (kind === "string") {
		if (typeof value === "string") return value;
		if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
			return String(value);
		}
	}
	if (kind === "number") {
		if (typeof value === "number" && Number.isFinite(value)) return value;
		if (typeof value === "string" && value.trim() !== "") {
			const n = Number(value);
			if (Number.isFinite(n)) return n;
		}
	}
	if (kind === "boolean") {
		if (typeof value === "boolean") return value;
		if (typeof value === "string") {
			const lower = value.toLowerCase();
			if (lower === "true") return true;
			if (lower === "false") return false;
		}
	}
	return value;
}

function pickPath(args: JsonObject): string | undefined {
	return takeString(args, ["path", ...PATH_KEYS]);
}

function keep(fields: JsonObject, keys: string[]): JsonObject {
	const next: JsonObject = {};
	for (const key of keys) {
		if (fields[key] !== undefined) next[key] = fields[key];
	}
	return next;
}

function remapArgs(toolName: string, raw: unknown): JsonObject {
	let args = asObject(raw);
	if (!args && typeof raw === "string") args = tryParseJsonObject(raw);
	if (!args) args = {};

	const path = pickPath(args);

	switch (toolName) {
		case "read":
			return keep(
				{
					path,
					offset: takeNumber(args, ["offset"]),
					limit: takeNumber(args, ["limit"]),
				},
				["path", "offset", "limit"],
			);
		case "write":
			return keep(
				{
					path,
					content: args.content !== undefined ? coerceScalar(args.content, "string") : undefined,
				},
				["path", "content"],
			);
		case "edit": {
			const oldText = takeString(args, ["oldText", "old_string", "old_str"], true);
			const newText = takeString(args, ["newText", "new_string", "new_str"], true);
			// Qwen Code scaffold: empty old_string creates a new file via edit.
			if (oldText === "" && typeof newText === "string" && path) {
				return keep({ path, content: newText }, ["path", "content"]);
			}
			let edits: unknown = args.edits;
			if (typeof edits === "string") {
				const parsed = tryParseJson(edits);
				if (Array.isArray(parsed)) edits = parsed;
			}
			if (!Array.isArray(edits) || edits.length === 0) {
				if (oldText !== undefined && newText !== undefined) {
					edits = [{ oldText, newText }];
				}
			} else {
				edits = edits.map((edit) => {
					const item = asObject(edit) ?? {};
					return {
						oldText: takeString(item, ["oldText", "old_string", "old_str"]) ?? item.oldText,
						newText: takeString(item, ["newText", "new_string", "new_str"]) ?? item.newText,
					};
				});
			}
			return keep({ path, edits }, ["path", "edits"]);
		}
		case "bash": {
			let command = args.command !== undefined ? coerceScalar(args.command, "string") : undefined;
			const cwd = takeString(args, ["working_directory", "cwd", "workdir"]);
			if (cwd && typeof command === "string" && !/^\s*cd\s/.test(command)) {
				command = `cd "${cwd.replace(/"/g, '\\"')}" && ${command}`;
			}
			return keep({ command, timeout: takeNumber(args, ["timeout"]) }, ["command", "timeout"]);
		}
		case "grep":
			return keep(
				{
					pattern: args.pattern !== undefined ? coerceScalar(args.pattern, "string") : undefined,
					path,
					glob: takeString(args, ["glob", "include"]),
					ignoreCase: takeBoolean(args, ["ignoreCase", "ignore_case", "case_insensitive"]),
					literal: takeBoolean(args, ["literal"]),
					context: takeNumber(args, ["context", "-C"]),
					limit: takeNumber(args, ["limit"]),
				},
				["pattern", "path", "glob", "ignoreCase", "literal", "context", "limit"],
			);
		case "find":
			return keep(
				{
					pattern: args.pattern !== undefined ? coerceScalar(args.pattern, "string") : undefined,
					path,
					limit: takeNumber(args, ["limit"]),
				},
				["pattern", "path", "limit"],
			);
		case "ls":
			return keep({ path, limit: takeNumber(args, ["limit"]) }, ["path", "limit"]);
		default:
			if (path && args.path === undefined) return { ...args, path };
			return { ...args };
	}
}

function remapToolCall(call: { name: string; arguments: unknown; id?: string }): {
	name: string;
	arguments: JsonObject;
} {
	let name = canonicalToolName(call.name);
	let args: unknown = call.arguments;
	if (typeof args === "string") args = tryParseJsonObject(args) ?? {};
	const mapped = remapArgs(name, args);
	if (name === "edit" && typeof mapped.content === "string" && mapped.path && !mapped.edits) {
		name = "write";
	}
	return { name, arguments: mapped };
}

function newXmlCallId(index: number): string {
	return `${XML_CALL_ID_PREFIX}${index}-${Date.now().toString(36)}`;
}

const LLAMA_DROP_KEYS = new Set(["$schema", "$id", "uniqueItems"]);
const HUGE_MAX_LENGTH = 10_000;

// llama.cpp renders tool schemas into the prompt and compiles them into a
// grammar (common/json-schema-to-grammar.cpp). Each rewrite below has a
// concrete reason against that code:
// - $schema/$id/uniqueItems: ignored by the converter, pure prompt noise
// - string-typed maxLength/minLength/minItems/maxItems: get<int>() throws
// - huge maxLength: get<int>() overflow; also prompt noise
// - type arrays (["string","null"]): not handled by the converter
// additionalProperties:false is left alone — the grammar uses it to force
// correct argument names, which is exactly what we want.
function relaxSchema(schema: unknown): unknown {
	if (Array.isArray(schema)) return schema.map(relaxSchema);
	const source = asObject(schema);
	if (!source) return schema;

	const target: JsonObject = {};
	for (const [key, value] of Object.entries(source)) {
		if (LLAMA_DROP_KEYS.has(key)) continue;
		if ((key === "maxLength" || key === "minLength" || key === "minItems" || key === "maxItems") && typeof value === "string") {
			const n = Number(value);
			if (value.trim() !== "" && Number.isInteger(n)) {
				if (key === "maxLength" && n > HUGE_MAX_LENGTH) continue;
				target[key] = n;
				continue;
			}
		}
		if (key === "maxLength" && typeof value === "number" && value > HUGE_MAX_LENGTH) continue;
		if (key === "type" && Array.isArray(value)) {
			const types = value.filter((item): item is string => typeof item === "string");
			const nonNull = types.find((item) => item !== "null") ?? types[0];
			if (nonNull) target.type = nonNull;
			continue;
		}
		if (
			(key === "properties" || key === "$defs" || key === "definitions" || key === "patternProperties") &&
			asObject(value)
		) {
			const map: JsonObject = {};
			for (const [mapKey, mapValue] of Object.entries(value as JsonObject)) {
				map[mapKey] = relaxSchema(mapValue);
			}
			target[key] = map;
			continue;
		}
		if (key === "const" || key === "default" || key === "enum" || key === "examples") {
			target[key] = value;
			continue;
		}
		target[key] = relaxSchema(value);
	}
	return target;
}

function patchLlamaTools(payload: JsonObject): JsonObject {
	const tools = payload.tools;
	if (!Array.isArray(tools)) return payload;

	const nextTools = tools.map((tool) => {
		const obj = asObject(tool);
		if (!obj) return tool;
		const fn = asObject(obj.function);
		if (!fn) return obj;
		const parameters = fn.parameters !== undefined ? relaxSchema(fn.parameters) : fn.parameters;
		return { ...obj, function: { ...fn, parameters } };
	});

	// "strict" is never read on llama.cpp's chat-completions path, and
	// parallel_tool_calls already defaults from template capabilities, so
	// neither is touched here.
	return { ...payload, tools: nextTools };
}

function mergeChatTemplateKwargs(payload: JsonObject, extra: JsonObject): JsonObject {
	const current = asObject(payload.chat_template_kwargs) ?? {};
	return { ...payload, chat_template_kwargs: { ...current, ...extra } };
}

// Cutoff message from the Qwen3 Technical Report (2505.09388): injected before
// the forced </think> when the thinking budget runs out.
const THINK_BUDGET_CUTOFF =
	"\nConsidering the limited time by the user, I have to give the solution based on the thinking directly now.\n";

// Auto mode: decide thinking per request from conversation state instead of
// the fixed Pi level. Enabled via /harness auto, cleared by /harness <level>.
let autoThinking = false;

// Extension-managed thinking level. Pi clamps its own level to "off" for
// llama.cpp models (provider reports reasoning:false), so /harness <level>
// stores the level here instead of going through pi.setThinkingLevel().
type QwenLevel = "off" | "low" | "medium" | "high" | "xhigh" | "max";
const QWEN_LEVELS: QwenLevel[] = ["off", "low", "medium", "high", "xhigh", "max"];
let manualLevel: QwenLevel = "off";

const LEVEL_BUDGETS: Record<QwenLevel, number | undefined> = {
	off: undefined,
	low: 1024,
	medium: 2048,
	high: 4096,
	xhigh: 8192,
	max: undefined, // thinking on, no budget cap
};

// Auto mode borrows the manual level's budget; "off" falls back to medium.
function autoThinkBudget(): number | undefined {
	return LEVEL_BUDGETS[manualLevel === "off" ? "medium" : manualLevel];
}

// Thinking mode is persisted in ~/.pi/agent/geocine.json (qwen block).
// It used to be module state only, so every restart or /reload silently
// dropped auto mode back to manual "off" — the "auto stopped working" bug.
function hydrateQwenState(): void {
	const q = loadConfig().qwen ?? {};
	autoThinking = q.auto === true;
	manualLevel = q.level && QWEN_LEVELS.includes(q.level as QwenLevel) ? (q.level as QwenLevel) : "off";
}
hydrateQwenState();

function persistQwenState(): void {
	updateGlobalConfig((g) => {
		g.qwen = { ...(g.qwen ?? {}), auto: autoThinking, level: manualLevel };
	});
}

const TOOL_ERROR_PATTERN = /\b(error|exception|failed|traceback|exited with code [1-9])\b/i;

function lastRelevantMessage(payload: JsonObject): { role: string; text: string } | undefined {
	const messages = Array.isArray(payload.messages) ? payload.messages : [];
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = asObject(messages[i]);
		if (!msg) continue;
		const role = String(msg.role ?? "");
		if (role === "system") continue;
		let text = "";
		if (typeof msg.content === "string") text = msg.content;
		else if (Array.isArray(msg.content)) {
			text = msg.content
				.map((block) => {
					const obj = asObject(block);
					return typeof obj?.text === "string" ? obj.text : "";
				})
				.join("\n");
		}
		return { role, text };
	}
	return undefined;
}

function resolveThinking(
	payload: JsonObject,
	ctx: ExtensionContext,
): { enabled: boolean; budget: number | undefined } {
	if (isQwenCoder(ctx)) return { enabled: false, budget: undefined };
	if (!autoThinking) {
		return { enabled: manualLevel !== "off", budget: LEVEL_BUDGETS[manualLevel] };
	}
	// Auto policy: think on fresh user input and after failed tools; stay in
	// fast non-thinking mode while the tool loop is running smoothly.
	const last = lastRelevantMessage(payload);
	if (last?.role === "tool") {
		if (TOOL_ERROR_PATTERN.test(last.text)) {
			return { enabled: true, budget: autoThinkBudget() };
		}
		return { enabled: false, budget: undefined };
	}
	return { enabled: true, budget: autoThinkBudget() };
}

function patchThinking(payload: JsonObject, ctx: ExtensionContext): JsonObject {
	// llama.cpp reads enable_thinking only from chat_template_kwargs
	// (tools/server/server-common.cpp); a top-level field is ignored.
	// Prior-turn <think> stripping is the template default (train/infer
	// match per the Qwen3 report), so nothing to send for that.
	const { enabled, budget } = resolveThinking(payload, ctx);
	const next = mergeChatTemplateKwargs(payload, { enable_thinking: enabled });
	if (enabled && budget !== undefined) {
		// llama.cpp reasoning-budget sampler (tools/server/server-schema.cpp):
		// once the budget is spent it forces the message + end tag, the same
		// mechanism the Qwen3 report describes for budgeted thinking.
		next.reasoning_budget_tokens = budget;
		next.reasoning_budget_start_tag = "<think>";
		next.reasoning_budget_end_tags = ["</think>"];
		next.reasoning_budget_message = THINK_BUDGET_CUTOFF;
	}
	// Qwen3 Technical Report §4.6 sampling:
	// thinking: T=0.6 top_p=0.95 top_k=20; non-thinking: T=0.7 top_p=0.8 top_k=20
	if (next.temperature === undefined) next.temperature = enabled ? 0.6 : 0.7;
	if (next.top_p === undefined) next.top_p = enabled ? 0.95 : 0.8;
	if (next.top_k === undefined) next.top_k = 20;
	// Qwen recommends min-p 0; llama-server's built-in default is 0.05.
	if (next.min_p === undefined) next.min_p = 0;
	return next;
}

function statusText(ctx: ExtensionContext): string {
	const mode = isQwenCoder(ctx)
		? "focus"
		: autoThinking
			? "auto"
			: manualLevel === "off"
				? "focus"
				: `think:${manualLevel}`;
	return `qwen ${mode}`;
}

let lastNotifyKey = "";

export const qwenHarness: ModelHarness = {
	id: "qwen",
	behaviors: [
		"tool-call repair: name aliases, arg remapping, XML tool-call recovery (any provider)",
		"llama.cpp: relaxes tool schemas that crash the grammar converter",
		"llama.cpp: thinking control with budgets + Qwen3 sampling defaults (/harness <level>|auto)",
	],
	commandHint: "off|low|medium|high|xhigh|max|auto",
	matches: isQwenModel,
	status: statusText,

	onSessionStart() {
		hydrateQwenState();
	},

	async onCommand(args, ctx, refreshStatus) {
		const arg = args.trim().toLowerCase();
		if (arg === "auto") {
			autoThinking = !autoThinking;
			persistQwenState();
			refreshStatus(ctx);
			ctx.ui.notify(
				autoThinking
					? `Thinking auto ON: think on user turns and tool errors (budget ${autoThinkBudget()}), focus during tool loops. Set budget via /harness <level>, toggle off with /harness auto.`
					: `Thinking auto OFF: back to level "${manualLevel}"`,
				"info",
			);
			return;
		}
		if (QWEN_LEVELS.includes(arg as QwenLevel)) {
			manualLevel = arg as QwenLevel;
			// "off" exits auto entirely; other levels keep auto on and
			// just set the budget its thinking turns use.
			if (manualLevel === "off") autoThinking = false;
			persistQwenState();
			refreshStatus(ctx);
			const budget = LEVEL_BUDGETS[manualLevel];
			const suffix = autoThinking ? " (auto stays on, budget applied to its thinking turns)" : "";
			ctx.ui.notify(
				manualLevel === "off"
					? "Qwen thinking off (focus)"
					: `Qwen thinking ${manualLevel}${budget !== undefined ? `, budget ${budget} tokens` : ", no budget cap"}${suffix}`,
				"info",
			);
			return;
		}
		if (arg) {
			ctx.ui.notify(`Unknown option "${arg}" — use ${QWEN_LEVELS.join(", ")}, auto`, "error");
			return;
		}
		const model = ctx.model;
		const label = model ? `${model.provider}/${model.id}` : "none";
		const budget = LEVEL_BUDGETS[manualLevel];
		const mode = isQwenCoder(ctx)
			? "coder: thinking forced off"
			: autoThinking
				? "auto: thinking per request"
				: manualLevel === "off"
					? "focus, thinking off"
					: `thinking ${manualLevel}${budget !== undefined ? `, budget ${budget}` : ", no cap"}`;
		ctx.ui.notify(
			isQwenModel(ctx)
				? `Qwen harness ON for ${label} (${mode})`
				: `Qwen harness idle (model name does not contain "qwen"): ${label}`,
			"info",
		);
	},

	beforeProviderRequest(event, ctx) {
		// Payload patches use llama.cpp server fields (chat_template_kwargs,
		// reasoning_budget_*); hosted providers get the untouched payload.
		if (!isLlamaCpp(ctx)) return;
		const payload = asObject(event.payload);
		if (!payload) return;
		return patchThinking(patchLlamaTools(payload), ctx);
	},

	async onMessageEnd(event, ctx) {
		const message = event.message as {
			role?: string;
			stopReason?: string;
			content?: unknown[];
		};
		if (message.role !== "assistant") return;
		if (message.stopReason === "error" || message.stopReason === "aborted" || message.stopReason === "length") {
			return;
		}

		const content = Array.isArray(message.content) ? [...message.content] : [];
		let changed = false;

		const remapped = content.map((block) => {
			const call = asObject(block);
			if (!call || call.type !== "toolCall" || typeof call.name !== "string") return block;
			const next = remapToolCall({
				name: call.name,
				arguments: call.arguments,
				id: typeof call.id === "string" ? call.id : undefined,
			});
			if (next.name === call.name && JSON.stringify(next.arguments) === JSON.stringify(call.arguments)) {
				return block;
			}
			changed = true;
			return { ...call, name: next.name, arguments: next.arguments };
		});

		const hasNativeCalls = remapped.some((block) => asObject(block)?.type === "toolCall");
		const text = remapped
			.map((block) => {
				const obj = asObject(block);
				return obj?.type === "text" && typeof obj.text === "string" ? obj.text : "";
			})
			.join("");

		if (!hasNativeCalls && text && xmlBlocksDominate(text)) {
			const extracted = extractXmlToolCalls(text);
			if (extracted.length > 0) {
				const remaining = stripRecoveredXml(text);
				const withoutText = remapped.filter((block) => asObject(block)?.type !== "text");
				const recoveredCalls = extracted.map((call, index) => {
					const mapped = remapToolCall({ name: call.name, arguments: call.args });
					return {
						type: "toolCall",
						id: newXmlCallId(index),
						name: mapped.name,
						arguments: mapped.arguments,
					};
				});
				changed = true;
				const nextContent = [
					...(remaining ? [{ type: "text", text: remaining }] : []),
					...withoutText,
					...recoveredCalls,
				];
				const key = `${ctx.model?.id}:${extracted.map((c) => c.name).join(",")}`;
				if (key !== lastNotifyKey) {
					lastNotifyKey = key;
					ctx.ui.notify(`Qwen harness recovered ${extracted.length} XML tool call(s)`, "info");
				}
				return { message: { ...message, content: nextContent } as typeof event.message };
			}
		}

		if (!changed) return;
		return { message: { ...message, content: remapped } as typeof event.message };
	},

	async onToolCall(event, _ctx) {
		const input = event.input as JsonObject | undefined;
		if (!input) return;
		const mapped = remapArgs(canonicalToolName(event.toolName), input);
		for (const key of Object.keys(input)) delete input[key];
		Object.assign(input, mapped);
		return undefined;
	},
};

// Note on the removed session events: index.ts owns session_start /
// model_select / thinking_level_select / session_shutdown wiring and calls
// refreshStatus generically. Auto mode is deliberately NOT cleared on
// thinking_level_select: Pi's built-in llama.cpp provider registers models
// with reasoning:false, so Pi clamps the level to "off" (firing that event)
// on every switch to a llama.cpp model — those events are clamps, not user
// intent, and /thinking cannot control llama.cpp Qwen anyway. /harness auto
// is the only toggle.
