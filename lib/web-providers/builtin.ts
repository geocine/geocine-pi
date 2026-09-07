// builtin: the zero-config web provider (moved here from models/web.ts).
//
// web fetch: plain fetch + dependency-free HTML-to-text stripping.
// web search: DuckDuckGo HTML endpoint (no API key); allowed domains map to
// site: operators. Always available, so it is the registry's last resort.

import type { WebFetchOptions, WebFetchResult, WebProvider, WebSearchOptions, WebSearchResult } from "./types.ts";

const FETCH_TIMEOUT_MS = 20000;

// DDG's html endpoint answers 202 (bot challenge) to non-browser UAs.
const USER_AGENT =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";

function decodeEntities(s: string): string {
	return s
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#x?\d+;/g, " ")
		.replace(/&nbsp;/g, " ")
		.replace(/&amp;/g, "&");
}

/** Crude but dependency-free HTML to readable text. */
export function htmlToText(html: string): string {
	const withoutBlocks = html
		.replace(/<script[\s\S]*?<\/script>/gi, "")
		.replace(/<style[\s\S]*?<\/style>/gi, "")
		.replace(/<noscript[\s\S]*?<\/noscript>/gi, "")
		.replace(/<!--[\s\S]*?-->/g, "");
	const withBreaks = withoutBlocks
		.replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr)[^>]*>/gi, "\n")
		.replace(/<li[^>]*>/gi, "- ");
	return decodeEntities(withBreaks.replace(/<[^>]+>/g, ""))
		.replace(/[ \t]+/g, " ")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

async function fetchText(url: string, signal?: AbortSignal): Promise<{ contentType: string; body: string }> {
	const timeout = AbortSignal.timeout(FETCH_TIMEOUT_MS);
	const response = await fetch(url, {
		signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
		headers: { "user-agent": USER_AGENT },
		redirect: "follow",
	});
	if (!response.ok) throw new Error(`Fetch failed: HTTP ${response.status} for ${url}`);
	const contentType = response.headers.get("content-type") ?? "";
	return { contentType, body: await response.text() };
}

export function parseDuckDuckGo(html: string, limit: number): WebSearchResult[] {
	const results: WebSearchResult[] = [];
	const linkPattern = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
	const snippetPattern = /<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
	const links = [...html.matchAll(linkPattern)];
	const snippets = [...html.matchAll(snippetPattern)];
	for (let i = 0; i < links.length && results.length < limit; i++) {
		let url = decodeEntities(links[i][1]);
		// DDG wraps results in a redirect (//duckduckgo.com/l/?uddg=<encoded>).
		const uddg = /[?&]uddg=([^&]+)/.exec(url);
		if (uddg) url = decodeURIComponent(uddg[1]);
		// Sponsored results decode to DDG/Bing ad click-trackers; skip them.
		if (/duckduckgo\.com\/y\.js|bing\.com\/aclick|ad_provider=/.test(url)) continue;
		const title = htmlToText(links[i][2]);
		if (!title || !/^https?:/.test(url)) continue;
		results.push({ title, url, snippet: htmlToText(snippets[i]?.[1] ?? "") });
	}
	return results;
}

export const builtinProvider: WebProvider = {
	id: "builtin",
	requires: "nothing (DuckDuckGo HTML scrape + plain fetch, no API key)",
	available: () => true,

	async search(query: string, options: WebSearchOptions): Promise<WebSearchResult[]> {
		let q = query;
		const domains = (options.domains ?? []).filter((d) => d.trim() !== "");
		if (domains.length === 1) q += ` site:${domains[0]}`;
		else if (domains.length > 1) q += ` (${domains.map((d) => `site:${d}`).join(" OR ")})`;
		const { body } = await fetchText(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`, options.signal);
		return parseDuckDuckGo(body, options.limit);
	},

	async fetch(url: string, options: WebFetchOptions): Promise<WebFetchResult> {
		const { contentType, body } = await fetchText(url, options.signal);
		const isHtml = contentType.includes("html") || /^\s*<(!doctype|html)/i.test(body);
		return { content: isHtml ? htmlToText(body) : body, contentType };
	},
};
