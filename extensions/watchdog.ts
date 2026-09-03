// watchdog: set-and-forget failure detection for the local worker.
//
// Tier 0 — deterministic counters (always on, zero cost, ~zero false
//   positives): repeated identical tool calls, same command failing
//   repeatedly, long error streaks.
// Tier 1 — optional low-context LLM verdict from a SECOND small model
//   (config: watchdog.baseUrl / watchdog.model). Never point this at the
//   same single-slot llama.cpp server as the main model: the side request
//   evicts the main session's KV cache and the next turn re-prefills
//   everything.
// Tier 2 — "Located" hint: when a problem is confirmed, the finding is
//   injected back into the worker's context (naming the failed pattern, not
//   the answer — the repair strategy that recovered 45% vs 16% for blind
//   retries in the real-time failure detection literature). After repeated
//   hints for the same incident, the hint suggests using the consult tool.
//
// Every verdict is logged to the consult-log with its decision-time digest,
// so months of use become training data for a dedicated watchdog LoRA.

import * as crypto from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadConfig, logDir } from "../lib/config.ts";
import { appendRecord, newCid, nowIso } from "../lib/consult-log.ts";

interface ToolEventSummary {
	name: string;
	key: string;
	isError: boolean;
	preview: string;
}

const RING_SIZE = 24;

function argsKey(toolName: string, input: unknown): string {
	const hash = crypto.createHash("sha1");
	hash.update(toolName);
	hash.update(JSON.stringify(input ?? {}));
	return hash.digest("hex").slice(0, 12);
}

function argsPreview(toolName: string, input: any): string {
	if (toolName === "bash" && typeof input?.command === "string") {
		return input.command.slice(0, 80);
	}
	const p = input?.path ?? input?.file_path;
	if (typeof p === "string") return `${toolName} ${p}`.slice(0, 80);
	return `${toolName} ${JSON.stringify(input ?? {}).slice(0, 60)}`;
}

interface Tier0Verdict {
	verdict: "loop" | "stuck" | "ok";
	reason: string;
	incidentKey: string;
}

function evaluateTier0(
	ring: ToolEventSummary[],
	loopThreshold: number,
	failStreakThreshold: number,
): Tier0Verdict {
	if (ring.length === 0) return { verdict: "ok", reason: "", incidentKey: "" };

	// Identical call repeated N times consecutively (regardless of outcome).
	let repeat = 1;
	for (let i = ring.length - 1; i > 0; i--) {
		if (ring[i].key === ring[i - 1].key) repeat++;
		else break;
	}
	const last = ring[ring.length - 1];
	if (repeat >= loopThreshold) {
		return {
			verdict: "loop",
			reason: `the exact same tool call has been made ${repeat} times in a row: ${last.preview}`,
			incidentKey: `loop:${last.key}`,
		};
	}

	// Same command failing repeatedly (not necessarily consecutively).
	const failCounts = new Map<string, { count: number; preview: string }>();
	for (const e of ring.slice(-10)) {
		if (!e.isError) continue;
		const entry = failCounts.get(e.key) ?? { count: 0, preview: e.preview };
		entry.count++;
		failCounts.set(e.key, entry);
	}
	for (const [key, { count, preview }] of failCounts) {
		if (count >= failStreakThreshold) {
			return {
				verdict: "stuck",
				reason: `the same command has now failed ${count} times: ${preview}`,
				incidentKey: `fail:${key}`,
			};
		}
	}

	// Long error streak across different calls.
	let errStreak = 0;
	for (let i = ring.length - 1; i >= 0; i--) {
		if (ring[i].isError) errStreak++;
		else break;
	}
	if (errStreak >= failStreakThreshold + 2) {
		return {
			verdict: "stuck",
			reason: `${errStreak} consecutive tool calls have failed`,
			incidentKey: "errstreak",
		};
	}

	return { verdict: "ok", reason: "", incidentKey: "" };
}

async function tier1Verdict(
	baseUrl: string,
	model: string | undefined,
	apiKey: string | undefined,
	digest: string,
): Promise<{ verdict: "ok" | "loop" | "stuck" | "drift"; reason: string } | undefined> {
	try {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), 20_000);
		const response = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
			},
			body: JSON.stringify({
				model: model ?? "watchdog",
				temperature: 0,
				max_tokens: 200,
				messages: [
					{
						role: "system",
						content:
							'You watch a coding agent\'s recent activity for failure patterns. Reply with ONLY JSON: {"verdict":"ok|loop|stuck|drift","reason":"one short sentence naming the specific problem"}. "loop": repeating the same action expecting different results. "stuck": repeated failures without a strategy change. "drift": activity no longer serves the stated task. "ok": normal progress (including normal debugging).',
					},
					{ role: "user", content: digest },
				],
			}),
			signal: controller.signal,
		});
		clearTimeout(timer);
		if (!response.ok) return undefined;
		const data: any = await response.json();
		const text: string = data?.choices?.[0]?.message?.content ?? "";
		const jsonMatch = /\{[\s\S]*\}/.exec(text);
		if (!jsonMatch) return undefined;
		const parsed = JSON.parse(jsonMatch[0]);
		if (["ok", "loop", "stuck", "drift"].includes(parsed.verdict)) {
			return { verdict: parsed.verdict, reason: String(parsed.reason ?? "").slice(0, 300) };
		}
	} catch {
		// watchdog must never break the session
	}
	return undefined;
}

export default function watchdog(pi: ExtensionAPI) {
	let enabled = true;
	let ring: ToolEventSummary[] = [];
	let turnIndex = 0;
	let lastHintTurn = -999;
	let lastUserMessage = "";
	let incidentHints = new Map<string, number>();
	let currentCid: string | undefined;

	const reset = () => {
		ring = [];
		turnIndex = 0;
		lastHintTurn = -999;
		incidentHints = new Map();
		currentCid = undefined;
	};

	function digestText(ctx: ExtensionContext): string {
		const recent = ring
			.slice(-12)
			.map((e) => `${e.isError ? "FAIL" : "ok  "} ${e.preview}`)
			.join("\n");
		return [
			`Task (latest user message): ${lastUserMessage.slice(0, 300) || "(unknown)"}`,
			`Model: ${(ctx.model as any)?.id ?? "?"} | turn ${turnIndex}`,
			`Recent tool calls (oldest first):`,
			recent || "(none)",
		].join("\n");
	}

	pi.on("session_start", async () => reset());

	pi.on("input", async (event) => {
		if (typeof (event as any).text === "string" && !(event as any).text.startsWith("/")) {
			lastUserMessage = (event as any).text;
			// New user direction closes the current incident.
			incidentHints = new Map();
			currentCid = undefined;
		}
	});

	pi.on("tool_result", async (event) => {
		if (!enabled) return;
		const summary: ToolEventSummary = {
			name: event.toolName,
			key: argsKey(event.toolName, event.input),
			isError: Boolean(event.isError),
			preview: argsPreview(event.toolName, event.input),
		};
		ring.push(summary);
		if (ring.length > RING_SIZE) ring.shift();
	});

	pi.on("turn_end", async (_event, ctx) => {
		if (!enabled) return;
		turnIndex++;
		const cfg = loadConfig(ctx.cwd);
		const wd = cfg.watchdog ?? {};
		if (wd.enabled === false) return;

		const tier0 = evaluateTier0(ring, wd.loopThreshold ?? 3, wd.failStreakThreshold ?? 3);
		if (tier0.verdict === "ok") {
			ctx.ui.setStatus("watchdog", undefined);
			return;
		}

		const cooldown = wd.hintCooldownTurns ?? 4;
		if (turnIndex - lastHintTurn < cooldown) return;

		// Tier 1: confirm with the small LLM when configured.
		let verdict: "loop" | "stuck" | "drift" = tier0.verdict;
		let reason = tier0.reason;
		let tier: 0 | 1 = 0;
		const digest = digestText(ctx);
		if (wd.baseUrl) {
			const llm = await tier1Verdict(
				wd.baseUrl,
				wd.model,
				wd.apiKeyEnv ? process.env[wd.apiKeyEnv] : undefined,
				digest,
			);
			if (llm) {
				tier = 1;
				if (llm.verdict === "ok") {
					// LLM overrules the counter — log the disagreement, no hint.
					appendRecord(logDir(cfg), {
						type: "watchdog",
						cid: currentCid ?? (currentCid = newCid()),
						ts: nowIso(),
						cwd: ctx.cwd,
						tier,
						verdict: "ok",
						reason: `tier0 said ${tier0.verdict} (${tier0.reason}); tier1 overruled: ${llm.reason}`,
						digest,
						hintSent: false,
						turnIndex,
					});
					return;
				}
				verdict = llm.verdict;
				reason = llm.reason || tier0.reason;
			}
		}

		currentCid ??= newCid();
		const hintsSoFar = incidentHints.get(tier0.incidentKey) ?? 0;
		const sendHints = wd.sendHints !== false;
		let hintSent = false;

		if (sendHints) {
			// "Located" repair: name the check that fired, never the fix.
			let hint =
				`[watchdog] Detected ${verdict}: ${reason}. ` +
				`Stop and reassess before repeating the same action. State in one sentence why the previous attempts failed, then either change approach or gather the missing information first.`;
			if (hintsSoFar >= 1) {
				hint +=
					` This is repeat detection #${hintsSoFar + 1} for the same issue — consider the consult tool now: stage the relevant files and ask for a diagnosis instead of retrying.`;
			}
			try {
				pi.sendUserMessage(hint, ctx.isIdle() ? undefined : { deliverAs: "steer" });
				hintSent = true;
				lastHintTurn = turnIndex;
				incidentHints.set(tier0.incidentKey, hintsSoFar + 1);
			} catch {
				// delivery constraints changed mid-turn; skip this round
			}
		}

		ctx.ui.setStatus("watchdog", `watchdog: ${verdict} — ${reason.slice(0, 60)}`);
		appendRecord(logDir(cfg), {
			type: "watchdog",
			cid: currentCid,
			ts: nowIso(),
			cwd: ctx.cwd,
			mainModel: (ctx.model as any) ? `${(ctx.model as any).provider}/${(ctx.model as any).id}` : undefined,
			tier,
			verdict,
			reason,
			digest,
			hintSent,
			turnIndex,
		});
	});

	pi.registerCommand("watchdog", {
		description: "Watchdog detection: /watchdog on|off|status",
		handler: async (args, ctx) => {
			const arg = String(args ?? "").trim().toLowerCase();
			if (arg === "on") enabled = true;
			else if (arg === "off") {
				enabled = false;
				ctx.ui.setStatus("watchdog", undefined);
			}
			const cfg = loadConfig(ctx.cwd);
			const wd = cfg.watchdog ?? {};
			ctx.ui.notify(
				[
					`watchdog: ${enabled && wd.enabled !== false ? "ON" : "OFF"}`,
					`tier1 endpoint: ${wd.baseUrl ?? "(none — tier 0 counters only)"}`,
					`hints: ${wd.sendHints !== false ? "on" : "off"}, cooldown ${wd.hintCooldownTurns ?? 4} turns`,
					`ring: ${ring.length} recent tool calls tracked`,
				].join("\n"),
				"info",
			);
		},
	});
}
