// Web provider contract for the canonical web_fetch / web_search tools.
//
// The tools (extensions/models/web.ts) own the model-facing schemas — those
// are trained dialects and must not change per provider. Providers only
// implement the two operations behind them. To add a provider: create a
// sibling file exporting a WebProvider and append it to PROVIDERS in
// index.ts; selection (config pin or first-available) needs no other change.

export interface WebSearchResult {
	title: string;
	url: string;
	snippet: string;
}

export interface WebSearchOptions {
	/** Restrict results to these domains (tool's allowed_domains). */
	domains?: string[];
	/** Max results to return. */
	limit: number;
	signal?: AbortSignal;
}

export interface WebFetchOptions {
	/** What the model is looking for (providers may pass it as extraction purpose). */
	prompt?: string;
	signal?: AbortSignal;
}

export interface WebFetchResult {
	/** Page title when the provider knows it. */
	title?: string;
	/** Readable text/markdown content (untruncated — the tool applies the cap). */
	content: string;
	contentType?: string;
}

export interface WebProvider {
	/** Registry id, also the `web.provider` config value. */
	id: string;
	/** One line for docs/errors: what it is and what it needs. */
	requires: string;
	/** Whether the provider can run right now (e.g. its API key is present). */
	available(): boolean;
	search(query: string, options: WebSearchOptions): Promise<WebSearchResult[]>;
	fetch(url: string, options: WebFetchOptions): Promise<WebFetchResult>;
}
