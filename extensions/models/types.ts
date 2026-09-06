// ModelHarness: the contract for per-model-family custom behavior.
//
// Each model family that needs pi-side accommodation gets ONE file in this
// directory exporting a ModelHarness. index.ts owns the pi event wiring and
// dispatches every hook to the single harness whose matches() claims the
// active model (first match in the registry wins). Harness files never call
// pi.on() themselves — that keeps "which models do we customize, and how"
// answerable by listing this directory (or running /harness at runtime).

import type {
	BeforeProviderRequestEvent,
	ExtensionAPI,
	ExtensionContext,
	MessageEndEvent,
	ToolCallEvent,
	ToolCallEventResult,
} from "@earendil-works/pi-coding-agent";
import type { ToolAlias } from "./aliases.ts";

// pi does not re-export MessageEndEventResult from the package root; this is
// the same shape (replace the finalized message, keeping the original role).
export interface MessageEndResult {
	message?: MessageEndEvent["message"];
}

export interface ModelHarness {
	/** Stable id, shown in the footer status and /harness output. */
	id: string;
	/** One line per custom behavior; /harness lists these. Empty = declared but no behaviors yet. */
	behaviors: string[];
	/** Claim the active model. Dispatch goes to the first matching harness in the registry. */
	matches(ctx: ExtensionContext | undefined): boolean;
	/**
	 * Transparent tool aliases: advertise the trained tool dialect on the wire
	 * while pi stays canonical. Applied generically by index.ts (outbound
	 * rename in before_provider_request, inbound restore in message_end).
	 * Disable globally with `"harness": { "aliases": false }` in geocine.json.
	 */
	toolAliases?: ToolAlias[];
	/**
	 * Register model-specific tools this harness owns (e.g. apply_patch for
	 * OpenAI). Called once at extension load; pi executes them like any tool.
	 */
	registerTools?(pi: ExtensionAPI): void;
	/**
	 * Names of registered tools that should only be ADVERTISED while this
	 * harness is active. index.ts strips them from other models' requests so
	 * one model's trained tools do not pollute another's tool list.
	 */
	ownedTools?: string[];
	/** Footer status text while active. Omit to show the harness id. */
	status?(ctx: ExtensionContext): string;
	/** One-line usage hint for /harness args this harness accepts (shown in the registry listing). */
	commandHint?: string;
	/** Handle "/harness <args>" routed to this harness. refreshStatus re-renders the footer. */
	onCommand?(args: string, ctx: ExtensionContext, refreshStatus: (ctx: ExtensionContext) => void): Promise<void>;
	/** Called for every harness (not just the active one) on session_start. */
	onSessionStart?(ctx: ExtensionContext): void;
	/** Patch the outgoing provider payload. Same result semantics as pi's before_provider_request. */
	beforeProviderRequest?(event: BeforeProviderRequestEvent, ctx: ExtensionContext): unknown;
	/** Repair the finalized assistant message. Same result semantics as pi's message_end. */
	onMessageEnd?(
		event: MessageEndEvent,
		ctx: ExtensionContext,
	): MessageEndResult | undefined | Promise<MessageEndResult | undefined>;
	/** Normalize tool-call input (mutate event.input in place). Same result semantics as pi's tool_call. */
	onToolCall?(
		event: ToolCallEvent,
		ctx: ExtensionContext,
	): ToolCallEventResult | undefined | Promise<ToolCallEventResult | undefined>;
}

/** Lowercased "id name" blob of the active model, for substring matching. */
export function modelBlob(ctx: ExtensionContext | undefined): string {
	const model = ctx?.model as { id?: unknown; name?: unknown; provider?: unknown } | undefined;
	return `${model?.id ?? ""} ${model?.name ?? ""}`.toLowerCase();
}

/** Provider id of the active model ("" when no model). */
export function modelProvider(ctx: ExtensionContext | undefined): string {
	return String(ctx?.model?.provider ?? "");
}
