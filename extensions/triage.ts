// triage: judge-powered task routing at submission time.
//
// Every non-command user message is scored by the System One classifier
// (fire-and-forget — adds zero latency to the turn): a difficulty score
// for the local model and a route choice (local / plan-first / frontier),
// judged against the session stage — how many tokens are already invested
// (warm cache makes staying local cheap per turn; an early stage makes a
// handoff brief small and lossless).
//
// When the judge routes away from local with enough confidence, a one-line
// steer names the configured rescuer so the model reaches for the consult
// tool EARLY instead of burning turns first. The approval gate still owns
// the actual spend decision. Every verdict is logged as a TriageRecord —
// task -> route labels are exactly the data a future local router LoRA
// trains on.
//
// No judge configured (or triage.enabled false) = this extension does
// nothing. The mid-task counterpart — the escalate-now probability — rides
// the watchdog's every-turn judge call, not this file.

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { modelHandle, isLocalWorker, loadConfig, logDir, resolveModel } from "../lib/config.ts";
import { appendRecord, newCid, nowIso } from "../lib/consult-log.ts";
import { choiceOf, DEFAULT_MIN_CONFIDENCE, judge, resolveJudge, scoreOf } from "../lib/judge/index.ts";
import { buildRoster } from "./advisor.ts";

const ROUTES = ["local", "plan_first", "frontier"] as const;
type Route = (typeof ROUTES)[number];

export default function triage(pi: ExtensionAPI) {
	let turnIndex = 0;

	pi.on("session_start", async () => {
		turnIndex = 0;
	});

	pi.on("turn_end", async () => {
		turnIndex++;
	});

	pi.on("input", async (event, ctx) => {
		const text = typeof (event as { text?: unknown }).text === "string" ? (event as { text: string }).text : "";
		if (!text || text.startsWith("/")) return;
		const cfg = loadConfig(ctx.cwd);
		if (cfg.triage?.enabled === false) return;
		if (!resolveJudge(cfg.judge)) return;
		// Routing exists to help the cheap worker; a frontier main model
		// needs no steer toward what it already is.
		if (!isLocalWorker(ctx.model, cfg)) return;
		// Fire and forget: the verdict lands as a steer while turn 1 runs.
		void runTriage(text, ctx, cfg);
	});

	async function runTriage(
		text: string,
		ctx: ExtensionContext,
		cfg: ReturnType<typeof loadConfig>,
	): Promise<void> {
		const usage = ctx.getContextUsage();
		const model = ctx.model as { id?: string; contextWindow?: number } | undefined;
		const contextPct =
			usage?.tokens != null && model?.contextWindow ? Math.round((usage.tokens / model.contextWindow) * 100) : undefined;

		const result = await judge(cfg.judge, {
			state: {
				task: text.slice(0, 2000),
				local_model: model?.id ?? "a 27B-class local coding model",
				session_stage: {
					turn: turnIndex,
					context_tokens: usage?.tokens ?? 0,
					context_pct: contextPct ?? 0,
				},
				models: buildRoster(cfg),
			},
			questions: {
				difficulty: {
					type: "score",
					instructions: "How hard is `task` for `local_model`, a small local coding model?",
					criteria: [
						"Trivial — a small local model does this reliably in a few turns",
						"Moderate — the local model handles it with normal iteration",
						"Hard — the local model will likely struggle, loop, or need many attempts",
						"Beyond it — frontier-class reasoning is required for a correct result",
					],
				},
				route: {
					type: "choice",
					instructions:
						"Pick the best route for `task` given `session_stage`. Weigh the economics: staying local is cheap per turn while its cache is warm; an early stage (low `context_tokens`) makes a handoff brief small, while a heavily invested session loses state on handoff. `models` lists who is available.",
					criteria: {
						local: "The local model should just do it — escalation would not pay for itself",
						plan_first: "Worth one consult for a plan or diagnosis up front, then the local model executes the steps",
						frontier: "Hand the whole problem to a frontier-class model — local attempts would mostly burn time",
					},
				},
			},
		}, { node: "triage" });
		const route = choiceOf(result, "route");
		if (!result || !route || !ROUTES.includes(route.choice as Route)) return;
		const difficulty = scoreOf(result, "difficulty")?.score;

		const minConfidence = cfg.judge?.minConfidence ?? DEFAULT_MIN_CONFIDENCE;
		const rescuer = resolveModel(cfg);
		const rescuerName = "error" in rescuer ? undefined : rescuer.name;
		let hintSent = false;
		if (route.choice !== "local" && route.confidence >= minConfidence && rescuerName && !ctx.isIdle()) {
			const handle = modelHandle(cfg, rescuerName);
			const role = "error" in rescuer ? "" : rescuer.model.role ? ` (${rescuer.model.role})` : "";
			const conf = route.confidence.toFixed(2);
			const hint =
				route.choice === "frontier"
					? `[triage] This task looks beyond the local model (difficulty ${difficulty?.toFixed(1) ?? "?"}/3, confidence ${conf}). Consider the consult tool EARLY: stage the key files and hand the whole problem to the "${handle}" rescuer${role} instead of burning local turns first.`
					: `[triage] This task looks hard for the local model (difficulty ${difficulty?.toFixed(1) ?? "?"}/3, confidence ${conf}). Consider one consult up front: ask the "${handle}" rescuer${role} for a plan or diagnosis, then execute the steps locally.`;
			try {
				pi.sendUserMessage(hint, { deliverAs: "steer" });
				hintSent = true;
			} catch {
				// steer window closed; the log record still captures the verdict
			}
		}

		appendRecord(logDir(cfg), {
			type: "triage",
			cid: newCid(),
			ts: nowIso(),
			cwd: ctx.cwd,
			mainModel: model?.id,
			task: text.slice(0, 300),
			difficulty,
			route: route.choice as Route,
			confidence: route.confidence,
			contextTokens: usage?.tokens ?? undefined,
			turnIndex,
			rescuer: hintSent ? rescuerName : undefined,
			hintSent,
		});
	}
}
