// tinyfish: TinyFish web search + fetch APIs (https://tinyfish.ai).
//
// Ported from pi-web-access's tinyfish.ts, trimmed to geocine-pi's needs:
// geocine.json / env-var key resolution instead of the credential-command
// machinery, no inline-content mode (the model follows up with web_fetch),
// and the tool-side output cap stays in models/web.ts. Search is a GET with
// native include/exclude domain filtering; fetch is a POST that renders the
// page server-side and returns Markdown (far better than the builtin
// provider's HTML stripping on JS-heavy pages). API keys are redacted from
// every error message before it can reach the transcript.

import { loadConfig } from "../config.ts";
import type { WebFetchOptions, WebFetchResult, WebProvider, WebSearchOptions, WebSearchResult } from "./types.ts";

const SEARCH_URL = "https://api.search.tinyfish.ai";
const FETCH_URL = "https://api.fetch.tinyfish.ai";
const SEARCH_TIMEOUT_MS = 60_000;
const FETCH_TIMEOUT_MS = 120_000;
const PER_URL_TIMEOUT_MS = 110_000;
const KEY_URL = "https://agent.tinyfish.ai/api-keys";

interface TinyFishSearchResult {
	title?: string | null;
	snippet?: string | null;
	url?: string | null;
}

interface TinyFishSearchResponse {
	results?: TinyFishSearchResult[];
}

interface TinyFishFetchResult {
	url?: string;
	final_url?: string;
	title?: string | null;
	text?: string | Record<string, unknown> | null;
}

interface TinyFishFetchError {
	url?: string;
	error?: string;
	status?: number;
}

interface TinyFishFetchResponse {
	results?: TinyFishFetchResult[];
	errors?: TinyFishFetchError[];
}

/**
 * Resolve the API key: `web.tinyfishApiKey` in geocine.json (a literal key
 * or a "$VAR_NAME" environment reference) → TINYFISH_API_KEY env var.
 */
export function tinyFishApiKey(): string | undefined {
	const configured = loadConfig().web?.tinyfishApiKey;
	if (typeof configured === "string" && configured.trim()) {
		const envRef = /^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/.exec(configured.trim());
		const value = envRef ? process.env[envRef[1]] : configured.trim();
		if (value?.trim()) return value.trim();
	}
	const env = process.env.TINYFISH_API_KEY;
	return env?.trim() ? env.trim() : undefined;
}

function requireApiKey(): string {
	const key = tinyFishApiKey();
	if (!key) {
		throw new Error(
			`TinyFish API key not found. Set "web": { "tinyfishApiKey": "..." } (or "$MY_VAR") in geocine.json, or the TINYFISH_API_KEY environment variable. Keys: ${KEY_URL}`,
		);
	}
	return key;
}

function redact(message: string, apiKey: string): string {
	return apiKey ? message.split(apiKey).join("[REDACTED]") : message;
}

/** Re-throw with the API key scrubbed from the message. */
function rethrowRedacted(err: unknown, apiKey: string): never {
	const message = err instanceof Error ? err.message : String(err);
	const clean = redact(message, apiKey);
	if (err instanceof Error && clean === message) throw err;
	const redacted = new Error(clean);
	if (err instanceof Error) redacted.name = err.name;
	throw redacted;
}

function combineSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
	const timeout = AbortSignal.timeout(timeoutMs);
	return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

async function tinyFishRequest<T>(
	label: "Search" | "Fetch",
	url: string,
	apiKey: string,
	init: RequestInit,
	timeoutMs: number,
	signal?: AbortSignal,
): Promise<T> {
	const response = await fetch(url, {
		...init,
		headers: {
			"X-API-Key": apiKey,
			...(init.body ? { "Content-Type": "application/json" } : {}),
		},
		signal: combineSignal(signal, timeoutMs),
	});
	const raw = await response.text();
	if (!response.ok) {
		throw new Error(`TinyFish ${label} API error ${response.status}: ${redact(raw, apiKey).slice(0, 300)}`);
	}
	try {
		return JSON.parse(raw) as T;
	} catch {
		throw new Error(`TinyFish ${label} API returned invalid JSON`);
	}
}

function normalizeDomain(value: string): string | null {
	let input = value.trim().toLowerCase();
	if (input.startsWith("-")) input = input.slice(1).trim();
	if (!input) return null;
	try {
		const parsed = input.includes("://") ? new URL(input) : new URL(`https://${input}`);
		input = parsed.hostname;
	} catch {
		input = input.split("/")[0]?.split(":")[0] ?? "";
	}
	input = input.replace(/^\.+|\.+$/g, "");
	return /^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/i.test(input) ? input : null;
}

/** Map the tool's allowed_domains to TinyFish include/exclude ("-domain" excludes). */
export function mapDomains(domains: string[] | undefined): { include: string[]; exclude: string[] } {
	const include: string[] = [];
	const exclude: string[] = [];
	for (const raw of domains ?? []) {
		const domain = normalizeDomain(raw);
		if (!domain) continue;
		const target = raw.trim().startsWith("-") ? exclude : include;
		if (!target.includes(domain)) target.push(domain);
	}
	return { include, exclude };
}

function buildSearchUrl(query: string, options: WebSearchOptions, page: number): string {
	const params = new URLSearchParams({ query });
	const { include, exclude } = mapDomains(options.domains);
	if (include.length > 0) params.set("include_domains", include.join(","));
	if (exclude.length > 0) params.set("exclude_domains", exclude.join(","));
	if (page > 0) params.set("page", String(page));
	return `${SEARCH_URL}?${params.toString()}`;
}

export const tinyFishProvider: WebProvider = {
	id: "tinyfish",
	requires: `TINYFISH_API_KEY env var or web.tinyfishApiKey in geocine.json (${KEY_URL})`,
	available: () => tinyFishApiKey() !== undefined,

	async search(query: string, options: WebSearchOptions): Promise<WebSearchResult[]> {
		const apiKey = requireApiKey();
		try {
			const limit = Math.max(1, Math.min(options.limit, 20));
			const seen = new Set<string>();
			const results: WebSearchResult[] = [];
			const pages = limit > 10 ? 2 : 1;
			for (let page = 0; page < pages && results.length < limit; page++) {
				const data = await tinyFishRequest<TinyFishSearchResponse>(
					"Search",
					buildSearchUrl(query, options, page),
					apiKey,
					{ method: "GET" },
					SEARCH_TIMEOUT_MS,
					options.signal,
				);
				if (!Array.isArray(data.results)) throw new Error("TinyFish Search API returned an unexpected response shape");
				for (const item of data.results) {
					const url = typeof item?.url === "string" ? item.url.trim() : "";
					if (!url || seen.has(url)) continue;
					seen.add(url);
					results.push({
						title: typeof item.title === "string" && item.title.trim() ? item.title.trim() : url,
						url,
						snippet: typeof item.snippet === "string" ? item.snippet.replace(/\s+/g, " ").trim() : "",
					});
					if (results.length >= limit) break;
				}
				if (data.results.length < 10) break;
			}
			return results;
		} catch (err) {
			rethrowRedacted(err, apiKey);
		}
	},

	async fetch(url: string, options: WebFetchOptions): Promise<WebFetchResult> {
		const apiKey = requireApiKey();
		try {
			const body: Record<string, unknown> = {
				urls: [url],
				format: "markdown",
				per_url_timeout_ms: PER_URL_TIMEOUT_MS,
			};
			const purpose = options.prompt?.trim();
			if (purpose) body.purpose = purpose.slice(0, 2000);
			const data = await tinyFishRequest<TinyFishFetchResponse>(
				"Fetch",
				FETCH_URL,
				apiKey,
				{ method: "POST", body: JSON.stringify(body) },
				FETCH_TIMEOUT_MS,
				options.signal,
			);
			if (!Array.isArray(data.results) || !Array.isArray(data.errors)) {
				throw new Error("TinyFish Fetch API returned an unexpected response shape");
			}
			const result = data.results.find((item) => item?.url === url || item?.final_url === url) ?? data.results[0];
			const content =
				typeof result?.text === "string"
					? result.text.trim()
					: result?.text && typeof result.text === "object"
						? JSON.stringify(result.text, null, 2)
						: "";
			if (content) {
				return {
					title: typeof result?.title === "string" ? result.title.trim() : undefined,
					content,
					contentType: "text/markdown",
				};
			}
			const fetchError = data.errors.find((item) => item?.url === url) ?? data.errors[0];
			const status = typeof fetchError?.status === "number" ? ` (HTTP ${fetchError.status})` : "";
			throw new Error(`TinyFish Fetch failed for ${url}: ${fetchError?.error || "no content returned"}${status}`);
		} catch (err) {
			rethrowRedacted(err, apiKey);
		}
	},
};
