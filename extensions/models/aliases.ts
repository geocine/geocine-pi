// Transparent tool aliasing: advertise to the model the tool names (and
// parameter schemas) its scaffold RL-trained it on, while pi's registry and
// the stored session transcript stay canonical.
//
// Why: models revert to trained tool dialects under pressure (the Qwen XML
// recoveries are exactly that). Renaming at the provider wire boundary
// removes the mismatch at the source instead of repairing it after.
//
// Direction 1 (outbound, before_provider_request): rename tool definitions,
// rewrite the system prompt's "- name:" tool list lines, and rewrite
// historical assistant tool calls so the model sees one consistent dialect.
// The transform is deterministic, so replays are byte-stable across requests
// and the llama.cpp prefix cache keeps working.
//
// Direction 2 (inbound, message_end): map advertised names/args on finalized
// assistant tool calls back to canonical before pi resolves and executes.
//
// Both directions are applied generically by index.ts from the active
// harness's `toolAliases` table.

type JsonObject = Record<string, unknown>;

export interface ToolAlias {
	/** pi's canonical tool name (what the registry and transcript use). */
	canonical: string;
	/** The name the model was RL-trained on (what the wire shows). */
	advertised: string;
	/** Replace the advertised parameter schema with the trained one. Omit to expose pi's schema under the alias name. */
	parameters?: JsonObject;
	/** Replace the tool description. Omit to keep pi's. */
	description?: string;
	/** Convert canonical args to the trained dialect for history replay. Omit for pass-through. */
	toAdvertisedArgs?: (args: JsonObject) => JsonObject;
	/** Convert trained-dialect args from a live model call to canonical. Omit for pass-through. */
	toCanonicalArgs?: (args: JsonObject) => JsonObject;
}

function asObject(value: unknown): JsonObject | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	return value as JsonObject;
}

function parseArgs(raw: unknown): JsonObject | undefined {
	const obj = asObject(raw);
	if (obj) return obj;
	if (typeof raw === "string") {
		try {
			return asObject(JSON.parse(raw));
		} catch {
			return undefined;
		}
	}
	return undefined;
}

/** Copy args, renaming keys per map; optionally keep only listed (post-rename) keys. */
export function rekey(
	args: JsonObject,
	map: Record<string, string>,
	only?: string[],
): JsonObject {
	const out: JsonObject = {};
	for (const [key, value] of Object.entries(args)) {
		if (value === undefined) continue;
		out[map[key] ?? key] = value;
	}
	if (!only) return out;
	const kept: JsonObject = {};
	for (const key of only) {
		if (out[key] !== undefined) kept[key] = out[key];
	}
	return kept;
}

/** Trained dialects use millisecond timeouts; pi's bash takes seconds. */
export function msToSeconds(value: unknown): number | undefined {
	const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
	if (!Number.isFinite(n) || n <= 0) return undefined;
	return Math.max(1, Math.ceil(n / 1000));
}

export function secondsToMs(value: unknown): number | undefined {
	const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
	if (!Number.isFinite(n) || n <= 0) return undefined;
	return n * 1000;
}

function byCanonical(aliases: ToolAlias[]): Map<string, ToolAlias> {
	return new Map(aliases.map((a) => [a.canonical, a]));
}

function byAdvertised(aliases: ToolAlias[]): Map<string, ToolAlias> {
	return new Map(aliases.map((a) => [a.advertised, a]));
}

/** Rename one tool definition entry (chat-completions {function:{...}} or responses-API flat shape). */
function renameToolDefinition(tool: unknown, out: Map<string, ToolAlias>): unknown {
	const obj = asObject(tool);
	if (!obj) return tool;
	const fn = asObject(obj.function);
	const carrier = fn ?? obj;
	const name = typeof carrier.name === "string" ? carrier.name : undefined;
	if (!name) return tool;
	const alias = out.get(name);
	if (!alias) return tool;
	const next: JsonObject = { ...carrier, name: alias.advertised };
	if (alias.description) next.description = alias.description;
	if (alias.parameters) next.parameters = alias.parameters;
	return fn ? { ...obj, function: next } : next;
}

/** Rewrite "- name: snippet" tool list lines in the system prompt text. */
function renameSystemText(text: string, out: Map<string, ToolAlias>): string {
	return text.replace(/^(- )([a-zA-Z0-9_]+)(:)/gm, (full, dash: string, name: string, colon: string) => {
		const alias = out.get(name);
		return alias ? `${dash}${alias.advertised}${colon}` : full;
	});
}

function renameCall(name: string, rawArgs: unknown, alias: ToolAlias, direction: "out" | "in"): {
	name: string;
	args: unknown;
} {
	const nextName = direction === "out" ? alias.advertised : alias.canonical;
	const convert = direction === "out" ? alias.toAdvertisedArgs : alias.toCanonicalArgs;
	if (!convert) return { name: nextName, args: rawArgs };
	const parsed = parseArgs(rawArgs);
	if (!parsed) return { name: nextName, args: rawArgs };
	const converted = convert(parsed);
	// Preserve the original encoding: string args stay strings.
	return { name: nextName, args: typeof rawArgs === "string" ? JSON.stringify(converted) : converted };
}

/** Rewrite tool_calls on one outbound history message (chat-completions shape). */
function renameMessageToolCalls(message: unknown, out: Map<string, ToolAlias>): unknown {
	const obj = asObject(message);
	if (!obj) return message;
	let changed = false;
	const next: JsonObject = { ...obj };

	if (Array.isArray(obj.tool_calls)) {
		next.tool_calls = obj.tool_calls.map((tc) => {
			const call = asObject(tc);
			const fn = asObject(call?.function);
			const name = typeof fn?.name === "string" ? fn.name : undefined;
			if (!call || !fn || !name) return tc;
			const alias = out.get(name);
			if (!alias) return tc;
			changed = true;
			const renamed = renameCall(name, fn.arguments, alias, "out");
			return { ...call, function: { ...fn, name: renamed.name, arguments: renamed.args } };
		});
	}

	// Some templates carry a name on role:"tool" result messages; keep it consistent.
	if (obj.role === "tool" && typeof obj.name === "string" && out.has(obj.name)) {
		next.name = out.get(obj.name)!.advertised;
		changed = true;
	}

	if (obj.role === "system" && typeof obj.content === "string") {
		const renamed = renameSystemText(obj.content, out);
		if (renamed !== obj.content) {
			next.content = renamed;
			changed = true;
		}
	}

	return changed ? next : message;
}

/** Rewrite one responses-API input item (function_call / function_call_output). */
function renameInputItem(item: unknown, out: Map<string, ToolAlias>): unknown {
	const obj = asObject(item);
	if (!obj) return item;
	if (obj.type === "function_call" && typeof obj.name === "string") {
		const alias = out.get(obj.name);
		if (!alias) return item;
		const renamed = renameCall(obj.name, obj.arguments, alias, "out");
		return { ...obj, name: renamed.name, arguments: renamed.args };
	}
	return item;
}

/**
 * Outbound: apply aliases to a provider payload. Returns a new payload, or
 * undefined when nothing changed.
 */
export function applyAliasesToPayload(payload: unknown, aliases: ToolAlias[]): JsonObject | undefined {
	const obj = asObject(payload);
	if (!obj || aliases.length === 0) return undefined;
	const out = byCanonical(aliases);
	let changed = false;
	const next: JsonObject = { ...obj };

	if (Array.isArray(obj.tools)) {
		const tools = obj.tools.map((t) => renameToolDefinition(t, out));
		if (tools.some((t, i) => t !== (obj.tools as unknown[])[i])) {
			next.tools = tools;
			changed = true;
		}
	}

	if (Array.isArray(obj.messages)) {
		const messages = obj.messages.map((m) => renameMessageToolCalls(m, out));
		if (messages.some((m, i) => m !== (obj.messages as unknown[])[i])) {
			next.messages = messages;
			changed = true;
		}
	}

	if (Array.isArray(obj.input)) {
		const input = obj.input.map((m) => renameInputItem(m, out));
		if (input.some((m, i) => m !== (obj.input as unknown[])[i])) {
			next.input = input;
			changed = true;
		}
	}

	// Responses API carries the system prompt in "instructions".
	if (typeof obj.instructions === "string") {
		const renamed = renameSystemText(obj.instructions, out);
		if (renamed !== obj.instructions) {
			next.instructions = renamed;
			changed = true;
		}
	}

	return changed ? next : undefined;
}

/** Name of a tool definition entry in either wire shape. */
function toolDefinitionName(tool: unknown): string | undefined {
	const obj = asObject(tool);
	if (!obj) return undefined;
	const carrier = asObject(obj.function) ?? obj;
	return typeof carrier.name === "string" ? carrier.name : undefined;
}

/**
 * Outbound: remove named tool definitions from a payload (used to hide one
 * harness's owned tools from other models). Returns a new payload, or
 * undefined when nothing changed.
 */
export function removeToolsFromPayload(payload: unknown, names: Set<string>): JsonObject | undefined {
	const obj = asObject(payload);
	if (!obj || names.size === 0 || !Array.isArray(obj.tools)) return undefined;
	const tools = obj.tools.filter((t) => {
		const name = toolDefinitionName(t);
		return name === undefined || !names.has(name);
	});
	if (tools.length === obj.tools.length) return undefined;
	return { ...obj, tools };
}

/**
 * Inbound: map advertised tool-call names/args on a finalized assistant
 * message (pi AgentMessage content blocks) back to canonical. Returns a new
 * message, or undefined when nothing changed.
 */
export function restoreCanonicalToolCalls<T>(message: T, aliases: ToolAlias[]): T | undefined {
	const blocks = (message as { content?: unknown }).content;
	if (aliases.length === 0 || !Array.isArray(blocks)) return undefined;
	const inbound = byAdvertised(aliases);
	let changed = false;
	const content = blocks.map((block) => {
		const call = asObject(block);
		if (!call || call.type !== "toolCall" || typeof call.name !== "string") return block;
		const alias = inbound.get(call.name);
		if (!alias) return block;
		changed = true;
		const renamed = renameCall(call.name, call.arguments, alias, "in");
		return { ...call, name: renamed.name, arguments: renamed.args ?? {} };
	});
	if (!changed) return undefined;
	return { ...message, content };
}
