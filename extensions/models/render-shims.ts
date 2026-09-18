// Render shims: rendering-only tool registrations for advertised dialect names.
//
// Problem: pi's TUI creates the tool-call component from the STREAMED tool
// name — the advertised dialect name (run_shell_command, read_file, ...). It
// looks that name up in the tool registry for a renderer, finds nothing (only
// canonical tools are registered), and falls back to the generic bold-name +
// raw-JSON block. The canonical restore at message_end fixes the transcript
// and execution, but the TUI keeps the component it already created.
//
// Fix: register a tool under each advertised name whose only real job is
// renderCall — convert the dialect args back to canonical and draw the same
// compact header pi draws for the canonical tool. The shims are invisible
// everywhere else:
// - index.ts strips them from every provider payload, so no model ever sees
//   them as callable tools (the active harness re-adds the advertised name by
//   RENAMING the canonical tool, which is the aliasing contract).
// - restoreCanonicalToolCalls maps live calls back to canonical before pi
//   resolves a tool, so execute() never runs in normal operation; it returns
//   a redirect error as a failsafe.

import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type { ToolAlias } from "./aliases.ts";
import type { ModelHarness } from "./types.ts";

type JsonObject = Record<string, unknown>;

function asObject(value: unknown): JsonObject | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	return value as JsonObject;
}

function parseArgs(raw: unknown): JsonObject {
	const obj = asObject(raw);
	if (obj) return obj;
	if (typeof raw === "string") {
		try {
			return asObject(JSON.parse(raw)) ?? {};
		} catch {
			return {};
		}
	}
	return {};
}

function takeString(args: JsonObject, keys: string[]): string | undefined {
	for (const key of keys) {
		const value = args[key];
		if (typeof value === "string" && value.length > 0) return value;
	}
	return undefined;
}

function takeNumber(args: JsonObject, keys: string[]): number | undefined {
	for (const key of keys) {
		const value = args[key];
		if (typeof value === "number" && Number.isFinite(value)) return value;
	}
	return undefined;
}

/** One-line JSON preview for the generic fallback header. */
function compactJson(args: JsonObject): string {
	let text: string;
	try {
		text = JSON.stringify(args);
	} catch {
		text = "{...}";
	}
	return text.length > 120 ? `${text.slice(0, 117)}...` : text;
}

/**
 * Header line in the canonical tool's visual dialect. Args are CANONICAL
 * (already converted); they may be partial while streaming, so every field
 * is optional.
 */
function headerLine(canonical: string, args: JsonObject, theme: Theme): string {
	const title = (text: string) => theme.fg("toolTitle", theme.bold(text));
	const path = takeString(args, ["path"]);
	switch (canonical) {
		case "bash": {
			const command = takeString(args, ["command"]) ?? "...";
			const timeout = takeNumber(args, ["timeout"]);
			return title(`$ ${command}`) + (timeout ? theme.fg("muted", ` (timeout ${timeout}s)`) : "");
		}
		case "read": {
			const offset = takeNumber(args, ["offset"]);
			const limit = takeNumber(args, ["limit"]);
			const start = offset ?? 1;
			const range =
				offset === undefined && limit === undefined
					? ""
					: theme.fg("warning", `:${start}${limit !== undefined ? `-${start + limit - 1}` : ""}`);
			return `${title("read")} ${path ?? "..."}${range}`;
		}
		case "write":
			return `${title("write")} ${path ?? "..."}`;
		case "edit":
			return `${title("edit")} ${path ?? "..."}`;
		case "grep": {
			const pattern = takeString(args, ["pattern"]) ?? "...";
			return `${title("grep")} ${pattern}${path ? theme.fg("muted", ` in ${path}`) : ""}`;
		}
		case "find": {
			const pattern = takeString(args, ["pattern"]) ?? "...";
			return `${title("find")} ${pattern}${path ? theme.fg("muted", ` in ${path}`) : ""}`;
		}
		case "ls":
			return `${title("ls")} ${path ?? "."}`;
		case "todo": {
			const todos = Array.isArray(args.todos) ? args.todos.length : undefined;
			return title("todo") + (todos !== undefined ? theme.fg("muted", ` ${todos} item${todos === 1 ? "" : "s"}`) : "");
		}
		case "ask_user": {
			const question = takeString(args, ["question"]);
			return `${title("ask")} ${question ?? "..."}`;
		}
		default:
			return `${title(canonical)} ${theme.fg("muted", compactJson(args))}`;
	}
}

/** The active harness's alias for this advertised name, else the first registrant's. */
function pickAlias(candidates: ToolAlias[], active: ModelHarness | undefined): ToolAlias {
	const own = active?.toolAliases && candidates.find((a) => active.toolAliases!.includes(a));
	return own ?? candidates[0];
}

/**
 * Register one render shim per advertised dialect name (across all
 * harnesses) that differs from its canonical tool. Returns the shim names so
 * index.ts can strip them from every provider payload.
 */
export function registerRenderShims(
	pi: ExtensionAPI,
	harnesses: ModelHarness[],
	activeHarness: () => ModelHarness | undefined,
): Set<string> {
	// An advertised name that equals ANY canonical name (its own or another
	// dialect's) collides with a real registered tool; those aliases are
	// schema-only and already render through the real tool's renderer.
	const canonicalNames = new Set<string>();
	for (const harness of harnesses) {
		for (const alias of harness.toolAliases ?? []) canonicalNames.add(alias.canonical);
	}

	const shims = new Map<string, ToolAlias[]>();
	for (const harness of harnesses) {
		for (const alias of harness.toolAliases ?? []) {
			if (alias.advertised === alias.canonical || canonicalNames.has(alias.advertised)) continue;
			const list = shims.get(alias.advertised) ?? [];
			list.push(alias);
			shims.set(alias.advertised, list);
		}
	}

	for (const [advertised, candidates] of shims) {
		const canonical = candidates[0].canonical;
		pi.registerTool({
			name: advertised,
			label: advertised,
			description: `Rendering shim for the "${canonical}" tool's dialect name "${advertised}". Not callable: it is stripped from every model request, and dialect calls are restored to "${canonical}" before execution.`,
			parameters: Type.Object({}, { additionalProperties: true }),
			async execute() {
				// Reached only if the message_end restore did not run (e.g.
				// aliases disabled mid-session). Same outcome as the previous
				// unknown-tool error, with a more useful message.
				return {
					content: [
						{ type: "text" as const, text: `"${advertised}" is a dialect alias of "${canonical}"; call "${canonical}" instead.` },
					],
					isError: true,
					details: undefined,
				};
			},
			renderCall(args, theme) {
				const alias = pickAlias(candidates, activeHarness());
				const parsed = parseArgs(args);
				let canonicalArgs = parsed;
				try {
					if (alias.toCanonicalArgs) canonicalArgs = alias.toCanonicalArgs(parsed);
				} catch {
					canonicalArgs = parsed;
				}
				return new Text(headerLine(alias.canonical, canonicalArgs, theme), 0, 0);
			},
		});
	}

	return new Set(shims.keys());
}
