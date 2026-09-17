// jail-sentry: makes the staged jail a HARD boundary instead of a polite one.
//
// The staged jail gives a consulted model a temp dir with only the staged
// files — but cwd alone is a soft boundary: read/grep/find/ls accept
// absolute paths and `..` traversals, so nothing stops `read D:\elsewhere`.
// This extension is injected into the jailed child (`pi -e jail-sentry.ts`,
// never autoloaded — it lives in lib/, outside the package's extension dir)
// and intercepts every tool call: any path argument that resolves outside
// GEOCINE_JAIL_ROOT is blocked with a reason the model sees.
//
// Deterministic on purpose. The jailed toolset is read-only with explicit
// path arguments, so "inside the jail?" is exact path math — a classifier
// would add latency and false positives to a question code answers
// perfectly. (If bash is ever allowed in a jail, freeform command strings
// would need a judge node like command-guard; today they are not.)
//
// Every blocked call is appended to GEOCINE_JAIL_AUDIT as one JSONL row.
// The advisor reads that file after the child exits and folds the count
// into the consult_result record and the advisory note — escape attempts
// become visible evidence instead of silent successes, which is how you
// know the jail actually holds.

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Arg keys that name filesystem locations in pi's built-in read tools. */
const PATH_KEYS = ["path", "file_path", "file", "dir", "directory"];

/** True when `candidate` (resolved against `root`) lands outside `root`. */
export function escapesJail(root: string, candidate: string): boolean {
	const resolvedRoot = path.resolve(root);
	const resolvedTarget = path.resolve(resolvedRoot, candidate);
	let rel = path.relative(resolvedRoot, resolvedTarget);
	if (process.platform === "win32") {
		rel = path.relative(resolvedRoot.toLowerCase(), resolvedTarget.toLowerCase());
	}
	return rel !== "" && (rel.startsWith("..") || path.isAbsolute(rel));
}

export default function jailSentry(pi: ExtensionAPI) {
	const root = process.env.GEOCINE_JAIL_ROOT;
	if (!root) return; // not a jailed child: no-op
	const auditFile = process.env.GEOCINE_JAIL_AUDIT;

	pi.on("tool_call", async (event) => {
		const input = (event.input ?? {}) as Record<string, unknown>;
		for (const key of PATH_KEYS) {
			const value = input[key];
			if (typeof value !== "string" || !value.trim()) continue;
			if (!escapesJail(root, value)) continue;

			if (auditFile) {
				const row = { ts: new Date().toISOString(), tool: event.toolName, path: value };
				try {
					fs.appendFileSync(auditFile, `${JSON.stringify(row)}\n`, "utf8");
				} catch {
					// audit is best-effort; the block below is the enforcement
				}
			}
			return {
				block: true,
				reason:
					`[jail] Blocked: "${value}" is outside your workspace. You are consulted inside an isolated directory ` +
					`containing only the files staged for this question — you cannot read anything else. ` +
					`Answer from the staged files; if you need more, name the exact paths in your answer so the caller can stage them.`,
			};
		}
	});
}
