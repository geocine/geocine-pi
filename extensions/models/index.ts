// Model harness dispatcher: the single pi extension for all per-model-family
// custom behavior. Each family lives in its own file next to this one and
// exports a ModelHarness (see types.ts); this file owns the pi event wiring
// and routes every hook to the first harness whose matches() claims the
// active model. `/harness` shows the registry and what each harness does.
//
// To customize a new model family: add <family>.ts exporting a ModelHarness,
// then append it to HARNESSES below. Never call pi.on() from harness files.

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "../../lib/config.ts";
import { richSelect, type SelectItem } from "../../lib/rich-select.ts";
import { applyAliasesToPayload, removeToolsFromPayload, restoreCanonicalToolCalls } from "./aliases.ts";
import { deepseekHarness } from "./deepseek.ts";
import { grokHarness } from "./grok.ts";
import { openaiHarness } from "./openai.ts";
import { qwenHarness } from "./qwen.ts";
import { registerTodoTool, rehydrateTodos } from "./todo.ts";
import type { ModelHarness } from "./types.ts";
import { registerWebTools } from "./web.ts";

const HARNESSES: ModelHarness[] = [qwenHarness, grokHarness, openaiHarness, deepseekHarness];

const STATUS_ID = "model-harness";

function activeHarness(ctx: ExtensionContext | undefined): ModelHarness | undefined {
	return HARNESSES.find((h) => h.matches(ctx));
}

function refreshStatus(ctx: ExtensionContext): void {
	if (!ctx.ui?.setStatus) return;
	const harness = activeHarness(ctx);
	// A harness with no behaviors is a declared slot, not active machinery;
	// keep the footer quiet for it.
	if (!harness || harness.behaviors.length === 0) {
		ctx.ui.setStatus(STATUS_ID, undefined);
		return;
	}
	ctx.ui.setStatus(STATUS_ID, harness.status?.(ctx) ?? harness.id);
}

/** One-line state for the /geocine hub row. */
export function harnessHubLine(ctx: ExtensionContext): string {
	const active = activeHarness(ctx);
	if (active) return `${active.status?.(ctx) ?? active.id} — thinking, dialects, model tools`;
	return `no harness for current model · ${HARNESSES.map((h) => h.id).join(" / ")}`;
}

/**
 * Interactive harness registry (also the no-arg /harness handler): pick a
 * harness, see its behaviors, run its action rows (values go to onCommand).
 */
export async function harnessMenu(ctx: ExtensionContext): Promise<void> {
	const model = ctx.model;
	const label = model ? `${model.provider}/${model.id}` : "none";
	const active = activeHarness(ctx);
	for (;;) {
		const items: SelectItem[] = HARNESSES.map((h) => ({
			value: h.id,
			label: `${h === active ? "* " : "  "}${h.id}`,
			description:
				h.behaviors.length === 0
					? `declared slot — no custom behaviors yet (extensions/models/${h.id}.ts)`
					: (h.summary ?? h.behaviors[0]),
		}));
		const picked = await richSelect(ctx, "Model harnesses (* = active)", items, {
			header: [`model: ${label}`],
		});
		if (!picked) return;
		const target = HARNESSES.find((h) => h.id === picked);
		if (!target) return;
		const actions = target.menuItems?.(ctx) ?? [];
		if (actions.length === 0 || !target.onCommand) {
			// Nothing to configure: show the behavior list and reopen the registry.
			ctx.ui.notify(
				[`${target.id}:`, ...target.behaviors.map((b) => `- ${b}`)].join("\n") ||
					`${target.id}: no custom behaviors yet`,
				"info",
			);
			continue;
		}
		const act = await richSelect(ctx, `${target.id}${target === active ? " (active)" : ""}`, actions, {
			header: target.behaviors.map((b) => `- ${b}`),
		});
		if (act === undefined) continue; // escape: back to the registry
		await target.onCommand(act, ctx, refreshStatus);
		return;
	}
}

export default function modelHarnessDispatcher(pi: ExtensionAPI) {
	for (const harness of HARNESSES) {
		harness.registerTools?.(pi);
	}
	// Shared trained-tool equivalents: every scaffold has a plan tool, and
	// qwen-code, grok-build + dsh train client web tools (codex's are hosted,
	// so web tools are in qwen/grok/deepseek ownedTools and hidden from
	// OpenAI models).
	registerTodoTool(pi);
	registerWebTools(pi);

	pi.registerCommand("harness", {
		description: "Model harnesses: no arg lists them; /harness [id] <args> routes to a harness (e.g. /harness auto)",
		handler: async (rawArgs, ctx) => {
			const input = String(rawArgs ?? "").trim();

			// No args: interactive registry panel (shared with /geocine harness).
			if (!input) {
				await harnessMenu(ctx);
				return;
			}

			// "/harness <id> <args>" targets a harness by name; otherwise the
			// args go to the active harness.
			const [first, ...rest] = input.split(/\s+/);
			const named = HARNESSES.find((h) => h.id === first.toLowerCase());
			const target = named ?? activeHarness(ctx);
			const args = named ? rest.join(" ") : input;
			if (!target) {
				ctx.ui.notify("No harness matches the current model. /harness <id> <args> targets one by name.", "error");
				return;
			}
			if (!target.onCommand) {
				ctx.ui.notify(`Harness "${target.id}" takes no arguments (no custom behaviors yet).`, "error");
				return;
			}
			await target.onCommand(args, ctx, refreshStatus);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		for (const harness of HARNESSES) harness.onSessionStart?.(ctx);
		rehydrateTodos(ctx);
		refreshStatus(ctx);
	});

	pi.on("model_select", async (_event, ctx) => {
		refreshStatus(ctx);
	});

	pi.on("thinking_level_select", async (_event, ctx) => {
		refreshStatus(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		ctx.ui?.setStatus?.(STATUS_ID, undefined);
	});

	function aliasesFor(harness: ModelHarness | undefined) {
		if (!harness?.toolAliases?.length) return undefined;
		if (loadConfig().harness?.aliases === false) return undefined;
		return harness.toolAliases;
	}

	// Tools owned by some harness are advertised only while that harness is
	// active; every other model gets them stripped from the request.
	function foreignOwnedTools(active: ModelHarness | undefined): Set<string> {
		const names = new Set<string>();
		for (const harness of HARNESSES) {
			if (harness === active) continue;
			for (const name of harness.ownedTools ?? []) {
				if (!active?.ownedTools?.includes(name)) names.add(name);
			}
		}
		return names;
	}

	pi.on("before_provider_request", (event, ctx) => {
		const harness = activeHarness(ctx);
		let payload = event.payload;
		const stripped = removeToolsFromPayload(payload, foreignOwnedTools(harness));
		if (stripped) payload = stripped;
		if (!harness) return stripped;
		// Outbound aliasing next, so harness payload patches (e.g. qwen's
		// llama.cpp schema relaxing) operate on the advertised schemas.
		const aliases = aliasesFor(harness);
		const aliased = aliases ? applyAliasesToPayload(payload, aliases) : undefined;
		if (aliased) payload = aliased;
		const nextEvent = payload !== event.payload ? { ...event, payload } : event;
		return harness.beforeProviderRequest?.(nextEvent, ctx) ?? (payload !== event.payload ? payload : undefined);
	});

	pi.on("message_end", async (event, ctx) => {
		const harness = activeHarness(ctx);
		if (!harness) return;
		// Inbound restore first, so harness repair logic sees canonical names.
		const aliases = aliasesFor(harness);
		const restored = aliases ? restoreCanonicalToolCalls(event.message, aliases) : undefined;
		const nextEvent = restored ? { ...event, message: restored } : event;
		const result = await harness.onMessageEnd?.(nextEvent, ctx);
		return result ?? (restored ? { message: restored } : undefined);
	});

	pi.on("tool_call", async (event, ctx) => {
		return activeHarness(ctx)?.onToolCall?.(event, ctx);
	});
}
