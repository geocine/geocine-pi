// Web provider registry and selection for web_fetch / web_search.
//
// Selection: `web.provider` in geocine.json pins one by id; unset or "auto"
// takes the first available provider in PROVIDERS order. builtin is always
// available, so auto never fails. To add a provider, create a sibling file
// and append it here — keyed providers go before builtin so auto prefers
// them the moment their key appears.

import type { WebConfig } from "../config.ts";
import { builtinProvider } from "./builtin.ts";
import { tinyFishProvider } from "./tinyfish.ts";
import type { WebProvider } from "./types.ts";

export type { WebFetchOptions, WebFetchResult, WebProvider, WebSearchOptions, WebSearchResult } from "./types.ts";

/** Ordered: auto mode picks the first available entry. */
export const PROVIDERS: WebProvider[] = [tinyFishProvider, builtinProvider];

export function resolveWebProvider(cfg: WebConfig | undefined): WebProvider {
	const wanted = cfg?.provider?.trim().toLowerCase();
	if (wanted && wanted !== "auto") {
		const provider = PROVIDERS.find((p) => p.id === wanted);
		if (!provider) {
			throw new Error(`Unknown web.provider "${wanted}". Available: ${PROVIDERS.map((p) => p.id).join(", ")}, auto`);
		}
		if (!provider.available()) {
			throw new Error(`web.provider "${wanted}" is configured but not available — it requires: ${provider.requires}`);
		}
		return provider;
	}
	return PROVIDERS.find((p) => p.available()) ?? builtinProvider;
}

/**
 * Auto-mode fallback: when the preferred provider fails at runtime, retry
 * once with builtin (unless builtin was already the one that failed, or the
 * user pinned a provider — a pinned provider's errors must surface).
 */
export function fallbackProviderFor(used: WebProvider, cfg: WebConfig | undefined): WebProvider | undefined {
	const pinned = cfg?.provider?.trim().toLowerCase();
	if (pinned && pinned !== "auto") return undefined;
	if (used.id === builtinProvider.id) return undefined;
	return builtinProvider;
}
