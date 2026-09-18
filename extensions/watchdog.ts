// watchdog: set-and-forget failure detection for the local worker.
//
// Tier 0 — deterministic counters (always on, zero cost, ~zero false
//   positives): repeated identical tool calls, same command failing
//   repeatedly, long error streaks.
// Judge — optional System One classifier verdict (config: judge block,
//   lib/judge). A calibrated typed choice in ~100-500ms. By default it
//   runs EVERY turn with new tool activity (watchdog.judgeEveryTurn,
//   default true) — the only way drift gets detected, since no counter can
//   see it; judge-only findings need judge.minConfidence to act. When a
//   counter fired, the judge verifies: its confident "ok" overrules the
//   counter (confidence-gated routing), non-ok refines the verdict label.
//   Unavailable/timeout = silently fall through to Tier 1. The same call
//   carries the mid-task escalate-now noul (triage config): judged against
//   session stage (invested tokens, cache warmth), a high probability
//   suggests handing the task to the frontier rescuer — even on quiet
//   turns, since grinding without errors on a too-hard task never trips a
//   counter. Task-START routing lives in triage.ts.
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
import { modelHandle, isLocalWorker, loadConfig, logDir, resolveModel } from "../lib/config.ts";
import { appendRecord, newCid, nowIso } from "../lib/consult-log.ts";
import {
	choiceOf,
	DEFAULT_MIN_CONFIDENCE,
	judge,
	type JudgeQuestion,
	judgeStatus,
	modelBaseUrl,
	noulOf,
	resolveJudge,
} from "../lib/judge/index.ts";

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
	// Every-turn judging bookkeeping: only judge when there is new tool
	// activity since the last judge call (idle turns have nothing to judge).
	let toolEventsSeen = 0;
	let lastJudgedEvents = 0;
	let lastEscalateTurn = -999;

	const reset = () => {
		ring = [];
		turnIndex = 0;
		lastHintTurn = -999;
		incidentHints = new Map();
		currentCid = undefined;
		toolEventsSeen = 0;
		lastJudgedEvents = 0;
		lastEscalateTurn = -999;
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
		toolEventsSeen++;
	});

	pi.on("turn_end", async (_event, ctx) => {
		if (!enabled) return;
		turnIndex++;
		const cfg = loadConfig(ctx.cwd);
		const wd = cfg.watchdog ?? {};
		if (wd.enabled === false) return;

		const tier0 = evaluateTier0(ring, wd.loopThreshold ?? 3, wd.failStreakThreshold ?? 3);
		const counterVerdict = tier0.verdict === "ok" ? undefined : tier0.verdict;

		// Every-turn judging (default when a judge is configured): each turn
		// with new tool activity gets a verdict, not only turns where a
		// counter fired — this is what makes drift detectable at all, and
		// System One calls are fast/cheap enough to afford it. Set
		// watchdog.judgeEveryTurn: false for verify-only judging.
		const everyTurn = wd.judgeEveryTurn !== false && resolveJudge(cfg.judge) !== undefined;
		if (!counterVerdict) {
			ctx.ui.setStatus("watchdog", undefined);
			if (!everyTurn) return;
			// A routine check needs something new to look at.
			if (ring.length < 3 || toolEventsSeen === lastJudgedEvents) return;
		}

		const cooldown = wd.hintCooldownTurns ?? 4;
		if (turnIndex - lastHintTurn < cooldown) return;

		// Resolve a finding: judge (fast, calibrated) first, then the
		// small-LLM tier as counter verification. Either may overrule a
		// counter to "ok" or refine its label.
		let finding: { verdict: "loop" | "stuck" | "drift"; reason: string; incidentKey: string } | undefined;
		let tier: 0 | 1 | "judge" = 0;
		const digest = digestText(ctx);
		const minConfidence = cfg.judge?.minConfidence ?? DEFAULT_MIN_CONFIDENCE;

		const usage = ctx.getContextUsage();
		const window = (ctx.model as { contextWindow?: number } | undefined)?.contextWindow;
		const questions: Record<string, JudgeQuestion> = {
			verdict: {
				type: "choice",
				instructions:
					"You are watching a coding agent's recent activity (`heuristic_signal` says whether a deterministic counter flagged it). Judge from `recent_tool_calls` whether there is a real failure pattern or normal progress on `task`.",
				criteria: {
					ok: "Normal progress, including ordinary debugging",
					loop: "Repeating the same action expecting different results",
					stuck: "Repeated failures without a strategy change",
					drift: "Activity no longer serves the stated task",
				},
			},
		};
		// The escalate-now check rides the same call (parallel questions are
		// one request — near-free). It is the mid-task half of triage, and
		// like triage it only applies while the cheap local worker is
		// active: a frontier main model gets no escalate suggestions.
		if (cfg.triage?.enabled !== false && isLocalWorker(ctx.model, cfg)) {
			questions.escalate = {
				type: "noul",
				instructions:
					"Would handing `task` to a much stronger frontier-class model RIGHT NOW likely produce a better outcome than the local model continuing? Weigh the economics from `session_stage` and `recent_tool_calls`: continuing locally is cheap while progress is normal (warm cache, no handoff cost); escalating pays when the work exceeds local capability or attempts keep failing. A high `context_pct` means much invested state a handoff brief would lose.",
				criteria: {
					true: "Escalate now — a frontier consult would resolve this faster or catch what the local model cannot",
					false: "Keep local — normal progress, or escalation would not pay for its handoff cost",
				},
			};
		}
		const judged = await judge(cfg.judge, {
			state: {
				task: lastUserMessage.slice(0, 300) || "(unknown)",
				heuristic_signal: counterVerdict
					? tier0.reason
					: "none — routine every-turn check, no counter fired",
				recent_tool_calls: ring.slice(-12).map((e) => ({ status: e.isError ? "failed" : "ok", call: e.preview })),
				session_stage: {
					turn: turnIndex,
					context_tokens: usage?.tokens ?? 0,
					context_pct: usage?.tokens != null && window ? Math.round((usage.tokens / window) * 100) : 0,
				},
			},
			questions,
		}, { node: "watchdog", workerBaseUrl: modelBaseUrl(ctx.model) });
		lastJudgedEvents = toolEventsSeen;
		const escalateP = noulOf(judged, "escalate");
		const judgedVerdict = choiceOf(judged, "verdict");
		if (judgedVerdict && ["ok", "loop", "stuck", "drift"].includes(judgedVerdict.choice)) {
			tier = "judge";
			const conf = judgedVerdict.confidence.toFixed(2);
			if (judgedVerdict.choice === "ok") {
				// Quiet turn with no failure finding — but the escalate check
				// can still fire: grinding without errors on a task beyond
				// local capability looks exactly like this.
				if (!counterVerdict) {
					const threshold = cfg.triage?.escalateThreshold ?? 0.75;
					const escalateCooldown = cfg.triage?.cooldownTurns ?? 8;
					if (
						escalateP !== undefined &&
						escalateP >= threshold &&
						turnIndex - lastEscalateTurn >= escalateCooldown &&
						wd.sendHints !== false
					) {
						const rescuer = resolveModel(cfg);
						const name = "error" in rescuer ? undefined : rescuer.name;
						const handle = name ? modelHandle(cfg, name) : undefined;
						const role = "error" in rescuer || !rescuer.model.role ? "" : ` (${rescuer.model.role})`;
						try {
							pi.sendUserMessage(
								`[watchdog] Escalation check: handing this to a stronger model now looks better than continuing locally (p=${escalateP.toFixed(2)}). Consider the consult tool${handle ? ` with the "${handle}" rescuer${role}` : ""}: stage the key files and ask for a diagnosis or plan.`,
								ctx.isIdle() ? undefined : { deliverAs: "steer" },
							);
							lastEscalateTurn = turnIndex;
							lastHintTurn = turnIndex;
							appendRecord(logDir(cfg), {
								type: "watchdog",
								cid: currentCid ?? (currentCid = newCid()),
								ts: nowIso(),
								cwd: ctx.cwd,
								tier,
								verdict: "ok",
								reason: `escalation check fired without a failure finding (p=${escalateP.toFixed(2)})`,
								digest,
								hintSent: true,
								turnIndex,
								escalateP,
							});
						} catch {
							// delivery constraints changed; retry next eligible turn
						}
					}
					return;
				}
				// Overruling a counter requires confidence; a hesitant "ok"
				// leaves the deterministic verdict standing.
				if (judgedVerdict.confidence >= minConfidence) {
					appendRecord(logDir(cfg), {
						type: "watchdog",
						cid: currentCid ?? (currentCid = newCid()),
						ts: nowIso(),
						cwd: ctx.cwd,
						tier,
						verdict: "ok",
						reason: `tier0 said ${tier0.verdict} (${tier0.reason}); judge overruled with confidence ${conf}`,
						digest,
						hintSent: false,
						turnIndex,
						escalateP,
					});
					return;
				}
				finding = { verdict: counterVerdict, reason: tier0.reason, incidentKey: tier0.incidentKey };
			} else {
				const judgeVerdict = judgedVerdict.choice as "loop" | "stuck" | "drift";
				// With no counter behind it the judge is the sole accuser —
				// the same confidence floor gates the accusation.
				if (!counterVerdict && judgedVerdict.confidence < minConfidence) return;
				finding = counterVerdict
					? {
							verdict: judgeVerdict,
							reason: `${tier0.reason} (judge: ${judgeVerdict}, confidence ${conf})`,
							incidentKey: tier0.incidentKey,
						}
					: {
							verdict: judgeVerdict,
							reason: `the judge classifier flagged ${judgeVerdict} across the recent tool calls (confidence ${conf}; no counter fired)`,
							incidentKey: `judge:${judgeVerdict}`,
						};
			}
		} else if (!counterVerdict) {
			// Routine check with no judge answer: nothing to act on.
			return;
		} else {
			finding = { verdict: counterVerdict, reason: tier0.reason, incidentKey: tier0.incidentKey };
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
							escalateP,
						});
						return;
					}
					finding = { verdict: llm.verdict, reason: llm.reason || tier0.reason, incidentKey: tier0.incidentKey };
				}
			}
		}
		if (!finding) return;
		const { verdict, reason, incidentKey } = finding;

		currentCid ??= newCid();
		const hintsSoFar = incidentHints.get(incidentKey) ?? 0;
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
			if (escalateP !== undefined && escalateP >= (cfg.triage?.escalateThreshold ?? 0.75)) {
				hint += ` The escalation check agrees a consult now beats another local attempt (p=${escalateP.toFixed(2)}).`;
				lastEscalateTurn = turnIndex;
			}
			try {
				pi.sendUserMessage(hint, ctx.isIdle() ? undefined : { deliverAs: "steer" });
				hintSent = true;
				lastHintTurn = turnIndex;
				incidentHints.set(incidentKey, hintsSoFar + 1);
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
			escalateP,
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
			const judgeReady = resolveJudge(cfg.judge) !== undefined;
			const cadence = !judgeReady ? "" : wd.judgeEveryTurn !== false ? " · every-turn" : " · verify-only";
			ctx.ui.notify(
				[
					`watchdog: ${enabled && wd.enabled !== false ? "ON" : "OFF"}`,
					`judge: ${judgeStatus(cfg.judge, modelBaseUrl(ctx.model))}${cadence}`,
					`tier1 endpoint: ${wd.baseUrl ?? "(none)"}`,
					`hints: ${wd.sendHints !== false ? "on" : "off"}, cooldown ${wd.hintCooldownTurns ?? 4} turns`,
					`ring: ${ring.length} recent tool calls tracked`,
				].join("\n"),
				"info",
			);
		},
	});
}
