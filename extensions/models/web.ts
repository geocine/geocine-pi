// web_fetch / web_search: canonical web tools. qwen-code, grok-build, and
// dsh all train their models on these (qwen web_fetch takes url+prompt, grok
// and dsh take url only; qwen/grok take a query for web_search, grok adds
// allowed_domains, dsh takes a queries array). Codex models get web access
// as a hosted provider tool, so these are hidden from OpenAI models via
// ownedTools.
//
// The tool schemas here are the trained dialects and never change. What
// serves them is a pluggable provider (lib/web-providers/): "tinyfish"
// (TinyFish search + server-rendered Markdown fetch, needs an API key) or
// "builtin" (DuckDuckGo HTML scrape + plain fetch, zero config). `web.provider`
// in geocine.json pins one; the default "auto" prefers the first provider
// whose key is present and falls back to builtin — including at runtime,
// when a keyed provider errors mid-call, so the model always gets an answer.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { loadConfig } from "../../lib/config.ts";
import { fallbackProviderFor, resolveWebProvider, type WebProvider, type WebSearchResult } from "../../lib/web-providers/index.ts";

const MAX_CONTENT_CHARS = 50000;
const MAX_RESULTS = 8;

async function withFallback<T>(
	run: (provider: WebProvider) => Promise<T>,
): Promise<{ value: T; provider: WebProvider; fallbackNote?: string }> {
	const cfg = loadConfig().web;
	const provider = resolveWebProvider(cfg);
	try {
		return { value: await run(provider), provider };
	} catch (err) {
		const fallback = fallbackProviderFor(provider, cfg);
		if (!fallback) throw err;
		const message = err instanceof Error ? err.message : String(err);
		if (/abort/i.test(message)) throw err; // user cancelled — don't retry
		return {
			value: await run(fallback),
			provider: fallback,
			fallbackNote: `[${provider.id} failed (${message}); answered by ${fallback.id}]`,
		};
	}
}

export function registerWebTools(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "web_fetch",
		label: "web_fetch",
		description:
			"Fetch a URL and return its content as readable text (HTML is stripped or rendered to Markdown). Use for documentation pages, articles, raw files, and APIs returning text or JSON.",
		parameters: Type.Object({
			url: Type.String({ description: "The absolute URL to fetch" }),
			prompt: Type.Optional(
				Type.String({ description: "What you are looking for in the page (guides extraction where supported; echoed back as a focus reminder)" }),
			),
		}),
		async execute(_toolCallId, params, signal) {
			const { value, provider, fallbackNote } = await withFallback((p) =>
				p.fetch(params.url, { prompt: params.prompt, signal }),
			);
			let text = value.content;
			let truncated = false;
			if (text.length > MAX_CONTENT_CHARS) {
				text = text.slice(0, MAX_CONTENT_CHARS);
				truncated = true;
			}
			const parts = [`Content of ${params.url}${value.title ? ` (${value.title})` : ""}:`, "", text];
			if (truncated) parts.push("", `[truncated at ${MAX_CONTENT_CHARS} chars]`);
			if (params.prompt) parts.push("", `Focus: ${params.prompt}`);
			if (fallbackNote) parts.unshift(fallbackNote, "");
			return {
				content: [{ type: "text", text: parts.join("\n") }],
				details: { url: params.url, provider: provider.id, contentType: value.contentType, truncated },
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
		async execute(_toolCallId, params, signal) {
			const domains = (params.allowed_domains ?? []).filter((d) => d.trim() !== "");
			const { value: results, provider, fallbackNote } = await withFallback((p) =>
				p.search(params.query, { domains, limit: MAX_RESULTS, signal }),
			);
			if (results.length === 0) {
				const empty = `No results for: ${params.query}`;
				return {
					content: [{ type: "text", text: fallbackNote ? `${fallbackNote}\n\n${empty}` : empty }],
					details: { query: params.query, provider: provider.id, results },
				};
			}
			const text = results
				.map((r: WebSearchResult, i: number) => `${i + 1}. ${r.title}\n   ${r.url}${r.snippet ? `\n   ${r.snippet}` : ""}`)
				.join("\n");
			const headline = `Search results for "${params.query}":`;
			const parts = fallbackNote ? [fallbackNote, "", headline, text] : [headline, text];
			return {
				content: [{ type: "text", text: parts.join("\n") }],
				details: { query: params.query, provider: provider.id, results },
			};
		},
	});
}
