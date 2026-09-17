// Distill a captured rescue episode into a draft lesson file.
//
// Shared by extensions/rescue.ts (/distill) and extensions/geocine-menu.ts
// (/geocine → Distill). Reads work off RescueRecords, which live in the
// consult-log — so distillation works across sessions, not just on the
// in-memory episode of the current one.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type GeocineConfig, logDir, resolveModel } from "./config.ts";
import type { RescueRecord } from "./consult-log.ts";
import { runPi } from "./pi-exec.ts";

export const LESSONS_DIR = path.join(os.homedir(), ".pi", "agent", "rescue-lessons");

/** Newest rescue record across all consult-log month files. */
export function latestRescueRecord(cfg: GeocineConfig): RescueRecord | undefined {
	const dir = logDir(cfg);
	let files: string[];
	try {
		files = fs
			.readdirSync(dir)
			.filter((f) => f.endsWith(".jsonl"))
			.sort()
			.reverse();
	} catch {
		return undefined;
	}
	for (const file of files) {
		const lines = fs.readFileSync(path.join(dir, file), "utf8").split("\n");
		for (let i = lines.length - 1; i >= 0; i--) {
			if (!lines[i].includes('"type":"rescue"')) continue;
			try {
				const record = JSON.parse(lines[i]) as RescueRecord;
				if (record.type === "rescue") return record;
			} catch {
				// skip malformed line
			}
		}
	}
	return undefined;
}

export interface DistillOutcome {
	ok: boolean;
	message: string;
	file?: string;
}

export async function distillRescue(
	cfg: GeocineConfig,
	record: RescueRecord,
	cwd: string,
): Promise<DistillOutcome> {
	const distillName = cfg.rescue?.distillModel ?? cfg.prescreen?.model;
	const resolved = resolveModel(cfg, distillName);
	if ("error" in resolved) return { ok: false, message: `No distill model available: ${resolved.error}` };

	const prompt = [
		"A weak local coding model failed at a task; a stronger model was brought in and fixed it. From the evidence below, write ONE transferable lesson the weak model could apply next time, as markdown:",
		"# <short imperative title>",
		"**When:** <the recognizable symptom/situation>",
		"**Do:** <the concrete approach that worked, 3-6 steps max>",
		"**Why the naive approach fails:** <one sentence>",
		"Base it strictly on the evidence. No generic advice.",
		"",
		`## Evidence`,
		`Weak model: ${record.fromModel} | Rescuer: ${record.toModel}`,
		`### Failing tail (weak model)`,
		record.failureDigest,
		`### Rescuer actions`,
		record.toolEvents.map((e) => `${e.ok ? "ok " : "FAIL"} ${e.preview}`).join("\n") || "(none)",
		`### Files changed`,
		record.filesTouched.join("\n") || "(none)",
		`### Rescuer's own summary`,
		record.rescuerSummary || "(none)",
	].join("\n");

	const result = await runPi({
		cwd,
		provider: resolved.model.provider,
		model: resolved.model.model,
		tools: [],
		prompt,
		timeoutMs: 180_000,
	});
	if (!result.finalText.trim()) {
		return { ok: false, message: `Distillation produced no output (exit ${result.exitCode}).` };
	}

	fs.mkdirSync(LESSONS_DIR, { recursive: true });
	const slug = (record.filesTouched[0] ? path.basename(record.filesTouched[0]) : "lesson").replace(/[^\w.-]+/g, "_");
	const file = path.join(LESSONS_DIR, `${record.ts.slice(0, 10)}-${slug}-${record.cid.slice(0, 8)}.md`);
	const frontmatter = [
		"---",
		`cid: ${record.cid}`,
		`from: ${record.fromModel}`,
		`rescuer: ${record.toModel}`,
		`cwd: ${record.cwd}`,
		`captured: ${record.ts}`,
		"status: draft  # promote manually into AGENTS.md or a skill; drafts are never auto-loaded",
		"---",
		"",
	].join("\n");
	fs.writeFileSync(file, frontmatter + result.finalText.trim() + "\n", "utf8");
	return { ok: true, message: `Lesson draft written: ${file}`, file };
}
