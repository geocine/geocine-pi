// pdf-reader: native PDF inspection for the harness.
//
// Why this exists: pi's read tool and the shells see a PDF as binary noise,
// so when a task involves one the local model either dumps compressed
// streams into context or improvises a python/pdftotext script that isn't
// installed. read_pdf gives it a real outlet: classification (text-based vs
// scanned, ~10-50ms), per-page Markdown extraction (tables, headings,
// multi-column reading order), page-range selection, and cross-page search —
// all via @firecrawl/pdf-inspector (Rust/napi, prebuilt binaries, parse runs
// on the libuv pool so the event loop stays free).
//
// Context discipline: output is hard-capped (pdf.maxChars, default 24000
// chars). The tool fills WHOLE pages until the budget runs out, then names
// the omitted pages so the model can fetch exactly what it needs next call.
// For large documents the intended flow is search first ("which pages
// mention X"), then read those pages. No OCR: scanned/image pages are
// flagged with their machine-readable reason instead of silently returning
// nothing (the OCR runtime needs external PDFium/ONNX libraries; wire it up
// separately if ever needed).

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { loadConfig } from "../lib/config.ts";

const DEFAULT_MAX_CHARS = 24000;
const DEFAULT_MAX_SEARCH_MATCHES = 40;
/** Cap a single matched line in search output. */
const SEARCH_LINE_CHARS = 240;

type PdfInspector = typeof import("@firecrawl/pdf-inspector");
let inspectorPromise: Promise<PdfInspector> | undefined;

async function loadInspector(): Promise<PdfInspector> {
	inspectorPromise ??= import("@firecrawl/pdf-inspector");
	try {
		return await inspectorPromise;
	} catch (error) {
		inspectorPromise = undefined; // allow retry after the user fixes the install
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(
			`@firecrawl/pdf-inspector failed to load: ${message}. Run "npm install" in the geocine-pi package directory (prebuilt binaries exist for win32-x64, darwin-arm64, linux x64/arm64).`,
		);
	}
}

/**
 * Parse a 1-indexed page selection like "3", "1-5,8", "40-" into a sorted,
 * deduplicated, clamped list of 1-indexed page numbers.
 */
export function parsePageRanges(spec: string, pageCount: number): number[] | { error: string } {
	const pages = new Set<number>();
	for (const part of spec
		.split(",")
		.map((s) => s.trim())
		.filter((s) => s.length > 0)) {
		const match = /^(\d+)(?:\s*-\s*(\d+)?)?$/.exec(part);
		if (!match) {
			return { error: `Bad page selection "${part}". Use 1-indexed forms like "3", "1-5", "40-", comma-separated.` };
		}
		const start = Number(match[1]);
		const end = part.includes("-") ? (match[2] !== undefined ? Number(match[2]) : pageCount) : start;
		if (start < 1 || end < start) {
			return { error: `Bad page range "${part}": start must be >= 1 and not after end.` };
		}
		for (let p = start; p <= Math.min(end, pageCount); p++) pages.add(p);
	}
	const sorted = [...pages].sort((a, b) => a - b);
	if (sorted.length === 0) {
		return { error: `Page selection "${spec}" matches nothing: the document has ${pageCount} page(s).` };
	}
	return sorted;
}

/** Render a sorted list of 1-indexed pages as compact ranges: "1-3, 7, 9-12". */
export function formatPageList(pages: number[]): string {
	const parts: string[] = [];
	for (let i = 0; i < pages.length; ) {
		let j = i;
		while (j + 1 < pages.length && pages[j + 1] === pages[j] + 1) j++;
		parts.push(i === j ? `${pages[i]}` : `${pages[i]}-${pages[j]}`);
		i = j + 1;
	}
	return parts.join(", ");
}

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

interface PageChunk {
	/** 1-indexed page number. */
	page: number;
	text: string;
}

/**
 * Fill whole pages into the budget, in order. Returns the included chunks
 * (the first page is hard-truncated when it alone exceeds the budget) and
 * the 1-indexed pages that did not fit.
 */
export function fillBudget(chunks: PageChunk[], maxChars: number): { included: string[]; omitted: number[] } {
	const included: string[] = [];
	const omitted: number[] = [];
	let used = 0;
	for (const chunk of chunks) {
		if (included.length > 0 && used + chunk.text.length > maxChars) {
			omitted.push(chunk.page);
			continue;
		}
		if (chunk.text.length > maxChars) {
			included.push(`${chunk.text.slice(0, maxChars)}\n[page ${chunk.page} truncated at ${maxChars} chars — raise pdf.maxChars in geocine.json to see more of it]`);
			used = maxChars;
			continue;
		}
		included.push(chunk.text);
		used += chunk.text.length;
	}
	return { included, omitted };
}

function escapeRegex(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export default function pdfReader(pi: ExtensionAPI) {
	pi.registerTool({
		name: "read_pdf",
		label: "Read PDF",
		description:
			'Inspect a PDF file: classifies it (text-based vs scanned), then extracts its content as Markdown page by page (headings, tables, lists, reading order). `pages` selects 1-indexed pages/ranges, e.g. "1-5,12" or "40-". `search` finds which pages match a pattern (case-insensitive regex) and returns matching lines instead of full content — use it first on long documents, then read only the matching pages. Output is capped; the footer names any omitted pages. Scanned/image pages have no text layer and are flagged instead of extracted (no OCR).',
		promptSnippet: "Read or search a PDF: classification + per-page Markdown extraction with page ranges",
		promptGuidelines: [
			"PDF files are binary: inspect them with read_pdf, never with the read tool, shell commands, or improvised scripts.",
			'On a PDF longer than a few pages, call read_pdf with `search` or a small `pages` range first instead of pulling the whole document into context.',
		],
		executionMode: "parallel",
		parameters: Type.Object({
			path: Type.String({ description: "Path to the PDF file (absolute or relative to the working directory)." }),
			pages: Type.Optional(
				Type.String({
					description: 'Which 1-indexed pages to extract, e.g. "3", "1-5,12", "40-". Omit to read from page 1 until the output budget is spent.',
				}),
			),
			search: Type.Optional(
				Type.String({
					description: "Case-insensitive regex (invalid patterns fall back to literal text). Returns matching lines with their page numbers instead of page content.",
				}),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const filePath = path.resolve(ctx.cwd, params.path);
			let buffer: Buffer;
			try {
				buffer = fs.readFileSync(filePath);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				throw new Error(`Cannot read "${filePath}": ${message}`);
			}
			// The %PDF header may sit after a small preamble (spec allows ~1KB).
			if (!buffer.subarray(0, 1024).includes("%PDF")) {
				throw new Error(`"${filePath}" is not a PDF (no %PDF header). For text files use the read tool.`);
			}

			const inspector = await loadInspector();
			const cfg = loadConfig(ctx.cwd).pdf ?? {};
			const maxChars = cfg.maxChars ?? DEFAULT_MAX_CHARS;
			const maxMatches = cfg.maxSearchMatches ?? DEFAULT_MAX_SEARCH_MATCHES;

			const cls = await inspector.classifyPdfAsync(buffer);
			const pageCount = cls.pageCount;

			// Resolve the page selection (1-indexed for humans, 0-indexed for the lib).
			let selected: number[] | undefined;
			if (params.pages?.trim()) {
				const parsed = parsePageRanges(params.pages, pageCount);
				if ("error" in parsed) throw new Error(parsed.error);
				selected = parsed;
			}

			// One parse extracts markdown + layout metadata for the needed pages.
			// A search without an explicit selection scans the whole document.
			const extractPages = params.search && !selected ? undefined : selected?.map((p) => p - 1);
			const extraction = await inspector.extractPagesMarkdownAsync(buffer, extractPages);

			const header: string[] = [
				`${path.basename(filePath)} — ${cls.pdfType} (confidence ${cls.confidence.toFixed(2)}) — ${pageCount} page(s) — ${formatBytes(buffer.length)}`,
			];
			if (extraction.pagesWithTables.length > 0) header.push(`Tables on pages: ${formatPageList(extraction.pagesWithTables)}`);
			if (extraction.pagesWithColumns.length > 0) header.push(`Multi-column pages: ${formatPageList(extraction.pagesWithColumns)}`);
			if (extraction.pagesNeedingOcr.length > 0) {
				header.push(
					`Pages with no reliable text layer (scanned/image — OCR is not wired into this harness): ${formatPageList(extraction.pagesNeedingOcr)}`,
				);
			}

			// ---- search mode ----
			if (params.search) {
				let re: RegExp;
				try {
					re = new RegExp(params.search, "i");
				} catch {
					re = new RegExp(escapeRegex(params.search), "i");
				}
				const matches: { page: number; line: string }[] = [];
				let total = 0;
				for (const page of extraction.pages) {
					for (const rawLine of page.markdown.split("\n")) {
						const line = rawLine.trim();
						if (!line || !re.test(line)) continue;
						total++;
						if (matches.length < maxMatches) {
							matches.push({ page: page.page + 1, line: line.length > SEARCH_LINE_CHARS ? `${line.slice(0, SEARCH_LINE_CHARS)}…` : line });
						}
					}
				}
				const matchPages = [...new Set(matches.map((m) => m.page))];
				const scope = selected ? ` (searched pages ${formatPageList(selected)})` : "";
				const lines: string[] = [...header, ""];
				if (total === 0) {
					lines.push(`No matches for /${params.search}/i${scope}.`);
					if (extraction.pagesNeedingOcr.length > 0) {
						lines.push("Note: pages without a text layer cannot be searched.");
					}
				} else {
					lines.push(`${total} match(es) for /${params.search}/i on pages ${formatPageList(matchPages)}${scope}:`);
					for (const m of matches) lines.push(`  p${m.page}: ${m.line}`);
					if (total > matches.length) lines.push(`  [${total - matches.length} more match(es) not shown — narrow the pattern or pass pages]`);
					lines.push("", `Read a matching page with pages="<n>".`);
				}
				return {
					content: [{ type: "text", text: lines.join("\n") }],
					details: { path: filePath, pdfType: String(cls.pdfType), pageCount, search: params.search, totalMatches: total, matchPages },
				};
			}

			// ---- extraction mode ----
			const chunks: PageChunk[] = extraction.pages.map((page) => {
				const pageNo = page.page + 1;
				const markdown = page.markdown.trim();
				let body: string;
				if (page.needsOcr) {
					const reason = page.ocrReason ? ` (${page.ocrReason})` : "";
					body = markdown
						? `[unreliable text layer${reason} — treat with suspicion]\n${markdown}`
						: `[no extractable text${reason} — scanned or image-only page]`;
				} else {
					body = markdown || "[empty page]";
				}
				return { page: pageNo, text: `--- Page ${pageNo} ---\n${body}` };
			});

			const { included, omitted } = fillBudget(chunks, maxChars);
			const shownPages = chunks.filter((c) => !omitted.includes(c.page)).map((c) => c.page);
			const parts = [...header, "", ...included];
			if (omitted.length > 0) {
				parts.push(
					"",
					`[Output budget of ${maxChars} chars (pdf.maxChars) reached: showed pages ${formatPageList(shownPages)}, omitted ${formatPageList(omitted)}. Call read_pdf again with pages="${formatPageList(omitted).replace(/, /g, ",")}" — or a search — for the rest.]`,
				);
			}
			return {
				content: [{ type: "text", text: parts.join("\n") }],
				details: { path: filePath, pdfType: String(cls.pdfType), pageCount, shownPages, omittedPages: omitted },
			};
		},
	});
}
