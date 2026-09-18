// triage: judge-powered task routing at submission time.
//
// Every non-command user message is scored by the System One classifier:
// a difficulty score, a refusal-risk score (policy-sensitive or high-risk
// security work — ordinary decompile-to-understand stays aligned), and a
// route choice (local / plan-first /
// frontier), judged against the session stage — how many tokens are
// already invested (warm cache makes staying local cheap per turn; an
// early stage makes a handoff brief small and lossless).
//
// Two axes, independent:
//  - Hardness: a confident non-local route steers toward an early consult.
//    Fire-and-forget — the hint can land while turn 1 runs.
//  - Safety: a high refusal-risk score on a strict cheap worker hops to
//    an abliterated-class cheap worker BEFORE the turn runs. That opens a
//    thread lease: on each later user turn the judge chooses dwell (the
//    refusal-sensitive conversation continues) or return (the user moved
//    on), with uncertainty defaulting to dwell to avoid model/cache
//    ping-pong. A steer is useless here: aligned models refuse the task
//    and refuse to consult it away. The approval gate still owns frontier
//    spend.
//
// No judge configured (or triage.enabled false) = this extension does
// nothing. The mid-task counterpart — the escalate-now probability — rides
// the watchdog's every-turn judge call, not this file.

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	isAbliterated,
	isLocalWorker,
	loadConfig,
	logDir,
	modelHandle,
	modelLabel,
	orderAbliterated,
	resolveModel,
	type GeocineConfig,
} from "../lib/config.ts";
import { appendRecord, newCid, nowIso } from "../lib/consult-log.ts";
import {
	choiceOf,
	DEFAULT_MIN_CONFIDENCE,
	judge,
	modelBaseUrl,
	resolveJudge,
	scoreOf,
	type JudgeQuestion,
} from "../lib/judge/index.ts";
import { buildRoster } from "./advisor.ts";

const ROUTES = ["local", "plan_first", "frontier"] as const;
type Route = (typeof ROUTES)[number];
type SafetyAction = "hop" | "dwell" | "return";

/** Same cutoff as prescreen "high": score 0..2, 1.4 = strict model will refuse. */
const REFUSAL_HIGH = 1.4;

/** Current task/thread needs the abliterated route (watchdog skips frontier escalation). */
let lastRefusalHigh = false;

interface ModelRef {
	provider: string;
	id: string;
}

interface HopLease {
	from: ModelRef;
	to: ModelRef;
	rootTask: string;
	previousTask: string;
	previousAnswer?: string;
}

/** Temporary model lease; the next real user turn decides dwell or return. */
let activeHop: HopLease | undefined;

export function taskIsRefusalSensitive(): boolean {
	return lastRefusalHigh;
}

function sameModel(model: { provider?: string; id?: string } | undefined, ref: ModelRef): boolean {
	return model?.provider === ref.provider && model?.id === ref.id;
}

function currentHop(model: { provider?: string; id?: string } | undefined): HopLease | undefined {
	return activeHop && sameModel(model, activeHop.to) ? activeHop : undefined;
}

function dwell(hop: HopLease, task: string): void {
	hop.previousTask = task.slice(0, 2000);
	hop.previousAnswer = undefined;
	lastRefusalHigh = true;
}

function assistantText(message: { role?: string; content?: unknown }): string | undefined {
	if (message.role !== "assistant" || !Array.isArray(message.content)) return undefined;
	const text = message.content
		.map((block) => {
			const part = block as { type?: unknown; text?: unknown };
			return part.type === "text" && typeof part.text === "string" ? part.text : "";
		})
		.filter(Boolean)
		.join("\n")
		.trim();
	return text || undefined;
}

export default function triage(pi: ExtensionAPI) {
	let turnIndex = 0;

	pi.on("session_start", async () => {
		turnIndex = 0;
		lastRefusalHigh = false;
		activeHop = undefined;
	});

	pi.on("turn_end", async () => {
		turnIndex++;
	});

	// A manual picker change ends the lease. Internal hop selection fires
	// before activeHop is assigned, so it cannot clear the lease it creates.
	pi.on("model_select", async (event) => {
		if (!activeHop || sameModel(event.model, activeHop.to)) return;
		activeHop = undefined;
		lastRefusalHigh = false;
	});

	pi.on("message_end", async (event, ctx) => {
		const hop = currentHop(ctx.model);
		if (!hop) return;
		const text = assistantText(event.message);
		if (text) hop.previousAnswer = text.slice(0, 2000);
	});

	pi.on("input", async (event, ctx) => {
		const ev = event as { text?: unknown; source?: string; streamingBehavior?: string };
		const text = typeof ev.text === "string" ? ev.text : "";
		if (!text || text.startsWith("/")) return;
		if (ev.source === "extension") return;
		if (ev.streamingBehavior === "steer" || ev.streamingBehavior === "followUp") return;
		const cfg = loadConfig(ctx.cwd);
		if (cfg.triage?.enabled === false) return;
		let hop = currentHop(ctx.model);
		if (activeHop && !hop) {
			activeHop = undefined;
			lastRefusalHigh = false;
		}
		if (!resolveJudge(cfg.judge)) {
			if (hop) dwell(hop, text);
			return;
		}
		// Routing exists to help the cheap worker; a frontier main model
		// needs no steer toward what it already is. An active lease is
		// exempt because its next turn still needs a return decision.
		if (!hop && !isLocalWorker(ctx.model, cfg)) return;
		// Hop and return decisions must land before the turn. Otherwise the
		// hardness hint is fire-and-forget (zero added latency).
		if (hop || (!isAbliterated(ctx.model, cfg) && hasAbliterated(cfg))) {
			await runTriage(text, ctx, cfg, pi, turnIndex);
		} else {
			void runTriage(text, ctx, cfg, pi, turnIndex);
		}
	});
}

function hasAbliterated(cfg: GeocineConfig): boolean {
	return Object.values(cfg.models).some((c) => c.classes?.includes("abliterated"));
}

function abliteratedNames(cfg: GeocineConfig): string[] {
	const names = Object.keys(cfg.models).filter((n) => cfg.models[n].classes?.includes("abliterated"));
	return orderAbliterated(cfg.models, names);
}

async function hopAbliterated(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	cfg: GeocineConfig,
	task: string,
): Promise<string | undefined> {
	const fromModel = ctx.model as { provider?: string; id?: string } | undefined;
	if (!fromModel?.provider || !fromModel.id) return undefined;
	const from: ModelRef = { provider: fromModel.provider, id: fromModel.id };
	const skipped: string[] = [];
	for (const name of abliteratedNames(cfg)) {
		const c = cfg.models[name];
		if (!c.provider) {
			skipped.push(`${name}: no provider`);
			continue;
		}
		let found: ReturnType<typeof ctx.modelRegistry.find>;
		try {
			found = ctx.modelRegistry.find(c.provider, c.model);
		} catch {
			skipped.push(`${name}: catalogue lookup failed`);
			continue;
		}
		if (!found) {
			skipped.push(`${name}: not in pi catalogue`);
			continue;
		}
		let ok = false;
		try {
			ok = await pi.setModel(found);
		} catch {
			// Treat runtime auth/model failures like an unavailable candidate.
		}
		if (!ok) {
			skipped.push(`${name}: no auth`);
			continue;
		}
		activeHop = {
			from,
			to: { provider: found.provider, id: found.id },
			rootTask: task.slice(0, 2000),
			previousTask: task.slice(0, 2000),
		};
		const local = c.classes?.includes("local") ? "local " : "";
		const skipNote = skipped.length ? ` (skipped ${skipped.join("; ")})` : "";
		ctx.ui.notify(
			`[triage] High refusal risk — ${local}${modelLabel(c)} {abliterated}; TypeSafe will dwell or return as the thread changes${skipNote}`,
			"info",
		);
		return name;
	}
	if (skipped.length) {
		ctx.ui.notify(`triage: no abliterated model available (${skipped.join("; ")})`, "warning");
	}
	return undefined;
}

async function returnToOriginal(pi: ExtensionAPI, ctx: ExtensionContext): Promise<boolean> {
	const hop = activeHop;
	if (!hop) return false;
	const current = ctx.model as { provider?: string; id?: string } | undefined;
	if (!sameModel(current, hop.to)) {
		activeHop = undefined;
		lastRefusalHigh = false;
		return false;
	}
	let found: ReturnType<typeof ctx.modelRegistry.find>;
	try {
		found = ctx.modelRegistry.find(hop.from.provider, hop.from.id);
	} catch {
		found = undefined;
	}
	if (!found) {
		ctx.ui.notify(`triage: original model is no longer in the catalogue (${hop.from.provider}/${hop.from.id})`, "warning");
		return false;
	}
	let ok = false;
	try {
		ok = await pi.setModel(found);
	} catch {
		// Report the same concise failure for auth and runtime selection errors.
	}
	if (!ok) {
		ctx.ui.notify(`triage: could not restore ${hop.from.provider}/${hop.from.id}`, "warning");
		return false;
	}
	activeHop = undefined;
	lastRefusalHigh = false;
	ctx.ui.notify(`[triage] Conversation moved on — restored ${hop.from.provider}/${hop.from.id}`, "info");
	return true;
}

async function runTriage(
	text: string,
	ctx: ExtensionContext,
	cfg: GeocineConfig,
	pi: ExtensionAPI,
	turnIndex: number,
): Promise<void> {
	const usage = ctx.getContextUsage();
	const model = ctx.model as { id?: string; contextWindow?: number } | undefined;
	const hop = currentHop(ctx.model);
	const contextPct =
		usage?.tokens != null && model?.contextWindow ? Math.round((usage.tokens / model.contextWindow) * 100) : undefined;
	const questions: Record<string, JudgeQuestion> = {
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
		refusal_risk: {
			type: "score",
			instructions:
				"How likely is `local_model` (a safety-aligned model) to REFUSE `task` rather than do it? Read short or elliptical follow-ups in `model_lease` context when present: a refinement inherits the subject of the refusal-sensitive thread. Count NSFW/adult/sexual content (including captions of adult images) and blackhat-borderline work (exploit development, protection bypass, malware, unauthorized access, weaponized reverse engineering). Do NOT count ordinary reverse engineering: decompiling or disassembling to understand a binary, reading undocumented formats, or defensive security analysis — aligned models handle those. This is not hardness.",
			criteria: [
				"Benign — coding, research, or ordinary reverse engineering (understand a binary/format). A strict aligned model will answer",
				"Some policy-sensitive surface (adult/NSFW mention, secrets, security tooling that looks offensive); a refusal is plausible",
				"Strict model will likely refuse — explicit NSFW/adult, or blackhat-borderline work (exploit payloads, protection bypass, malware, unauthorized access). Send to an abliterated-class model",
			],
		},
		route: {
			type: "choice",
			instructions:
				"Pick the best HARDNESS route for `task` given `session_stage`. Ignore refusals here — `refusal_risk` covers that. Weigh the economics: staying local is cheap per turn while its cache is warm; an early stage (low `context_tokens`) makes a handoff brief small, while a heavily invested session loses state on handoff. `models` lists who is available.",
			criteria: {
				local: "The local model should just do it — escalation would not pay for itself",
				plan_first: "Worth one consult for a plan or diagnosis up front, then the local model executes the steps",
				frontier: "Hand the whole problem to a frontier-class model — local attempts would mostly burn time",
			},
		},
	};
	if (hop) {
		questions.hop_action = {
			type: "choice",
			instructions:
				"The session temporarily moved from `original_model` to `abliterated_model` for `root_task`. Decide from the conversation flow whether `task` should dwell on the abliterated model or return to the original model BEFORE this turn. Prefer dwell for direct follow-ups, revisions, continuations, pronouns/ellipsis that depend on the prior exchange, another refusal-sensitive request, or genuine ambiguity. Return only for a clearly new benign topic, explicit closure, or ordinary defensive/decompile-to-understand reverse engineering.",
			criteria: {
				dwell: "Continue the refusal-sensitive thread on the abliterated model; avoid model/cache ping-pong",
				return: "The user clearly moved to a benign independent task; restore the original picker model",
			},
		};
	}

	const result = await judge(
		cfg.judge,
		{
			state: {
				task: text.slice(0, 2000),
				local_model: hop?.from.id ?? model?.id ?? "a 27B-class local coding model",
				session_stage: {
					turn: turnIndex,
					context_tokens: usage?.tokens ?? 0,
					context_pct: contextPct ?? 0,
				},
				models: buildRoster(cfg),
				...(hop
					? {
							model_lease: {
								original_model: `${hop.from.provider}/${hop.from.id}`,
								abliterated_model: `${hop.to.provider}/${hop.to.id}`,
								root_task: hop.rootTask,
								previous_user_task: hop.previousTask,
								previous_assistant_answer: hop.previousAnswer ?? "",
							},
						}
					: {}),
			},
			questions,
		},
		{ node: "triage", workerBaseUrl: modelBaseUrl(ctx.model) },
	);
	if (!result) {
		if (hop) dwell(hop, text);
		return;
	}

	const route = choiceOf(result, "route");
	const difficulty = scoreOf(result, "difficulty")?.score;
	const refusal = scoreOf(result, "refusal_risk");
	const hopAction = hop ? choiceOf(result, "hop_action") : undefined;
	const minConfidence = cfg.judge?.minConfidence ?? DEFAULT_MIN_CONFIDENCE;
	const refusalHigh = (refusal?.score ?? 0) >= REFUSAL_HIGH && (refusal?.confidence ?? 0) >= minConfidence;

	let switchedTo: string | undefined;
	let safetyAction: SafetyAction | undefined;
	let safetyConfidence: number | undefined;
	if (hop) {
		const shouldReturn =
			!refusalHigh && hopAction?.choice === "return" && hopAction.confidence >= minConfidence;
		if (shouldReturn && (await returnToOriginal(pi, ctx))) {
			safetyAction = "return";
			safetyConfidence = hopAction.confidence;
		} else {
			dwell(hop, text);
			safetyAction = "dwell";
			safetyConfidence = hopAction?.confidence;
		}
	} else if (refusalHigh && !isAbliterated(ctx.model, cfg)) {
		switchedTo = await hopAbliterated(pi, ctx, cfg, text);
		if (switchedTo) {
			safetyAction = "hop";
			safetyConfidence = refusal?.confidence;
		}
	}
	lastRefusalHigh = safetyAction === "return" ? false : refusalHigh || safetyAction === "dwell";

	let hintSent = false;
	const routed = route && ROUTES.includes(route.choice as Route) ? (route.choice as Route) : undefined;
	// Do not steer a strict worker toward frontier/plan_first on a task
	// it will refuse — and do not steer frontier (also strict) after a hop.
	if (
		!lastRefusalHigh &&
		!switchedTo &&
		route &&
		routed &&
		routed !== "local" &&
		route.confidence >= minConfidence &&
		!ctx.isIdle()
	) {
		const rescuer = resolveModel(cfg);
		const rescuerName = "error" in rescuer ? undefined : rescuer.name;
		if (rescuerName) {
			const handle = modelHandle(cfg, rescuerName);
			const role = "error" in rescuer ? "" : rescuer.model.role ? ` (${rescuer.model.role})` : "";
			const conf = route.confidence.toFixed(2);
			const hint =
				routed === "frontier"
					? `[triage] This task looks beyond the local model (difficulty ${difficulty?.toFixed(1) ?? "?"}/3, confidence ${conf}). Consider the consult tool EARLY: stage the key files and hand the whole problem to the "${handle}" rescuer${role} instead of burning local turns first.`
					: `[triage] This task looks hard for the local model (difficulty ${difficulty?.toFixed(1) ?? "?"}/3, confidence ${conf}). Consider one consult up front: ask the "${handle}" rescuer${role} for a plan or diagnosis, then execute the steps locally.`;
			try {
				pi.sendUserMessage(hint, { deliverAs: "steer" });
				hintSent = true;
			} catch {
				// steer window closed; the log record still captures the verdict
			}
		}
	}

	if (!routed && switchedTo === undefined && difficulty === undefined) return;

	const rescuer = hintSent ? resolveModel(cfg) : undefined;
	appendRecord(logDir(cfg), {
		type: "triage",
		cid: newCid(),
		ts: nowIso(),
		cwd: ctx.cwd,
		mainModel: model?.id,
		task: text.slice(0, 300),
		difficulty,
		refusalRisk: refusal?.score,
		route: routed ?? "local",
		confidence: route?.confidence ?? refusal?.confidence ?? 0,
		contextTokens: usage?.tokens ?? undefined,
		turnIndex,
		rescuer: hintSent && rescuer && !("error" in rescuer) ? rescuer.name : undefined,
		hintSent,
		switchedTo,
		safetyAction,
		safetyConfidence,
	});
}
