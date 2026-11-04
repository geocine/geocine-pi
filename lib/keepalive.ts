// Worker prompt-cache keep-alive during a consult.
//
// While a consult runs (approval dialog + consultant, up to ~15 min) the
// worker sits idle, and a cloud provider's prompt cache expires after a
// few minutes without use. Every PING_AFTER_MS of worker silence this
// replays the worker's LAST request byte-for-byte with the output capped
// to a token or so: same tools, system prompt, messages, and session
// affinity, so the provider reads (and re-warms) the cached prefix. A
// ping costs one cache read; a miss costs re-prefilling the whole session.
//
// The last payload is captured at the end of geocine's before_provider_request
// chain (extensions/models/index.ts, the last geocine payload hook). A
// provider whose payload another package rewrites after that is skipped:
// a replay without that rewrite would miss the cache and write a new entry.
// Self-hosted workers are skipped too — a llama.cpp KV cache doesn't expire.

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { selfHostedUrl } from "./availability.ts";

/** Ping after this much worker silence (cloud TTLs are ~5 min). */
const PING_AFTER_MS = 4 * 60_000;
const CHECK_EVERY_MS = 15_000;
/** Providers whose payload a later (non-geocine) hook rewrites. */
const REWRITTEN_LATER = new Set(["meta"]);

interface Captured {
	payload: Record<string, unknown>;
	provider: string;
	modelId: string;
	api: string;
	/** Last time the worker's cache was used (real request or ping). */
	ts: number;
}

let last: Captured | undefined;
/** True while a ping is in flight, so its own payload is never captured. */
let pinging = false;

/** Record the worker's final outgoing payload (call from the last payload hook). */
export function recordWorkerPayload(payload: unknown, ctx: ExtensionContext): void {
	if (pinging || !payload || typeof payload !== "object" || Array.isArray(payload)) return;
	const model = ctx.model as { provider?: string; id?: string; api?: string } | undefined;
	if (!model?.provider || !model.id) return;
	last = { payload: payload as Record<string, unknown>, provider: model.provider, modelId: model.id, api: model.api ?? "", ts: Date.now() };
}

/** The captured payload with output capped, or undefined when this API can't be pinged safely. */
function pingBody(api: string, payload: Record<string, unknown>): Record<string, unknown> | undefined {
	const body = structuredClone(payload);
	switch (api) {
		case "openai-completions":
		case "mistral-conversations":
			if ("max_completion_tokens" in body) body.max_completion_tokens = 1;
			else body.max_tokens = 1;
			return body;
		case "openai-responses":
		case "azure-openai-responses":
		case "openai-codex-responses":
			body.max_output_tokens = 16; // the API's minimum
			return body;
		case "anthropic-messages": {
			// Extended thinking needs max_tokens > budget, and changing the
			// thinking config invalidates the message cache — skip.
			const thinking = body.thinking as { type?: string } | undefined;
			if (thinking && thinking.type !== "disabled") return undefined;
			body.max_tokens = 1;
			return body;
		}
		case "google-generative-ai":
		case "google-vertex": {
			const gc = (body.generationConfig ?? {}) as Record<string, unknown>;
			body.generationConfig = { ...gc, maxOutputTokens: 1 };
			return body;
		}
		default:
			return undefined;
	}
}

export interface KeepAliveStats {
	pings: number;
	/** Cached input tokens reported by the last ping (0 = it missed). */
	lastCacheRead?: number;
	skipped?: string;
}

/**
 * Keep the worker's cache warm until the returned stop() is called.
 * No-op (with a reason in stats.skipped) when the worker can't be pinged.
 */
export function startKeepAlive(ctx: ExtensionContext, onPing?: (stats: KeepAliveStats) => void): { stop: () => KeepAliveStats } {
	const stats: KeepAliveStats = { pings: 0 };
	const model = ctx.model as ({ provider?: string; id?: string; baseUrl?: string } & Parameters<ExtensionContext["modelRegistry"]["complete"]>[0]) | undefined;
	const skip = (why: string) => {
		stats.skipped = why;
		return { stop: () => stats };
	};
	if (!model?.provider || !model.id) return skip("no worker model");
	if (model.baseUrl && selfHostedUrl(model.baseUrl)) return skip("self-hosted worker (KV cache doesn't expire)");
	if (REWRITTEN_LATER.has(model.provider)) return skip(`${model.provider} payloads are rewritten after geocine's hooks`);

	const controller = new AbortController();
	const tick = async () => {
		const snap = last;
		if (pinging || !snap || snap.provider !== model.provider || snap.modelId !== model.id) return;
		if (Date.now() - snap.ts < PING_AFTER_MS) return;
		const body = pingBody(snap.api, snap.payload);
		if (!body) {
			stats.skipped = `${snap.api || "this API"} can't be pinged without changing the cache key`;
			return;
		}
		pinging = true;
		try {
			const res = await ctx.modelRegistry.complete(
				model,
				{ systemPrompt: "", messages: [] },
				{
					signal: controller.signal,
					// Same affinity routing as the worker's own requests.
					sessionId: ctx.sessionManager.getSessionId(),
					onPayload: () => body,
				},
			);
			stats.pings++;
			stats.lastCacheRead = res.usage?.cacheRead ?? 0;
			snap.ts = Date.now();
			onPing?.(stats);
		} catch {
			// best effort: a failed ping just means the next turn may miss
			snap.ts = Date.now(); // don't hammer a failing provider every tick
		} finally {
			pinging = false;
		}
	};
	const timer = setInterval(() => void tick(), CHECK_EVERY_MS);
	return {
		stop: () => {
			clearInterval(timer);
			controller.abort();
			return stats;
		},
	};
}
