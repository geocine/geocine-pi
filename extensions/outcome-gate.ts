// outcome-gate: judge the WORK PRODUCT when the agent settles.
//
// The watchdog judges the activity trace while the agent runs; this gate
// judges the outcome when it stops. Evidence in, typed decision out:
//
//              task, git diff, captured test/lint outputs,
//              trace, session stage
//                            |
//                          judge
//                            |
//            continue      stop       escalate
//               |                         |
//        nudge local on        suggest frontier consult
//
// Evidence is gathered, never regenerated: `git diff` is read directly
// (cheap), test/lint/build results are captured from tool outputs the
// agent already produced — the gate never runs a test suite itself.
//
// One call, many parallel questions (System One answers them together):
// wants_changes (intent anchor), done, next (continue/stop/escalate),
// revert, plus review flags — regression_risk, scope_creep,
// architectural_change, needs_more_tests — and needs_human, a safety
// override that suppresses nudges whenever a human decision point
// blocks, whatever the router said.
//
// The verdict is anchored on the STARTING intent: `task` is the last
// real user message (extension-injected nudges never re-anchor it), and
// wants_changes decides whether a missing diff is evidence of anything.
// Informational asks ("what do you think", "check what X provides") are
// complete when the answer is delivered — the gate never auto-runs on
// them, because a continue nudge would make the worker manufacture
// changes nobody asked for.
//
// Actions are conservative: "stop" and review flags only set a status
// line ("looks done — regression risk 0.8"). "continue"/"escalate" send
// at most gate.maxNudgesPerTask idle nudges per user task (a nudge
// starts a new local run), and the consult approval gate still owns any
// frontier spend. Every verdict is a GateRecord — task ->
// done/route/flag labels for the flywheel. No judge configured = the
// gate does nothing.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { modelHandle, isLocalWorker, loadConfig, logDir, resolveModel } from "../lib/config.ts";
import { appendRecord, newCid, nowIso } from "../lib/consult-log.ts";
import { choiceOf, DEFAULT_MIN_CONFIDENCE, judge, modelBaseUrl, noulOf, resolveJudge } from "../lib/judge/index.ts";

const execFileAsync = promisify(execFile);

const NEXT = ["continue", "stop", "escalate"] as const;
type Next = (typeof NEXT)[number];

/** Shell commands whose output counts as verification evidence. */
const CHECK_COMMAND = /\b(test|tests|pytest|vitest|jest|tsc|typecheck|eslint|ruff|flake8|mypy|lint|clippy|cargo\s+(check|test)|go\s+(test|vet)|build|check)\b/i;

const MAX_CHECKS = 4;
const CHECK_TAIL_CHARS = 1500;
/** Probability at which a review-flag question fires (advice, never a block). */
const FLAG_P = 0.7;

interface CheckResult {
	command: string;
	ok: boolean;
	output_tail: string;
}

function textOf(content: unknown): string {
	if (!Array.isArray(content)) return "";
	return content
		.map((b) => (b && typeof b === "object" && (b as { type?: string }).type === "text" ? String((b as { text?: unknown }).text ?? "") : ""))
		.join("\n");
}

async function git(cwd: string, args: string[], cap: number): Promise<string> {
	try {
		const { stdout } = await execFileAsync("git", args, { cwd, timeout: 5000, maxBuffer: 4 * 1024 * 1024 });
		const text = stdout.trim();
		// Diffs get truncated from the head; the stat/tail is the summary.
		return text.length > cap ? `${text.slice(0, cap)}\n... (truncated)` : text;
	} catch {
		return "";
	}
}

export default function outcomeGate(pi: ExtensionAPI) {
	let lastUserMessage = "";
	let lastAnswer = "";
	let turnsSinceInput = 0;
	let toolEventsSinceInput = 0;
	let lastGatedEvents = -1;
	let nudgesThisTask = 0;
	let checks: CheckResult[] = [];
	let ring: string[] = [];

	pi.on("session_start", async () => {
		lastUserMessage = "";
		lastAnswer = "";
		turnsSinceInput = 0;
		toolEventsSinceInput = 0;
		lastGatedEvents = -1;
		nudgesThisTask = 0;
		checks = [];
		ring = [];
	});

	// For informational tasks the answer IS the work product; without it the
	// gate cannot tell an answered question from an abandoned coding task.
	pi.on("message_end", async (event) => {
		const message = event.message as { role?: string; content?: unknown };
		if (message.role !== "assistant") return;
		const text = textOf(message.content);
		if (text.trim()) lastAnswer = text;
	});

	pi.on("input", async (event, ctx) => {
		const text = typeof (event as { text?: unknown }).text === "string" ? (event as { text: string }).text : "";
		if (!text || text.startsWith("/")) return;
		// Extension-injected messages (our own nudges, watchdog/triage hints)
		// are steering, not a new task. Treating them as the task re-anchored
		// the gate on its own nudge text and reset the nudge budget — an
		// unbounded continue loop on informational asks.
		if ((event as { source?: string }).source === "extension") return;
		lastUserMessage = text;
		turnsSinceInput = 0;
		toolEventsSinceInput = 0;
		lastGatedEvents = -1;
		nudgesThisTask = 0;
		checks = [];
		ctx.ui.setStatus("gate", undefined);
	});

	pi.on("turn_end", async () => {
		turnsSinceInput++;
	});

	pi.on("tool_result", async (event) => {
		toolEventsSinceInput++;
		const input = event.input as { command?: unknown } | undefined;
		const command = typeof input?.command === "string" ? input.command : "";
		const preview = command || `${event.toolName} ${JSON.stringify(event.input ?? {}).slice(0, 60)}`;
		ring.push(`${event.isError ? "FAIL" : "ok  "} ${preview.slice(0, 80)}`);
		if (ring.length > 16) ring.shift();
		// Capture verification evidence the agent already produced.
		if ((event.toolName === "bash" || event.toolName === "powershell") && command && CHECK_COMMAND.test(command)) {
			const text = textOf(event.content);
			checks.push({
				command: command.slice(0, 160),
				ok: !event.isError,
				output_tail: text.slice(-CHECK_TAIL_CHARS),
			});
			if (checks.length > MAX_CHECKS) checks.shift();
		}
	});

	pi.on("agent_settled", async (_event, ctx) => {
		const cfg = loadConfig(ctx.cwd);
		if (cfg.gate?.enabled === false) return;
		if (!resolveJudge(cfg.judge)) return;
		if (!lastUserMessage) return;
		// Nothing happened, or this settle was already gated (our own nudge
		// settling with no new work must not re-trigger).
		if (toolEventsSinceInput < 1 || toolEventsSinceInput === lastGatedEvents) return;
		lastGatedEvents = toolEventsSinceInput;

		const maxDiff = cfg.gate?.maxDiffChars ?? 8000;
		// HEAD variant covers staged + unstaged; empty in a repo with no
		// commits yet, where status --porcelain still carries the evidence.
		const [status, diffStat, diff] = await Promise.all([
			git(ctx.cwd, ["status", "--porcelain"], 2000),
			git(ctx.cwd, ["diff", "HEAD", "--stat"], 2000),
			git(ctx.cwd, ["diff", "HEAD", "--unified=1"], maxDiff),
		]);
		const usage = ctx.getContextUsage();

		const result = await judge(cfg.judge, {
			state: {
				task: lastUserMessage.slice(0, 1500),
				answer: lastAnswer ? lastAnswer.slice(-1500) : "(the agent gave no final answer)",
				git_changes: {
					status: status || "(clean or not a git repo)",
					diff_stat: diffStat || "(no uncommitted diff)",
					diff: diff || "(no uncommitted diff)",
				},
				checks: checks.length ? checks : "(the agent ran no test/lint/build commands)",
				trace: ring,
				session_stage: {
					turns: turnsSinceInput,
					context_tokens: usage?.tokens ?? 0,
				},
			},
			questions: {
				wants_changes: {
					type: "noul",
					instructions:
						"Read `task` as the user wrote it. Does it ask the agent to CHANGE something — fix, implement, add, refactor, configure? Or does it only ask to inspect, explain, review, assess, or answer? Judge the request itself, not what the agent did afterwards: an agent that made edits nobody asked for does not turn a question into a change request.",
					criteria: {
						true: "The task requests a modification — its outcome should be visible in the working tree",
						false: "The task is informational — a delivered answer completes it, no diff expected",
					},
				},
				done: {
					type: "noul",
					instructions:
						"The coding agent just stopped and implicitly claims `task` is handled. For an informational task, `answer` is the deliverable: a complete, on-point answer means done, and an empty diff is expected, not missing. For a change-requesting task, does the evidence (`git_changes`, `checks`, `trace`) show the change was made and verified? Only then does a missing diff or a failing check mean not done.",
					criteria: {
						true: "The deliverable exists — an on-point answer for informational tasks, or changes plus passing checks for change requests",
						false: "The deliverable is missing — no real answer, missing changes where expected, failing checks, or a trace that stopped mid-way",
					},
				},
				next: {
					type: "choice",
					instructions:
						"Who should act next on `task`? Weigh `session_stage`: more local turns are cheap (warm cache) when the gap is small; escalation pays when the remaining gap looks beyond the local model.",
					criteria: {
						continue: "Not finished, but the local model can close the gap — it should keep working now",
						stop: "Finished, or the next decision belongs to the user — no more automatic work",
						escalate: "A frontier-class model should review or take over what remains",
					},
				},
				revert: {
					type: "noul",
					instructions:
						"Is the working tree likely in a WORSE state than before this run — e.g. `checks` regressed from passing to failing while the diff kept growing? If yes, reverting to the last good state and re-approaching beats forward-fixing on top of broken changes.",
					criteria: {
						true: "Evidence of digging deeper — revert first, then re-approach",
						false: "Changes are progress (or there is no sign of regression) — keep them",
					},
				},
				regression_risk: {
					type: "noul",
					instructions:
						"Does the diff in `git_changes` risk breaking EXISTING behavior beyond what `task` asked for — edits to shared code paths, changed signatures or contracts, deleted branches — especially where `checks` show no coverage of the touched code?",
					criteria: {
						true: "Touches shared or load-bearing code with little or no verification of the old behavior",
						false: "Localized, additive, or well covered by the checks that ran",
					},
				},
				scope_creep: {
					type: "noul",
					instructions:
						"Does the diff in `git_changes` contain changes UNRELATED to `task` — refactors, renames, formatting sweeps, or features nobody asked for, mixed in with the requested change?",
					criteria: {
						true: "A meaningful part of the diff serves something other than the task",
						false: "The diff stays on task (mechanical fallout of the change is fine)",
					},
				},
				architectural_change: {
					type: "noul",
					instructions:
						"Does the diff change STRUCTURE rather than make a local fix — new modules or dependencies, changed public APIs or schemas, moved responsibilities between components?",
					criteria: {
						true: "Structural: future code will be shaped by this change",
						false: "Local: contained fix or addition inside existing structure",
					},
				},
				needs_more_tests: {
					type: "noul",
					instructions:
						"Given the diff and `checks`, is the change UNVERIFIED — behavior changed but no test exercising it was run or added, or only unrelated checks passed?",
					criteria: {
						true: "The changed behavior has no test evidence — verification is missing",
						false: "Checks that ran exercise the change, or the change cannot break behavior (docs, comments)",
					},
				},
				needs_human: {
					type: "noul",
					instructions:
						"Does what remains on `task` hinge on a decision only the USER can make — a product or design choice, a destructive or irreversible step, an ambiguous requirement the evidence cannot resolve?",
					criteria: {
						true: "A human decision point is blocking — automatic continuation would guess",
						false: "The remaining work is mechanical or clearly specified",
					},
				},
			},
		}, { node: "gate", workerBaseUrl: modelBaseUrl(ctx.model) });
		const next = choiceOf(result, "next");
		if (!result || !next || !NEXT.includes(next.choice as Next)) return;
		const wantsChangesP = noulOf(result, "wants_changes");
		const doneP = noulOf(result, "done");
		const revertP = noulOf(result, "revert");
		const regressionP = noulOf(result, "regression_risk");
		const scopeCreepP = noulOf(result, "scope_creep");
		const archP = noulOf(result, "architectural_change");
		const needsTestsP = noulOf(result, "needs_more_tests");
		const needsHumanP = noulOf(result, "needs_human");

		// Review flags: shown to the user, never blocking on their own.
		const flags = [
			regressionP !== undefined && regressionP >= FLAG_P ? `regression risk ${regressionP.toFixed(2)}` : "",
			scopeCreepP !== undefined && scopeCreepP >= FLAG_P ? `scope creep ${scopeCreepP.toFixed(2)}` : "",
			archP !== undefined && archP >= FLAG_P ? `architectural change ${archP.toFixed(2)}` : "",
			needsTestsP !== undefined && needsTestsP >= FLAG_P ? `unverified ${needsTestsP.toFixed(2)}` : "",
		].filter(Boolean);
		const flagSuffix = flags.length ? ` — ${flags.join(", ")}` : "";

		const minConfidence = cfg.judge?.minConfidence ?? DEFAULT_MIN_CONFIDENCE;
		const maxNudges = cfg.gate?.maxNudgesPerTask ?? 1;
		const failing = checks.filter((c) => !c.ok).map((c) => c.command);
		// Nudges spend main-model tokens (a nudge starts a new run), so
		// they require the cheap local worker. Expensive main models still
		// get the verdict — as a free status line.
		const localWorker = isLocalWorker(ctx.model, cfg);
		let nudged = false;

		// Intent anchor: an informational task ("what do you think", "can you
		// check what X provides") is complete when the answer is delivered.
		// Nudging "continue" past it makes the worker manufacture changes
		// nobody asked for, so the gate never auto-runs on such tasks.
		const informational = wantsChangesP !== undefined && wantsChangesP < 0.5;

		if (needsHumanP !== undefined && needsHumanP >= FLAG_P) {
			// Safety override: a human decision point blocks — never nudge
			// past it, whatever the router said.
			ctx.ui.setStatus("gate", `gate: needs your decision (p=${needsHumanP.toFixed(2)})${flagSuffix}`);
		} else if (informational && next.choice !== "stop") {
			ctx.ui.setStatus(
				"gate",
				`gate: informational task — answer delivered, no auto-run${doneP !== undefined ? ` (done p=${doneP.toFixed(2)})` : ""}${flagSuffix}`,
			);
		} else if (next.choice === "stop") {
			ctx.ui.setStatus(
				"gate",
				doneP !== undefined && doneP >= 0.6
					? `gate: looks done (p=${doneP.toFixed(2)})${flagSuffix}`
					: `gate: stopped — needs your review${doneP !== undefined ? ` (done p=${doneP.toFixed(2)})` : ""}${flagSuffix}`,
			);
		} else if (localWorker && next.confidence >= minConfidence && nudgesThisTask < maxNudges && ctx.isIdle()) {
			const evidence = [
				doneP !== undefined ? `done probability ${doneP.toFixed(2)}` : "",
				failing.length ? `failing checks: ${failing.join("; ")}` : "",
				!diffStat && !status ? "no working-tree changes" : "",
			]
				.filter(Boolean)
				.join(" · ");
			const revertAdvice =
				revertP !== undefined && revertP >= FLAG_P
					? ` The change history looks like digging deeper (revert probability ${revertP.toFixed(2)}) — consider reverting to the last good state (git stash or checkout) and re-approaching instead of fixing forward.`
					: "";
			const scopeAdvice =
				scopeCreepP !== undefined && scopeCreepP >= FLAG_P
					? ` The diff has drifted off-task (scope creep ${scopeCreepP.toFixed(2)}) — drop or revert the unrelated edits and keep only what the task needs.`
					: "";
			const testsAdvice =
				needsTestsP !== undefined && needsTestsP >= FLAG_P
					? ` The change is unverified (${needsTestsP.toFixed(2)}) — run or add a test that exercises it before calling it done.`
					: "";
			const archAdvice =
				archP !== undefined && archP >= FLAG_P
					? ` This is a structural change (${archP.toFixed(2)}), exactly what a stronger reviewer catches problems in.`
					: "";
			// "Re-run the failed checks" with zero failing checks invites the
			// model to invent gaps; only ask for what the evidence shows.
			const verify = failing.length
				? "then re-run the failed checks to verify"
				: "then verify the result before stopping";
			let nudge: string | undefined;
			if (next.choice === "continue") {
				nudge = `[outcome-gate] The evidence says the requested change is not finished (${evidence || "see the last checks"}).${revertAdvice}${scopeAdvice}${testsAdvice} Continue: close the remaining gap on what the user asked for — nothing beyond it — ${verify}.`;
			} else {
				const rescuer = resolveModel(cfg);
				const name = "error" in rescuer ? undefined : rescuer.name;
				const handle = name ? modelHandle(cfg, name) : undefined;
				const role = "error" in rescuer || !rescuer.model.role ? "" : ` (${rescuer.model.role})`;
				nudge = `[outcome-gate] The evidence says what remains is beyond a quick local fix (${evidence || "see the last checks"}).${archAdvice} Consider the consult tool${handle ? ` with the "${handle}" rescuer${role}` : ""}: stage the relevant files and ask for a review of the current diff.`;
			}
			try {
				pi.sendUserMessage(nudge);
				nudged = true;
				nudgesThisTask++;
				ctx.ui.setStatus("gate", `gate: ${next.choice} (confidence ${next.confidence.toFixed(2)})`);
			} catch {
				// session state changed; the record below still captures the verdict
			}
		} else {
			// No nudge (expensive main model, low confidence, cap reached,
			// or mid-run): the verdict still shows, for free.
			ctx.ui.setStatus("gate", `gate: ${next.choice} suggested (no auto-run)${flagSuffix}`);
		}

		appendRecord(logDir(cfg), {
			type: "gate",
			cid: newCid(),
			ts: nowIso(),
			cwd: ctx.cwd,
			mainModel: (ctx.model as { id?: string } | undefined)?.id,
			task: lastUserMessage.slice(0, 300),
			wantsChangesP,
			doneP,
			revertP,
			regressionP,
			scopeCreepP,
			archP,
			needsTestsP,
			needsHumanP,
			next: next.choice as Next,
			confidence: next.confidence,
			diffStat: diffStat.slice(-400) || undefined,
			checksSeen: checks.length,
			contextTokens: usage?.tokens ?? undefined,
			turns: turnsSinceInput,
			nudged,
		});
	});
}
