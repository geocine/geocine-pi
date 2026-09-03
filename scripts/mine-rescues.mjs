#!/usr/bin/env node
// mine-rescues: extract manual rescue episodes from existing pi session logs.
//
// pi session JSONL stamps every model change (`model_change` entries) and
// every assistant message with its model, so past "local model got stuck,
// I switched to a frontier model, it fixed it" episodes are recoverable
// offline — no live capture needed for history.
//
// An episode = model_change from a local provider to a non-local provider,
// followed by everything until the next model_change (back to local =
// switch_back) or end of file. Output is one JSON object per episode:
// the failing tail before the switch (failure_context) and the rescuer's
// trajectory (rescue_trajectory) — the raw material for SFT pairs.
//
// Usage:
//   node scripts/mine-rescues.mjs [--sessions <dir>] [--local p1,p2,...]
//                                 [--out <file.jsonl>] [--min-actions 1]
//
// Defaults: --sessions ~/.pi/agent/sessions
//           --local llama.cpp,lmstudio,ollama,abliteration-ai
//           --out rescues.jsonl (in cwd)
//           --min-actions 1  (skip episodes where the rescuer did nothing)
//
// Note: entries form a tree (parentId) when sessions branch; this miner
// reads file order, which matches the active branch closely enough for
// dataset curation. Inspect episodes before training on them.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const args = process.argv.slice(2);
function argValue(name, fallback) {
	const i = args.indexOf(name);
	return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}

const sessionsDir = argValue("--sessions", path.join(os.homedir(), ".pi", "agent", "sessions"));
const localProviders = argValue("--local", "llama.cpp,lmstudio,ollama,abliteration-ai").split(",");
const outFile = argValue("--out", "rescues.jsonl");
const minActions = Number(argValue("--min-actions", "1"));

const TAIL_MESSAGES = 20; // failure-context window before the switch

function* jsonlFiles(dir) {
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) yield* jsonlFiles(full);
		else if (entry.name.endsWith(".jsonl")) yield full;
	}
}

function compactMessage(m) {
	const out = { role: m.role };
	const texts = [];
	const calls = [];
	for (const c of m.content ?? []) {
		if (c.type === "text" && c.text?.trim()) texts.push(c.text);
		else if (c.type === "toolCall") {
			const input = c.arguments ?? c.input ?? {};
			let preview;
			if (c.name === "bash" && typeof input.command === "string") preview = input.command.slice(0, 300);
			else if (typeof (input.path ?? input.file_path) === "string") preview = String(input.path ?? input.file_path);
			else preview = JSON.stringify(input).slice(0, 200);
			calls.push({ name: c.name, preview, args: input });
		}
	}
	if (texts.length) out.text = texts.join("\n").slice(0, m.role === "toolResult" ? 1500 : 4000);
	if (calls.length) out.toolCalls = calls;
	if (m.role === "toolResult" && m.isError) out.isError = true;
	if (m.role === "assistant" && m.model) out.model = m.model;
	return out;
}

function mineFile(file) {
	const episodes = [];
	let header = null;
	let currentModel = null; // { provider, modelId }
	let recentMessages = []; // rolling window while on a local model
	let episode = null;

	const isLocal = (m) => m && localProviders.includes(m.provider);
	const label = (m) => (m ? `${m.provider}/${m.modelId}` : "unknown");

	const finish = (endedBy) => {
		if (!episode) return;
		const actions = episode.rescue_trajectory.filter(
			(m) => m.role === "assistant" && (m.toolCalls?.length ?? 0) > 0,
		).length;
		episode.endedBy = endedBy;
		episode.rescuerActionTurns = actions;
		episode.filesTouched = [
			...new Set(
				episode.rescue_trajectory
					.flatMap((m) => m.toolCalls ?? [])
					.filter((c) => c.name === "write" || c.name === "edit")
					.map((c) => c.args?.path ?? c.args?.file_path)
					.filter((p) => typeof p === "string"),
			),
		];
		for (const m of episode.rescue_trajectory) for (const c of m.toolCalls ?? []) delete c.args;
		if (actions >= minActions) episodes.push(episode);
		episode = null;
	};

	for (const line of fs.readFileSync(file, "utf8").split("\n")) {
		if (!line.trim()) continue;
		let entry;
		try {
			entry = JSON.parse(line);
		} catch {
			continue;
		}
		if (entry.type === "session") {
			header = entry;
		} else if (entry.type === "model_change") {
			const next = { provider: entry.provider, modelId: entry.modelId };
			if (episode && isLocal(next)) {
				finish("switch_back");
			} else if (!episode && isLocal(currentModel) && !isLocal(next) && recentMessages.length > 0) {
				episode = {
					session: file,
					cwd: header?.cwd,
					switchedAt: entry.timestamp,
					fromModel: label(currentModel),
					toModel: label(next),
					failure_context: recentMessages.slice(-TAIL_MESSAGES),
					rescue_trajectory: [],
				};
			}
			currentModel = next;
		} else if (entry.type === "message" && entry.message) {
			const compact = compactMessage(entry.message);
			if (episode) episode.rescue_trajectory.push(compact);
			else {
				recentMessages.push(compact);
				if (recentMessages.length > TAIL_MESSAGES * 2) recentMessages = recentMessages.slice(-TAIL_MESSAGES);
			}
		}
	}
	finish("session_end");
	return episodes;
}

if (!fs.existsSync(sessionsDir)) {
	console.error(`sessions dir not found: ${sessionsDir}`);
	process.exit(1);
}

let files = 0;
const all = [];
for (const file of jsonlFiles(sessionsDir)) {
	files++;
	try {
		all.push(...mineFile(file));
	} catch (err) {
		console.error(`skip ${file}: ${err.message}`);
	}
}

fs.writeFileSync(outFile, all.map((e) => JSON.stringify(e)).join("\n") + (all.length ? "\n" : ""), "utf8");

console.error(`scanned ${files} session file(s), found ${all.length} rescue episode(s) -> ${outFile}`);
for (const e of all) {
	console.error(
		`  ${e.switchedAt}  ${e.fromModel} -> ${e.toModel}  turns=${e.rescue_trajectory.length} actions=${e.rescuerActionTurns} files=${e.filesTouched.length} endedBy=${e.endedBy}  (${e.cwd})`,
	);
}
