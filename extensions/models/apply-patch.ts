// apply_patch: codex's native file-editing tool, implemented for pi.
//
// OpenAI models are RL-trained to edit files through a freeform patch
// envelope (*** Begin Patch / Add File / Update File / Delete File), not
// through old_string/new_string edits. One patch call can touch several
// files, so it cannot be aliased onto pi's edit tool (one call id must map
// to one result). Instead this registers a real tool; the dispatcher only
// advertises it while the OpenAI harness is active (ownedTools).
//
// Grammar: codex-rs/core/assets/tools/apply_patch.lark. Context matching
// mirrors codex-rs/apply-patch/src/seek_sequence.rs: exact, then trailing-
// whitespace-insensitive, then fully trimmed, then unicode-punctuation
// normalized; "*** End of File" anchors the chunk at EOF.

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

type ChunkOp = { kind: "keep" | "del" | "add"; text: string };
type Chunk = { marker?: string; ops: ChunkOp[]; eof: boolean };

type Hunk =
	| { type: "add"; file: string; lines: string[] }
	| { type: "delete"; file: string }
	| { type: "update"; file: string; moveTo?: string; chunks: Chunk[] };

const BEGIN = "*** Begin Patch";
const END = "*** End Patch";

export function parsePatch(input: string): Hunk[] {
	const lines = input.replace(/\r\n/g, "\n").split("\n");
	let i = 0;
	while (i < lines.length && lines[i].trim() === "") i++;
	if (lines[i]?.trim() !== BEGIN) throw new Error(`Patch must start with "${BEGIN}"`);
	i++;

	const hunks: Hunk[] = [];
	while (i < lines.length && lines[i].trim() !== END) {
		const line = lines[i];
		const add = /^\*\*\* Add File: (.+)$/.exec(line);
		const del = /^\*\*\* Delete File: (.+)$/.exec(line);
		const upd = /^\*\*\* Update File: (.+)$/.exec(line);
		if (add) {
			i++;
			const content: string[] = [];
			while (i < lines.length && lines[i].startsWith("+")) {
				content.push(lines[i].slice(1));
				i++;
			}
			hunks.push({ type: "add", file: add[1].trim(), lines: content });
			continue;
		}
		if (del) {
			hunks.push({ type: "delete", file: del[1].trim() });
			i++;
			continue;
		}
		if (upd) {
			i++;
			let moveTo: string | undefined;
			const move = i < lines.length ? /^\*\*\* Move to: (.+)$/.exec(lines[i]) : null;
			if (move) {
				moveTo = move[1].trim();
				i++;
			}
			const chunks: Chunk[] = [];
			let current: Chunk = { ops: [], eof: false };
			const flush = () => {
				if (current.ops.length > 0 || current.marker !== undefined) chunks.push(current);
				current = { ops: [], eof: false };
			};
			while (i < lines.length) {
				const l = lines[i];
				if (l.startsWith("*** End of File")) {
					current.eof = true;
					i++;
					flush();
					continue;
				}
				if (l.startsWith("*** ")) break; // next hunk or End Patch
				if (l === "@@" || l.startsWith("@@ ")) {
					flush();
					const marker = l === "@@" ? undefined : l.slice(3);
					current.marker = marker;
					i++;
					continue;
				}
				if (l.startsWith("+")) current.ops.push({ kind: "add", text: l.slice(1) });
				else if (l.startsWith("-")) current.ops.push({ kind: "del", text: l.slice(1) });
				else current.ops.push({ kind: "keep", text: l.startsWith(" ") ? l.slice(1) : l });
				i++;
			}
			flush();
			hunks.push({ type: "update", file: upd[1].trim(), moveTo, chunks });
			continue;
		}
		if (line.trim() === "") {
			i++;
			continue;
		}
		throw new Error(`Unexpected line in patch: ${line}`);
	}
	if (lines[i]?.trim() !== END) throw new Error(`Patch must end with "${END}"`);
	if (hunks.length === 0) throw new Error("Patch contains no file operations");
	return hunks;
}

// Unicode punctuation to ASCII, mirroring codex's most permissive pass.
function normalize(s: string): string {
	return s
		.trim()
		.replace(/[\u2010-\u2015\u2212]/g, "-")
		.replace(/[\u2018-\u201B]/g, "'")
		.replace(/[\u201C-\u201F]/g, '"')
		.replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, " ");
}

function seekSequence(lines: string[], pattern: string[], start: number, eof: boolean): number {
	if (pattern.length === 0) return start;
	if (pattern.length > lines.length) return -1;
	const searchStart = eof ? lines.length - pattern.length : start;
	const passes: Array<(a: string, b: string) => boolean> = [
		(a, b) => a === b,
		(a, b) => a.trimEnd() === b.trimEnd(),
		(a, b) => a.trim() === b.trim(),
		(a, b) => normalize(a) === normalize(b),
	];
	for (const eq of passes) {
		for (let i = searchStart; i <= lines.length - pattern.length; i++) {
			if (i < 0) continue;
			let ok = true;
			for (let p = 0; p < pattern.length; p++) {
				if (!eq(lines[i + p], pattern[p])) {
					ok = false;
					break;
				}
			}
			if (ok) return i;
		}
	}
	return -1;
}

export function applyUpdate(oldText: string, chunks: Chunk[], file: string): string {
	// A trailing newline makes split() produce a phantom empty last line;
	// strip it for matching/insertion and restore it on output.
	const trailingNewline = oldText.endsWith("\n");
	const lines = oldText.split("\n");
	if (trailingNewline) lines.pop();
	let index = 0;
	for (const chunk of chunks) {
		if (chunk.marker !== undefined) {
			const at = seekSequence(lines, [chunk.marker], index, false);
			if (at === -1) throw new Error(`Failed to find context "@@ ${chunk.marker}" in ${file}`);
			index = at + 1;
		}
		if (chunk.ops.length === 0) continue;
		const pattern = chunk.ops.filter((op) => op.kind !== "add").map((op) => op.text);
		const replacement = chunk.ops.filter((op) => op.kind !== "del").map((op) => op.text);
		if (pattern.length === 0) {
			// Pure insertion: at EOF or at the current cursor.
			const at = chunk.eof ? lines.length : index;
			lines.splice(at, 0, ...replacement);
			index = at + replacement.length;
			continue;
		}
		const found = seekSequence(lines, pattern, index, chunk.eof);
		if (found === -1) {
			throw new Error(`Failed to find expected lines in ${file}:\n${pattern.join("\n")}`);
		}
		lines.splice(found, pattern.length, ...replacement);
		index = found + replacement.length;
	}
	return lines.join("\n") + (trailingNewline ? "\n" : "");
}

interface FileChange {
	action: "A" | "M" | "D";
	path: string;
}

export function applyPatch(input: string, cwd: string): FileChange[] {
	const hunks = parsePatch(input);
	const changes: FileChange[] = [];
	for (const hunk of hunks) {
		const abs = path.resolve(cwd, hunk.file);
		if (hunk.type === "add") {
			if (fs.existsSync(abs)) throw new Error(`Add File failed: ${hunk.file} already exists`);
			fs.mkdirSync(path.dirname(abs), { recursive: true });
			fs.writeFileSync(abs, hunk.lines.join("\n") + "\n", "utf8");
			changes.push({ action: "A", path: hunk.file });
			continue;
		}
		if (hunk.type === "delete") {
			if (!fs.existsSync(abs)) throw new Error(`Delete File failed: ${hunk.file} does not exist`);
			fs.rmSync(abs);
			changes.push({ action: "D", path: hunk.file });
			continue;
		}
		if (!fs.existsSync(abs)) throw new Error(`Update File failed: ${hunk.file} does not exist`);
		const original = fs.readFileSync(abs, "utf8");
		const hadCrlf = original.includes("\r\n");
		const updated = applyUpdate(original.replace(/\r\n/g, "\n"), hunk.chunks, hunk.file);
		const output = hadCrlf ? updated.replace(/\n/g, "\r\n") : updated;
		if (hunk.moveTo) {
			const dest = path.resolve(cwd, hunk.moveTo);
			fs.mkdirSync(path.dirname(dest), { recursive: true });
			fs.writeFileSync(dest, output, "utf8");
			fs.rmSync(abs);
			changes.push({ action: "M", path: `${hunk.file} -> ${hunk.moveTo}` });
		} else {
			fs.writeFileSync(abs, output, "utf8");
			changes.push({ action: "M", path: hunk.file });
		}
	}
	return changes;
}

export function registerApplyPatchTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "apply_patch",
		label: "apply_patch",
		description: `Use the apply_patch tool to create, update, move, or delete files. The input is the entire patch envelope:

*** Begin Patch
*** Update File: path/to/file.py
@@ def example():
 context line (space prefix)
-old line
+new line
*** End Patch

Hunks: "*** Add File: <path>" (all lines prefixed +), "*** Delete File: <path>", "*** Update File: <path>" (optionally followed by "*** Move to: <new path>"). Within an update, @@ lines locate context, " " lines are unchanged context, "-" lines are removed, "+" lines are added. Use "*** End of File" to anchor a chunk at the end of the file. Paths are relative to the project root.`,
		parameters: Type.Object({
			input: Type.String({ description: "The full patch text, from *** Begin Patch through *** End Patch." }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const changes = applyPatch(params.input, ctx.cwd);
			const summary = ["Success. Updated the following files:", ...changes.map((c) => `${c.action} ${c.path}`)];
			return {
				content: [{ type: "text", text: summary.join("\n") }],
				details: { changes },
			};
		},
	});
}
