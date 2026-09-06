// web_fetch / web_search: canonical web tools. Both qwen-code and grok-build
// train their models on these (qwen web_fetch takes url+prompt, grok's takes
// url only; both take a query for web_search, grok adds allowed_domains).
// Codex models get web access as a hosted provider tool, so these are hidden
// from OpenAI models via ownedTools.
//
// web_fetch: fetch the URL, strip HTML to readable text, cap the size. The
// qwen-code original runs the prompt over the content model-side; here the
// content is returned directly and the model applies its own prompt, which
// keeps the tool deterministic and provider-free.
//
// web_search: DuckDuckGo HTML endpoint (no API key). allowed_domains maps to
// site: operators like the grok-build original.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const FETCH_TIMEOUT_MS = 20000;
const MAX_CONTENT_CHARS = 50000;
const MAX_RESULTS = 8;

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

async function fetchText(url: string): Promise<{ contentType: string; body: string }> {
	const response = await fetch(url, {
		signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
		headers: { "user-agent": USER_AGENT },
		redirect: "follow",
	});
	if (!response.ok) throw new Error(`Fetch failed: HTTP ${response.status} for ${url}`);
	const contentType = response.headers.get("content-type") ?? "";
	return { contentType, body: await response.text() };
}

interface SearchResult {
	title: string;
	url: string;
	snippet: string;
}

export function parseDuckDuckGo(html: string): SearchResult[] {
	const results: SearchResult[] = [];
	const linkPattern = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
	const snippetPattern = /<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
	const links = [...html.matchAll(linkPattern)];
	const snippets = [...html.matchAll(snippetPattern)];
	for (let i = 0; i < links.length && results.length < MAX_RESULTS; i++) {
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

export function registerWebTools(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "web_fetch",
		label: "web_fetch",
		description:
			"Fetch a URL and return its content as readable text (HTML is stripped). Use for documentation pages, articles, raw files, and APIs returning text or JSON.",
		parameters: Type.Object({
			url: Type.String({ description: "The absolute URL to fetch" }),
			prompt: Type.Optional(
				Type.String({ description: "What you are looking for in the page (echoed back as a focus reminder)" }),
			),
		}),
		async execute(_toolCallId, params) {
			const { contentType, body } = await fetchText(params.url);
			const isHtml = contentType.includes("html") || /^\s*<(!doctype|html)/i.test(body);
			let text = isHtml ? htmlToText(body) : body;
			let truncated = false;
			if (text.length > MAX_CONTENT_CHARS) {
				text = text.slice(0, MAX_CONTENT_CHARS);
				truncated = true;
			}
			const parts = [`Content of ${params.url}:`, "", text];
			if (truncated) parts.push("", `[truncated at ${MAX_CONTENT_CHARS} chars]`);
			if (params.prompt) parts.push("", `Focus: ${params.prompt}`);
			return {
				content: [{ type: "text", text: parts.join("\n") }],
				details: { url: params.url, contentType, truncated },
			};
		},
	});

	pi.registerTool({
		name: "web_search",
		label: "web_search",
		description:
			"Search the web and return result titles, URLs, and snippets. Follow up with web_fetch on promising results.",
		parameters: Type.Object({
			query: Type.String({ description: "The search query" }),
			allowed_domains: Type.Optional(
				Type.Array(Type.String(), { description: "Restrict results to these domains" }),
			),
		}),
		async execute(_toolCallId, params) {
			let query = params.query;
			const domains = (params.allowed_domains ?? []).filter((d) => d.trim() !== "");
			if (domains.length === 1) query += ` site:${domains[0]}`;
			else if (domains.length > 1) query += ` (${domains.map((d) => `site:${d}`).join(" OR ")})`;
			const { body } = await fetchText(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`);
			const results = parseDuckDuckGo(body);
			if (results.length === 0) {
				return {
					content: [{ type: "text", text: `No results for: ${query}` }],
					details: { query, results },
				};
			}
			const text = results
				.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}${r.snippet ? `\n   ${r.snippet}` : ""}`)
				.join("\n");
			return {
				content: [{ type: "text", text: `Search results for "${query}":\n${text}` }],
				details: { query, results },
			};
		},
	});
}
