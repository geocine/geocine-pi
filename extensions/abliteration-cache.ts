// abliteration-cache: prompt-cache routing hint for the abliteration-ai
// provider.
//
// abliteration.ai caches prompt prefixes automatically and bills cache reads
// at 10% of the input rate, but reuse is best-effort: routing hints
// (prompt_cache_key on chat completions, or the x-abliteration-session-id
// header) improve the chance that related requests land on the same cached
// prefix. pi sends neither, so a long conversation can hop backends and
// re-process an unchanged prefix at full price.
//
// This injects prompt_cache_key = "pi-<session id>" into every
// chat-completions payload for the provider: one pi session = one logical
// conversation = one stable, opaque affinity value (their docs' guidance).
// Everything else caching needs is already true of pi's requests: stable
// system prompt and tool ordering first, new messages appended last, and
// pi's openai-completions client sets stream_options.include_usage and maps
// usage.prompt_tokens_details.cached_tokens (the field abliteration
// reports) into usage.cacheRead — so hits are visible in /usage and billed
// with the model's cacheRead rate.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const PROVIDER = "abliteration-ai";

export default function abliterationCache(pi: ExtensionAPI) {
	pi.on("before_provider_request", (event, ctx) => {
		if (String(ctx.model?.provider ?? "") !== PROVIDER) return;
		const payload = event.payload;
		if (!payload || typeof payload !== "object" || Array.isArray(payload)) return;
		const body = payload as Record<string, unknown>;
		if (body.prompt_cache_key !== undefined) return;
		const sessionId = ctx.sessionManager.getSessionId();
		if (!sessionId) return;
		return { ...body, prompt_cache_key: `pi-${sessionId}` };
	});
}
