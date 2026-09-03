// bash-repair: output hygiene + failure formatting for the bash tool.
//
// Vendored TypeScript port of aiterator's outputhygiene + failfmt Go
// extensions (aiterator is the reference; nothing here imports from it).
//
// Two passes, deliberately in one tool_result handler so order is guaranteed:
//   1. Sanitize: strip ANSI CSI/OSC/DCS sequences and stray C0 bytes, and
//      apply terminal carriage-return semantics so progress-bar spam
//      collapses to its final frame.
//   2. failfmt: recognize go test / go build / cargo / pytest / node failures
//      and PREPEND a compact structured block (failing check, file:line,
//      observed vs expected) so a cheap model acts on the failure without
//      re-reading the whole dump. Unrecognized output passes through as-is.
//
// The original output is never lost: the summary is prepended, and the
// sanitized original follows below it.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const FIELD_LIMIT = 200;

// ---------- pass 1: output hygiene ----------

function hasStrayControl(text: string): boolean {
	for (let i = 0; i < text.length; i++) {
		const c = text.charCodeAt(i);
		if (c < 0x20 && c !== 0x0a && c !== 0x09 && c !== 0x0d) return true;
	}
	return false;
}

function skipEscapeSequence(text: string, start: number): number {
	let i = start + 1;
	if (i >= text.length) return i;
	const kind = text[i];
	if (kind === "[") {
		// CSI: parameters/intermediates 0x20-0x3F, final byte 0x40-0x7E.
		i++;
		while (i < text.length) {
			const c = text.charCodeAt(i);
			i++;
			if (c >= 0x40 && c <= 0x7e) break;
		}
		return i;
	}
	if (kind === "]" || kind === "P" || kind === "X" || kind === "^" || kind === "_") {
		// OSC / DCS / SOS / PM / APC: run to BEL or ST (ESC \).
		i++;
		while (i < text.length) {
			if (text.charCodeAt(i) === 0x07) return i + 1;
			if (text.charCodeAt(i) === 0x1b && text[i + 1] === "\\") return i + 2;
			i++;
		}
		return i;
	}
	// Two-byte sequence such as ESC c, ESC ( B.
	return i + 1;
}

function stripEscapes(text: string): string {
	let out = "";
	let i = 0;
	while (i < text.length) {
		const c = text.charCodeAt(i);
		if (c === 0x1b) {
			i = skipEscapeSequence(text, i);
			continue;
		}
		if (c < 0x20 && c !== 0x0a && c !== 0x09 && c !== 0x0d) {
			i++;
			continue;
		}
		out += text[i];
		i++;
	}
	return out;
}

function resolveCarriageReturns(text: string): string {
	if (!text.includes("\r")) return text;
	let t = text.replace(/\r\n/g, "\n");
	if (!t.includes("\r")) return t;
	const lines = t.split("\n");
	for (let idx = 0; idx < lines.length; idx++) {
		if (!lines[idx].includes("\r")) continue;
		let rendered = "";
		for (const segment of lines[idx].split("\r")) {
			rendered = segment.length >= rendered.length ? segment : segment + rendered.slice(segment.length);
		}
		lines[idx] = rendered;
	}
	return lines.join("\n");
}

export function sanitize(text: string): string {
	if (!/[\x1b\r\b\x07]/.test(text) && !hasStrayControl(text)) return text;
	return resolveCarriageReturns(stripEscapes(text));
}

// ---------- pass 2: failfmt ----------

interface Failure {
	runner: string;
	check?: string;
	location?: string;
	observed?: string;
	expected?: string;
	detail?: string;
	count: number;
}

function truncateField(text: string): string {
	const flat = text.replace(/\n/g, " ");
	if (flat.length <= FIELD_LIMIT) return flat;
	return `${flat.slice(0, FIELD_LIMIT)}…`;
}

function render(f: Failure): string {
	let out = `[failfmt] ${f.runner} failure`;
	if (f.check) out += `: ${truncateField(f.check)}`;
	if (f.count > 1) out += ` (+${f.count - 1} more)`;
	if (f.location) out += `\nat: ${truncateField(f.location)}`;
	if (f.observed || f.expected) {
		if (f.observed) out += `\nobserved: ${truncateField(f.observed)}`;
		if (f.expected) out += `\nexpected: ${truncateField(f.expected)}`;
	} else if (f.detail) {
		out += `\ndetail: ${truncateField(f.detail)}`;
	}
	return out;
}

function firstLine(text: string): string {
	for (const line of text.split("\n")) {
		const trimmed = line.trim();
		if (trimmed) return trimmed;
	}
	return "";
}

// --- go test ---
const goTestFail = /^\s*--- FAIL: (\S+)/m;
const goTestFailAll = /^\s*--- FAIL: (\S+)/gm;
const goTestLoc = /^\s+([\w./\\-]+\.go):(\d+): (.+)$/m;
const goGotWant = /^got (.+?), want (.+)$/;

function detectGoTest(output: string): Failure | undefined {
	const fails = [...output.matchAll(goTestFailAll)];
	if (fails.length === 0) return undefined;
	const f: Failure = { runner: "go test", check: fails[0][1], count: fails.length };
	const loc = goTestLoc.exec(output);
	if (loc) {
		f.location = `${loc[1]}:${loc[2]}`;
		f.detail = loc[3];
		const gw = goGotWant.exec(loc[3]);
		if (gw) {
			f.observed = gw[1];
			f.expected = gw[2];
		}
	}
	return f;
}

// --- go build ---
const goBuildErrAll = /^([\w./\\~-]+\.go):(\d+):(?:\d+:)? (.+)$/gm;

function detectGoBuild(output: string): Failure | undefined {
	const errs = [...output.matchAll(goBuildErrAll)];
	if (errs.length === 0) return undefined;
	return { runner: "go build", location: `${errs[0][1]}:${errs[0][2]}`, detail: errs[0][3], count: errs.length };
}

// --- cargo ---
const cargoPanic = /^thread '([^']+)' panicked at ([\w./\\:-]+?):(\d+):\d+:\s*$/m;
const cargoPanicOld = /^thread '([^']+)' panicked at '([^']*)', ([\w./\\:-]+?):(\d+):\d+/m;
const cargoFailedAll = /^test (\S+) \.\.\. FAILED$/gm;
const cargoLeft = /^\s*left: (.+?),?\s*$/m;
const cargoRight = /^\s*right: (.+?),?\s*$/m;
const rustcErr = /^error(\[E\d+\])?: (.+)$/m;
const rustcErrAll = /^error(\[E\d+\])?: (.+)$/gm;
const rustcLoc = /^\s*--> ([\w./\\-]+):(\d+):\d+/m;

function fillCargoLeftRight(f: Failure, text: string): void {
	const left = cargoLeft.exec(text);
	const right = cargoRight.exec(text);
	if (left && right) {
		f.observed = left[1];
		f.expected = right[1];
	}
}

function detectCargo(output: string): Failure | undefined {
	const failCount = [...output.matchAll(cargoFailedAll)].length;

	const panic = cargoPanic.exec(output);
	if (panic) {
		const rest = output.slice((panic.index ?? 0) + panic[0].length);
		const f: Failure = {
			runner: "cargo test",
			check: panic[1],
			location: `${panic[2]}:${panic[3]}`,
			detail: firstLine(rest),
			count: Math.max(failCount, 1),
		};
		fillCargoLeftRight(f, rest);
		return f;
	}
	const oldPanic = cargoPanicOld.exec(output);
	if (oldPanic) {
		const f: Failure = {
			runner: "cargo test",
			check: oldPanic[1],
			detail: oldPanic[2],
			location: `${oldPanic[3]}:${oldPanic[4]}`,
			count: Math.max(failCount, 1),
		};
		fillCargoLeftRight(f, output);
		return f;
	}
	const err = rustcErr.exec(output);
	const loc = rustcLoc.exec(output);
	if (err && loc) {
		return {
			runner: "cargo",
			location: `${loc[1]}:${loc[2]}`,
			detail: err[2],
			count: [...output.matchAll(rustcErrAll)].length,
		};
	}
	if (failCount > 0) {
		const first = /^test (\S+) \.\.\. FAILED$/m.exec(output);
		return { runner: "cargo test", check: first?.[1], count: failCount };
	}
	return undefined;
}

// --- pytest ---
const pytestFailedAll = /^FAILED ([\w./\\-]+\.py)::(\S+?)(?: - (.+))?$/gm;
const pytestLoc = /^([\w./\\-]+\.py):(\d+): (.+)$/m;
const pytestE = /^E\s+(.+)$/m;
const pytestAssert = /^assert (.+?) [=!<>]+ (.+)$/;

function detectPytest(output: string): Failure | undefined {
	const fails = [...output.matchAll(pytestFailedAll)];
	const eLine = pytestE.exec(output);
	const loc = pytestLoc.exec(output);
	if (fails.length === 0 && (!eLine || !loc)) return undefined;
	const f: Failure = { runner: "pytest", count: Math.max(fails.length, 1) };
	if (fails.length > 0) {
		f.check = fails[0][2];
		f.detail = fails[0][3];
	}
	if (loc) f.location = `${loc[1]}:${loc[2]}`;
	if (eLine && !f.detail) f.detail = eLine[1];
	if (f.detail) {
		const a = pytestAssert.exec(f.detail);
		if (a) {
			f.observed = a[1];
			f.expected = a[2];
		}
	}
	return f;
}

// --- node ---
const nodeAssert = /AssertionError(?: \[ERR_ASSERTION\])?: ([^\n]+)/;
const nodeError = /^((?:[A-Z][A-Za-z]*)?Error): (.+)$/m;
const nodeFrame = /^\s+at (?:.*\()?((?:[A-Za-z]:)?[^():\s][^():]*):(\d+):\d+\)?$/m;
const nodeNotStrict = /^\s*(.+?) !== (.+?)\s*$/m;

function detectNode(output: string): Failure | undefined {
	const frame = nodeFrame.exec(output);
	if (!frame) return undefined;
	const location = `${frame[1]}:${frame[2]}`;
	const assert = nodeAssert.exec(output);
	if (assert) {
		const f: Failure = { runner: "node", check: assert[1], location, count: 1 };
		const diff = nodeNotStrict.exec(output);
		if (diff) {
			f.observed = diff[1];
			f.expected = diff[2];
		}
		return f;
	}
	const err = nodeError.exec(output);
	if (err) {
		return { runner: "node", check: `${err[1]}: ${err[2]}`, location, count: 1 };
	}
	return undefined;
}

export function summarize(output: string): string | undefined {
	for (const detect of [detectGoTest, detectCargo, detectPytest, detectGoBuild, detectNode]) {
		const f = detect(output);
		if (f) return render(f);
	}
	return undefined;
}

// ---------- extension ----------

export default function bashRepair(pi: ExtensionAPI) {
	pi.on("tool_result", async (event) => {
		if (event.toolName !== "bash") return;
		const content = Array.isArray(event.content) ? event.content : [];
		let changed = false;

		const next = content.map((block: any) => {
			if (!block || block.type !== "text" || typeof block.text !== "string") return block;
			let text = sanitize(block.text);
			// Only summarize failures: successful runs pass through untouched
			// even when their output mentions failure-like text.
			if (event.isError) {
				const summary = summarize(text);
				if (summary) text = `${summary}\n\n${text}`;
			}
			if (text === block.text) return block;
			changed = true;
			return { ...block, text };
		});

		if (!changed) return;
		return { content: next };
	});
}
