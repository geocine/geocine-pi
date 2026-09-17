// advisor: evidence-triggered consultation of stronger models.
//
// The local model owns the transcript and the tool loop. When it (or you)
// needs a stronger opinion, the `consult` tool:
//   1. stages a curated snapshot into a temp dir (the context firewall —
//      the consultant can only read what was staged, so its input token
//      spend is capped by the staging decision);
//   2. optionally pre-screens the staged content with a local model for
//      guardrail false-positive risk (strict cloud consultants only);
//   3. runs the consultant as a separate `pi --mode json -p --no-session`
//      process — in the sentry-enforced staged dir, or in-place read-only
//      for lenient/local consultants;
//   4. returns ONE advisory note to the worker transcript;
//   5. logs every decision with decision-time features to the consult-log
//      (append-only JSONL) for future fine-tuning.
//
// Refusal hygiene (3R-Bench): the briefing is a single-shot framed request,
// and a refused consultation is never continued — retries start fresh.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	type ModelConfig,
	modelLabel,
	DEFAULT_LOCAL_PROVIDERS,
	defaultModelName,
	type GeocineConfig,
	loadConfig,
	logDir,
	resolveModel,
	shouldPrescreen,
	updateGlobalConfig,
} from "../lib/config.ts";
import {
	appendRecord,
	type ConsultRequestRecord,
	newCid,
	nowIso,
	type StagedFile,
} from "../lib/consult-log.ts";
import { choiceOf, DEFAULT_MIN_CONFIDENCE, judge, type JudgeQuestion, noulOf, scoreOf } from "../lib/judge/index.ts";
import { looksLikeRefusal, runPi, type PiProgress, type PiRunResult } from "../lib/pi-exec.ts";
import { richSelect, type SelectItem } from "../lib/rich-select.ts";

const READ_ONLY_TOOLS = ["read", "grep", "find", "ls"];
const MAX_STAGED_FILE_BYTES = 256 * 1024;
const PRESCREEN_DEFAULT_MAX_BYTES = 24 * 1024;

function mainModelId(ctx: ExtensionContext): string | undefined {
	const model = ctx.model as { provider?: string; id?: string } | undefined;
	return model ? `${model.provider}/${model.id}` : undefined;
}

// ---------- staging ----------

interface StagingResult {
	dir: string;
	files: StagedFile[];
	totalBytes: number;
	errors: string[];
}

/** Parse "path" or "path:12-80" into { file, start, end }. */
function parseFileSpec(spec: string): { file: string; start?: number; end?: number } {
	const m = /^(.*?):(\d+)-(\d+)$/.exec(spec);
	if (m && !fs.existsSync(spec)) {
		return { file: m[1], start: Number(m[2]), end: Number(m[3]) };
	}
	return { file: spec };
}

function stageFiles(cwd: string, specs: string[]): StagingResult {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "geocine-consult-"));
	const files: StagedFile[] = [];
	const errors: string[] = [];
	let totalBytes = 0;

	for (const spec of specs) {
		const { file, start, end } = parseFileSpec(spec);
		const abs = path.isAbsolute(file) ? file : path.join(cwd, file);
		try {
			let content = fs.readFileSync(abs, "utf8");
			let linesLabel: string | undefined;
			if (start !== undefined && end !== undefined) {
				const lines = content.split("\n");
				content = lines.slice(Math.max(0, start - 1), end).join("\n");
				linesLabel = `${start}-${end}`;
			}
			if (Buffer.byteLength(content, "utf8") > MAX_STAGED_FILE_BYTES) {
				content = content.slice(0, MAX_STAGED_FILE_BYTES);
				errors.push(`${spec}: truncated to ${MAX_STAGED_FILE_BYTES} bytes`);
			}
			// Preserve relative structure when inside cwd; flatten otherwise.
			const rel = path.relative(cwd, abs);
			const stagedRel =
				!rel.startsWith("..") && !path.isAbsolute(rel)
					? rel
					: path.basename(abs);
			const target = path.join(dir, stagedRel);
			fs.mkdirSync(path.dirname(target), { recursive: true });
			const body = linesLabel
				? `// [staged excerpt: lines ${linesLabel} of ${stagedRel}]\n${content}`
				: content;
			fs.writeFileSync(target, body, "utf8");
			const bytes = Buffer.byteLength(body, "utf8");
			totalBytes += bytes;
			files.push({ requested: spec, stagedAs: stagedRel.replace(/\\/g, "/"), bytes, lines: linesLabel });
		} catch (err) {
			errors.push(`${spec}: ${err instanceof Error ? err.message : String(err)}`);
		}
	}
	return { dir, files, totalBytes, errors };
}

// ---------- briefing ----------

function buildBriefing(params: {
	question: string;
	contextNote?: string;
	modelNotes?: string;
	stagedFiles?: StagedFile[];
	inPlaceFiles?: string[];
	reframe?: string;
	/** True when a staged jail ended up with zero files: pure Q&A, no workspace. */
	noWorkspace?: boolean;
}): string {
	const parts: string[] = [];
	parts.push(
		"You are a senior software consultant. A local coding agent working on a legitimate software project needs your analysis. This is a one-shot consultation: give your complete answer in a single response.",
	);
	if (params.modelNotes) parts.push(params.modelNotes);
	if (params.reframe) parts.push(`Context for this material: ${params.reframe}`);
	if (params.contextNote) parts.push(`Background from the local agent:\n${params.contextNote}`);
	if (params.stagedFiles && params.stagedFiles.length > 0) {
		const list = params.stagedFiles
			.map((f) => `- ${f.stagedAs}${f.lines ? ` (excerpt, lines ${f.lines})` : ""}`)
			.join("\n");
		parts.push(
			`Relevant sources are in your working directory (this is everything you need — there is nothing else to explore):\n${list}`,
		);
	}
	if (params.inPlaceFiles && params.inPlaceFiles.length > 0) {
		parts.push(
			`Start from these files (stay focused on them; do not explore broadly):\n${params.inPlaceFiles.map((f) => `- ${f}`).join("\n")}`,
		);
	}
	if (params.noWorkspace) {
		parts.push(
			"No files accompany this consultation — there is no workspace to inspect, so do not look for one or treat its absence as a problem. Answer from the QUESTION and background above. If specific files are essential to a confident answer, name the exact paths or content you need in your ADVICE so they can be staged in a follow-up.",
		);
	}
	parts.push(`QUESTION:\n${params.question}`);
	parts.push(
		[
			"Respond in exactly this format:",
			"SEVERITY: aside | concern | blocker",
			"ADVICE: your analysis and recommendation (concrete, reference files/lines)",
			"PLAN: numbered steps for the local agent, if action is needed (omit if not)",
		].join("\n"),
	);
	return parts.join("\n\n");
}

// ---------- pre-screen ----------

interface PrescreenVerdict {
	risk: "low" | "medium" | "high" | "unknown";
	triggers: string[];
	reframe?: string;
	raw: string;
	elapsedMs: number;
	screener: string;
}

/**
 * Trigger families screened as independent nouls — several may apply at
 * once, which is why these are not a single choice question.
 */
const PRESCREEN_TRIGGER_NOULS = [
	{
		id: "t_exploit",
		label: "exploit-like or offensive-security code",
		instructions: "Does `files` contain exploit-like or offensive-security code (shellcode, payloads, bypass tooling)?",
	},
	{
		id: "t_re",
		label: "reverse-engineering artifacts",
		instructions:
			"Does `files` contain reverse-engineering artifacts such as decompiled code, binary patches, or protection-bypass material?",
	},
	{
		id: "t_secrets",
		label: "credentials, keys, or personal data",
		instructions: "Does `files` contain credentials, API keys, tokens, or personal data?",
	},
	{
		id: "t_prose",
		label: "policy-sensitive prose",
		instructions: "Does `files` contain violent, sexual, extremist, or otherwise policy-sensitive prose?",
	},
];

/**
 * Fast prescreen via the System One classifier: one parallel call answers
 * the calibrated refusal-risk score plus every trigger noul. Returns
 * undefined (= fall through to the consultant screen) when no judge is
 * configured or the call fails.
 */
async function prescreenWithJudge(
	cfg: GeocineConfig,
	files: Array<{ file: string; content: string }>,
	question: string,
	signal: AbortSignal | undefined,
): Promise<PrescreenVerdict | undefined> {
	const questions: Record<string, JudgeQuestion> = {
		refusal_risk: {
			type: "score",
			instructions:
				"The `files` are legitimate local software-development content about to be sent to a strict cloud LLM together with `request`. How likely is that model to FALSELY refuse because the content superficially resembles unsafe material?",
			criteria: [
				"Benign — nothing resembles unsafe material; a refusal is very unlikely",
				"Some risky-looking surface (security tooling, RE artifacts, secrets); a false refusal is plausible",
				"Strongly resembles unsafe material; a strict model will likely refuse",
			],
		},
	};
	for (const t of PRESCREEN_TRIGGER_NOULS) {
		questions[t.id] = { type: "noul", instructions: t.instructions };
	}
	const result = await judge(cfg.judge, { state: { request: question, files }, questions }, { signal, node: "prescreen" });
	const risk = scoreOf(result, "refusal_risk");
	if (!result || !risk) return undefined;
	// Score is 0..2 over the three levels; thresholds are starting points —
	// tune against the prescreen records in the consult-log.
	const riskLevel: PrescreenVerdict["risk"] = risk.score >= 1.4 ? "high" : risk.score >= 0.7 ? "medium" : "low";
	const triggers = PRESCREEN_TRIGGER_NOULS.map((t) => ({ t, p: noulOf(result, t.id) }))
		.filter((x) => (x.p ?? 0) >= 0.5)
		.map((x) => `${x.t.label} (p=${(x.p as number).toFixed(2)})`);
	return {
		risk: riskLevel,
		triggers,
		// A System One model selects, it does not write — no reframe text.
		// The consultant path still produces one when it screens instead.
		raw: JSON.stringify(result.answers).slice(0, 2000),
		elapsedMs: result.elapsedMs,
		screener: `judge:${result.model}`,
	};
}

async function prescreen(
	cfg: GeocineConfig,
	cwd: string,
	staged: StagingResult,
	question: string,
	signal: AbortSignal | undefined,
): Promise<PrescreenVerdict> {
	const maxBytes = cfg.prescreen?.maxBytes ?? PRESCREEN_DEFAULT_MAX_BYTES;
	let budget = maxBytes;
	const files: Array<{ file: string; content: string }> = [];
	for (const f of staged.files) {
		if (budget <= 0) break;
		try {
			const content = fs.readFileSync(path.join(staged.dir, f.stagedAs), "utf8");
			const slice = content.slice(0, Math.min(content.length, budget));
			budget -= slice.length;
			files.push({ file: f.stagedAs, content: slice });
		} catch {
			// staged moments ago; ignore races
		}
	}

	// Judge screen first (fast, calibrated, typed); consultant LLM screen
	// as the fallback; "unknown" when neither is configured.
	const judged = await prescreenWithJudge(cfg, files, question, signal);
	if (judged) return judged;

	const screenerName = cfg.prescreen?.model;
	const resolved = screenerName ? resolveModel(cfg, screenerName) : undefined;
	if (!resolved || "error" in resolved) {
		return {
			risk: "unknown",
			triggers: [],
			raw: "no judge or prescreen model configured",
			elapsedMs: 0,
			screener: "none",
		};
	}
	const excerpts = files.map((f) => `=== ${f.file} ===\n${f.content}`);

	const prompt = [
		"You are screening content before it is sent to a strict cloud LLM with aggressive safety guardrails. The work itself is legitimate local software development, but strict models sometimes falsely refuse benign content that superficially resembles unsafe material (exploit-like code, decompiled binaries, credentials, malware artifacts, security tooling).",
		`The request that will accompany this content: ${question}`,
		"Content to screen:",
		excerpts.join("\n\n") || "(no staged files)",
		'Reply with ONLY a JSON object: {"risk":"low|medium|high","triggers":["specific phrases or files likely to cause a false refusal"],"reframe":"one sentence of benign context that should be prepended so the reviewer understands the legitimate purpose"}',
	].join("\n\n");

	const t0 = Date.now();
	const result = await runPi({
		cwd,
		provider: resolved.model.provider,
		model: resolved.model.model,
		tools: [],
		prompt,
		timeoutMs: 120_000,
		signal,
	});
	const elapsedMs = Date.now() - t0;

	let risk: PrescreenVerdict["risk"] = "unknown";
	let triggers: string[] = [];
	let reframe: string | undefined;
	const jsonMatch = /\{[\s\S]*\}/.exec(result.finalText);
	if (jsonMatch) {
		try {
			const parsed = JSON.parse(jsonMatch[0]);
			if (parsed.risk === "low" || parsed.risk === "medium" || parsed.risk === "high") risk = parsed.risk;
			if (Array.isArray(parsed.triggers)) triggers = parsed.triggers.map(String).slice(0, 10);
			if (typeof parsed.reframe === "string" && parsed.reframe) reframe = parsed.reframe;
		} catch {
			// keep unknown
		}
	}
	return { risk, triggers, reframe, raw: result.finalText.slice(0, 2000), elapsedMs, screener: resolved.name };
}

// ---------- rescuer selection + approval gate ----------

type Approval = NonNullable<ConsultRequestRecord["approval"]>;
type ChosenBy = NonNullable<ConsultRequestRecord["chosenBy"]>;

function rosterLine(name: string, c: ModelConfig, isDefault: boolean): string {
	const role = c.role ?? "general consultant";
	// Classes are the public handles; the map key appears only for
	// unclassed consultants (nothing else can address them).
	const handles = c.classes?.length ? c.classes.join(", ") : `@${name}`;
	return `${c.provider ?? "?"}/${c.model}${isDefault ? " (default)" : ""} {${handles}} — ${role}`;
}

/**
 * One-line-per-consultant roster, used in the tool description and dialogs.
 */
export function buildRoster(cfg: GeocineConfig): string {
	const defaultName = defaultModelName(cfg);
	return Object.entries(cfg.models)
		.map(([n, c]) => rosterLine(n, c, n === defaultName))
		.join("\n");
}

/**
 * Judge-assigned rescuer (the fabric's "route" node): when the model does
 * not name a class, the judge picks whose ROLE and classes fit the
 * question — weighing cost (free local consultants when their role covers
 * the need) and guardrail fit (strict cloud models falsely refuse
 * RE/exploit-adjacent content). Every consult is routed per task across
 * the whole roster. Falls back to the static default below minConfidence
 * or without a judge; the user still owns the final choice at the
 * approval gate.
 */
async function routeModel(
	cfg: GeocineConfig,
	question: string,
	contextNote: string | undefined,
	files: string[],
): Promise<string | undefined> {
	const pool = cfg.models;
	const names = Object.keys(pool);
	if (names.length < 2) return undefined;
	const locals = cfg.rescue?.localProviders ?? DEFAULT_LOCAL_PROVIDERS;
	const result = await judge(cfg.judge, {
		state: {
			question: question.slice(0, 1200),
			context: contextNote?.slice(0, 400) ?? "(none)",
			files,
			models: Object.fromEntries(
				Object.entries(pool).map(([n, c]) => [
					n,
					{
						role: c.role ?? "general consultant",
						classes: c.classes ?? [],
						model: `${c.provider ?? "?"}/${c.model}`,
						cost: locals.includes(c.provider ?? "") ? "free (local)" : "paid (frontier)",
						guardrails: c.prescreen
							? "strict — may falsely refuse sensitive content (RE, exploits, secrets)"
							: "permissive",
					},
				]),
			),
		},
		questions: {
			rescuer: {
				type: "choice",
				instructions:
					"Pick the model in `models` whose role and classes best fit `question` (with `context` and `files`). The standing goal is to spend as few LLM tokens as possible: choose the cheapest model whose capabilities cover the need (classes cheap/fast/local first), and pick intelligent/frontier only when the problem genuinely demands it. Avoid strict-guardrail models when the content looks likely to trigger a false refusal (reverse engineering, exploit-adjacent code, secrets, sensitive prose) — prefer an abliterated-class one there.",
				criteria: Object.fromEntries(names.map((n) => [n, pool[n].role ?? null])),
			},
		},
	}, { node: "route" });
	const pick = choiceOf(result, "rescuer");
	if (!pick || !pool[pick.choice]) return undefined;
	if (pick.confidence < (cfg.judge?.minConfidence ?? DEFAULT_MIN_CONFIDENCE)) return undefined;
	return pick.choice;
}

interface GateResult {
	approved: boolean;
	approval: Approval;
	/** The rescuer that will actually run (may differ from the proposal). */
	name: string;
	model: ModelConfig;
	chosenBy: ChosenBy;
	/** Confidence from the fabric's approve node, when it was consulted. */
	approveP?: number;
}

/**
 * The fabric's "approve?" node: is this consult clearly worth running
 * without interrupting the user? Judges the question's substance, the
 * staging discipline, and whether the chosen model's classes/cost fit the
 * need. Only ever answers approve-vs-ask — denial stays a human call, so
 * denial labels stay human labels.
 */
async function judgeApprove(
	cfg: GeocineConfig,
	proposedName: string,
	proposed: ModelConfig,
	proposedBy: "model" | "default" | "judge",
	question: string,
	files: string[],
): Promise<number | undefined> {
	const result = await judge(
		cfg.judge,
		{
			state: {
				question: question.slice(0, 600),
				model: proposedName,
				role: proposed.role ?? "general consultant",
				classes: proposed.classes ?? [],
				jail: proposed.jail ?? "staged",
				proposed_by: proposedBy,
				staged_files: files.slice(0, 20),
			},
			questions: {
				approve: {
					type: "noul",
					instructions:
						"The local worker wants to consult `model` (see `role`, `classes`) with `question`, staging `staged_files`. Should this run WITHOUT asking the user? Approve when the question is specific and substantive, the staged files are minimal and relevant, and the model's classes fit the need — cheap/local/fast consults need little justification, while frontier/intelligent-class ones must look genuinely beyond the local worker. When in doubt, ask.",
					criteria: {
						true: "Clearly justified and well-routed — run it without interrupting the user",
						false: "Doubtful: vague question, over-staging, or cost/class mismatch — ask the user",
					},
				},
			},
		},
		{ node: "approve", timeoutMs: 2500 },
	);
	return noulOf(result, "approve");
}

/**
 * Rescuer selection + permission gate for LLM-invoked consults.
 *
 * The local model proposes a rescuer by role (or the default applies); the
 * user approves it, overrides with a different consultant, or rejects.
 * Auto mode takes the proposal silently. The proposal-vs-final delta is
 * logged: a user override is a routing label ("wrong rescuer for this").
 */
async function gateConsult(
	cfg: GeocineConfig,
	ctx: ExtensionContext,
	proposedName: string,
	proposed: ModelConfig,
	proposedBy: "model" | "default" | "judge",
	question: string,
	files: string[],
): Promise<GateResult> {
	const take = (approval: Approval, chosenBy: ChosenBy): GateResult => ({
		approved: true,
		approval,
		name: proposedName,
		model: proposed,
		chosenBy,
	});
	if (proposed.autoApprove || cfg.approval?.consultTool === "auto") {
		return take("auto", "auto");
	}

	// Fabric approve node: confident yes skips the prompt; anything else
	// (unsure, no judge, rate-capped) falls through to the ask dialog.
	let approveP: number | undefined;
	if (cfg.approval?.consultTool === "judge") {
		approveP = await judgeApprove(cfg, proposedName, proposed, proposedBy, question, files);
		if (approveP !== undefined && approveP >= (cfg.approval?.approveThreshold ?? 0.85)) {
			if (ctx.hasUI) ctx.ui.notify(`consult auto-approved by judge (p=${approveP.toFixed(2)}): ${modelLabel(proposed)}`, "info");
			return { ...take("judge_auto", proposedBy), approveP };
		}
	}

	if (!ctx.hasUI) {
		// Headless/scripted runs were launched deliberately; don't block them.
		return take("headless", proposedBy);
	}

	const label = modelLabel(proposed);
	const items: SelectItem[] = [
		{
			value: "use",
			label: `Use ${label}`,
			description: proposed.role ?? (proposed.classes?.join(", ") || "general consultant"),
		},
		{ value: "pick", label: "Pick another", description: "override the proposal with a different rescuer" },
		{ value: "deny", label: "Deny", description: "no consultation — the local model keeps trying on its own" },
		{
			value: "always",
			label: `Always allow ${label}`,
			description: "persist: this model stops asking",
		},
		{ value: "auto", label: "Auto-approve all", description: "persist: consult tool calls never ask again" },
	];
	const proposedLabel =
		proposedBy === "model" ? " by the model" : proposedBy === "judge" ? " by the judge (role-routed)" : " (default)";
	const choice = await richSelect(
		ctx,
		`Consult approval — ${label} proposed${proposedLabel}`,
		items,
		{
			header: [
				`{${proposed.classes?.join(", ") || "unclassed"}} · jail ${proposed.jail ?? "staged"}${approveP !== undefined ? ` · judge unsure (p=${approveP.toFixed(2)})` : ""}`,
				`files: ${files.join(", ") || "(none)"}`,
				`q: ${question.slice(0, 200)}${question.length > 200 ? "…" : ""}`,
			],
		},
	);

	if (choice === "use") return take("user_yes", proposedBy);
	if (choice === "pick") {
		const pool = cfg.models;
		const defaultName = defaultModelName(cfg);
		const rosterItems: SelectItem[] = Object.entries(pool).map(([n, c]) => ({
			value: n,
			label: `${n === defaultName ? "* " : "  "}${modelLabel(c)}`,
			description: `${c.role ?? "general consultant"} — {${c.classes?.join(", ") || "unclassed"}} · ${c.jail ?? "staged"}`,
		}));
		const name = await richSelect(ctx, "Who should rescue this?", rosterItems);
		if (!name) return { ...take("user_no", proposedBy), approved: false, approval: "user_no" };
		return {
			approved: true,
			approval: "user_yes",
			name,
			model: pool[name],
			chosenBy: name === proposedName ? proposedBy : "user_override",
		};
	}
	if (choice === "always") {
		updateGlobalConfig((g) => {
			const existing = g.models?.[proposedName];
			if (existing) existing.autoApprove = true;
			else {
				g.models = g.models ?? {};
				g.models[proposedName] = { ...proposed, autoApprove: true };
			}
		});
		ctx.ui.notify(`${label} is now auto-approved (geocine.json).`, "info");
		return take("always_allow", proposedBy);
	}
	if (choice === "auto") {
		updateGlobalConfig((g) => {
			g.approval = { ...(g.approval ?? {}), consultTool: "auto" };
		});
		ctx.ui.notify("All consult tool calls are now auto-approved (geocine.json).", "info");
		return take("auto", proposedBy);
	}
	// "Deny" or dialog cancelled.
	return { ...take("user_no", proposedBy), approved: false, approval: "user_no" };
}

// ---------- consultation ----------

interface ConsultOutcome {
	note: string;
	refused: boolean;
	result: PiRunResult;
	staging?: StagingResult;
	jail: "staged" | "none";
}

async function consult(
	cfg: GeocineConfig,
	ctx: ExtensionContext,
	cid: string,
	source: "tool" | "command",
	modelName: string,
	model: ModelConfig,
	question: string,
	fileSpecs: string[],
	contextNote: string | undefined,
	signal: AbortSignal | undefined,
	notify: (msg: string) => void,
	approval: Approval,
	routing?: { proposedConsultant: string; chosenBy: ChosenBy; approveP?: number },
	onProgress?: (progress: PiProgress) => void,
): Promise<ConsultOutcome> {
	const dir = logDir(cfg);
	const cwd = ctx.cwd;
	const base = { cid, cwd, mainModel: mainModelId(ctx) };
	const jail = model.jail ?? "staged";

	appendRecord(dir, {
		type: "consult_request",
		...base,
		ts: nowIso(),
		consultant: modelName,
		source,
		question,
		files: fileSpecs,
		contextNote,
		approval,
		proposedConsultant: routing?.proposedConsultant,
		approveP: routing?.approveP,
		chosenBy: routing?.chosenBy,
	});

	// 1. Stage (context firewall) unless running in place.
	let staging: StagingResult | undefined;
	if (jail !== "none") {
		staging = stageFiles(cwd, fileSpecs);
		appendRecord(dir, {
			type: "staging",
			...base,
			ts: nowIso(),
			consultant: modelName,
			jail,
			files: staging.files,
			totalBytes: staging.totalBytes,
			briefingBytes: 0,
			errors: staging.errors,
		});
	}

	// A staged jail with zero files is pure Q&A: no workspace to inspect,
	// so no read tools either (an empty dir just confuses the consultant
	// into reviewing the absence of files instead of the question).
	const noWorkspace = staging !== undefined && staging.files.length === 0;

	// 2. Pre-screen when the consultant's flag asks for it. Nothing to
	// screen when no files were staged.
	let reframe: string | undefined;
	if (shouldPrescreen(model) && staging && !noWorkspace) {
		notify(`consult: pre-screening ${staging.files.length} staged file(s) locally…`);
		const verdict = await prescreen(cfg, cwd, staging, question, signal);
		appendRecord(dir, {
			type: "prescreen",
			...base,
			ts: nowIso(),
			consultant: modelName,
			screener: verdict.screener,
			risk: verdict.risk,
			triggers: verdict.triggers,
			reframe: verdict.reframe,
			rawResponse: verdict.raw,
			elapsedMs: verdict.elapsedMs,
		});
		if (verdict.risk === "high") {
			cleanupStaging(staging);
			// Suggest consultants this content CAN go to: jail "none" ones
			// never stage (so never screen), plus unscreened staged ones.
			const lenient = Object.entries(cfg.models)
				.filter(([n, c]) => n !== modelName && ((c.jail ?? "staged") === "none" || !shouldPrescreen(c)))
				.map(([n]) => n);
			return {
				note:
					`Consultation NOT sent: the local pre-screen judged this content HIGH risk for a false safety refusal by "${modelName}".\n` +
					`Likely triggers: ${verdict.triggers.join("; ") || "unspecified"}.\n` +
					`Use a lenient model instead${lenient.length ? ` (available: ${lenient.join(", ")})` : ""}, or reduce the staged content and retry.`,
				refused: false,
				result: emptyResult(),
				staging,
				jail,
			};
		}
		reframe = verdict.reframe;
	}

	// 3. Build briefing and run.
	const briefing = buildBriefing({
		question,
		contextNote,
		modelNotes: model.notes,
		stagedFiles: staging?.files,
		inPlaceFiles: jail === "none" ? fileSpecs : undefined,
		reframe,
		noWorkspace,
	});

	const runCwd = staging ? staging.dir : cwd;
	// Staged jails get the sentry: blocks + audits out-of-dir reads
	// (jail "none" is deliberately unrestricted).
	const auditFile = jail === "staged" && staging ? path.join(os.tmpdir(), `geocine-jail-${cid}.jsonl`) : undefined;
	notify(`consult: asking ${modelLabel(model)}…`);
	const result = await runPi({
		cwd: runCwd,
		provider: model.provider,
		model: model.model,
		thinking: model.thinking,
		tools: noWorkspace ? [] : READ_ONLY_TOOLS,
		prompt: briefing,
		timeoutMs: 900_000,
		signal,
		onProgress,
		jail: jail === "staged" && staging ? { root: staging.dir, auditFile } : undefined,
	});

	const refused = looksLikeRefusal(result);

	// Jail effectiveness: every sentry-blocked out-of-dir read is one audit
	// row. Zero rows = the jail held with nothing to block.
	let escapePaths: string[] = [];
	if (auditFile && fs.existsSync(auditFile)) {
		try {
			escapePaths = fs
				.readFileSync(auditFile, "utf8")
				.split("\n")
				.filter(Boolean)
				.map((line) => {
					try {
						return String((JSON.parse(line) as { path?: unknown }).path ?? "");
					} catch {
						return "";
					}
				})
				.filter(Boolean);
		} catch {
			// audit is best-effort evidence; enforcement already happened in the child
		}
		fs.rmSync(auditFile, { force: true });
	}

	// 4. Utilization: which staged files did the consultant actually open?
	const filesRead = new Set<string>();
	for (const call of result.toolCalls) {
		const p = call.args.path ?? call.args.file_path;
		if (typeof p === "string") filesRead.add(p.replace(/\\/g, "/").replace(/^\.\//, ""));
	}

	appendRecord(dir, {
		type: "consult_result",
		...base,
		ts: nowIso(),
		consultant: modelName,
		jail,
		exitCode: result.exitCode,
		refusalSuspected: refused,
		advice: result.finalText.slice(0, 8000),
		filesRead: [...filesRead],
		filesStaged: staging?.files.map((f) => f.stagedAs) ?? [],
		turns: result.turns,
		usage: result.usage,
		elapsedMs: 0,
		error: result.exitCode !== 0 ? result.stderr.slice(0, 2000) || `exit ${result.exitCode}` : undefined,
		escapeAttempts: auditFile ? escapePaths.length : undefined,
		escapePaths: escapePaths.length > 0 ? escapePaths.slice(0, 5) : undefined,
	});

	let note: string;
	if (result.exitCode !== 0 && !result.finalText) {
		note = `Consultation failed (exit ${result.exitCode}, timedOut=${result.timedOut}). stderr:\n${result.stderr.slice(0, 1500) || "(empty)"}`;
	} else if (refused) {
		note =
			`Model "${modelName}" appears to have REFUSED (guardrail false positive is likely — this exchange will not be continued).\n` +
			`Its reply:\n${result.finalText.slice(0, 1200)}\n\n` +
			`Options: retry with less/reframed content, or use a lenient model.`;
	} else {
		note = `[advisory from ${modelName}]\n${result.finalText}`;
	}
	if (escapePaths.length > 0) {
		note += `\n\n[jail] Sentry blocked ${escapePaths.length} read(s) outside the staged dir: ${escapePaths.slice(0, 3).join(", ")}${escapePaths.length > 3 ? ", …" : ""}. The advice above was produced without that content.`;
	}

	if (staging) cleanupStaging(staging);
	return { note, refused, result, staging, jail };
}

function emptyResult(): PiRunResult {
	return {
		exitCode: 0,
		finalText: "",
		toolCalls: [],
		turns: 0,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
		stderr: "",
		timedOut: false,
	};
}

function cleanupStaging(staging: StagingResult): void {
	try {
		fs.rmSync(staging.dir, { recursive: true, force: true });
	} catch {
		// temp dir cleanup is best-effort
	}
}

// ---------- extension ----------

export default function advisor(pi: ExtensionAPI) {
	// Roster snapshot for the tool description (global config; the local
	// model proposes a rescuer BY ROLE from this list).
	const rosterAtLoad = buildRoster(loadConfig());

	pi.registerTool({
		name: "consult",
		label: "Consult",
		description:
			"Ask a stronger model for advice when stuck, when a plan is needed for a hard task, or after repeated failed attempts. Stage ONLY the files needed to answer the question: the consulted model can read nothing else, and staged bytes are the cost of the call. Returns one advisory note.\n" +
			"Pick the model (by capability class) whose role fits the problem:\n" +
			(rosterAtLoad || "(no models configured)") +
			"\nThe active session mode may narrow this set; an unavailable name returns an error listing who is available.",
		promptSnippet: "Consult a stronger model with a question plus a minimal set of relevant files",
		promptGuidelines: [
			"Use consult after several failed attempts at the same problem, before trying the same approach again.",
			"When calling consult, stage the minimum files that let the consulted model answer — every staged byte costs tokens.",
			"Propose the model class that matches the problem (debugging vs planning vs sensitive content); the user confirms or overrides.",
		],
		parameters: Type.Object({
			question: Type.String({
				description: "The specific question. Include what was tried and what failed — the consulted model sees nothing else.",
			}),
			files: Type.Optional(
				Type.Array(Type.String(), {
					description: 'Files to stage, workspace-relative. Optional line slice: "src/foo.ts:40-120".',
				}),
			),
			context: Type.Optional(
				Type.String({ description: "Short background note: goal, constraints, what has been ruled out." }),
			),
			model: Type.Optional(
				Type.String({
					description:
						"Proposed rescuer as a capability class (frontier, cheap, fast, local, abliterated, intelligent — see the {braces} in the roster); it resolves to a model carrying that class. Omit to let the router assign one by role and cost.",
				}),
			),
		}),
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const cfg = loadConfig(ctx.cwd);
			// Routing: an explicit model proposal stands; otherwise the judge
			// assigns by role/cost/guardrail fit, and only then the static
			// default.
			let proposedBy: "model" | "default" | "judge" = params.model ? "model" : "default";
			let wanted = params.model;
			if (!wanted) {
				const routed = await routeModel(cfg, params.question, params.context, params.files ?? []);
				if (routed) {
					wanted = routed;
					proposedBy = "judge";
				}
			}
			const resolved = resolveModel(cfg, wanted);
			if ("error" in resolved) {
				return { content: [{ type: "text", text: resolved.error }], details: {} };
			}
			const cid = newCid();

			// Rescuer selection + permission gate: the user confirms,
			// overrides, or rejects the proposal.
			const gate = await gateConsult(
				cfg,
				ctx,
				resolved.name,
				resolved.model,
				proposedBy,
				params.question,
				params.files ?? [],
			);
			if (!gate.approved) {
				// A denied request is itself a training label: log it.
				appendRecord(logDir(cfg), {
					type: "consult_request",
					cid,
					ts: nowIso(),
					cwd: ctx.cwd,
					mainModel: mainModelId(ctx),
					consultant: resolved.name,
					source: "tool",
					question: params.question,
					files: params.files ?? [],
					contextNote: params.context,
					approval: "user_no",
					proposedConsultant: resolved.name,
					chosenBy: proposedBy,
				});
				return {
					content: [
						{
							type: "text",
							text: "The user DECLINED this consultation. Do not call consult again for this problem. Continue working on it yourself: re-read the failing output carefully, question your current assumption, and try a different approach.",
						},
					],
					details: { cid, consultant: resolved.name, denied: true },
				};
			}
			if (gate.name !== resolved.name) {
				ctx.ui.notify(`Rescuer overridden: ${modelLabel(resolved.model)} → ${modelLabel(gate.model)}`, "info");
			}

			// Stream the consultant's thinking/answer into the tool display
			// so the wait is observable instead of a spinner.
			const gateLabel = modelLabel(gate.model);
			const streamProgress = onUpdate
				? (p: PiProgress) => {
						const body =
							p.phase === "tool"
								? `→ using tool: ${p.text}`
								: p.text.length > 1500
									? `…${p.text.slice(-1500)}`
									: p.text;
						onUpdate({
							content: [{ type: "text", text: `[${gateLabel} · turn ${p.turn} · ${p.phase}]\n${body}` }],
							details: { cid, consultant: gate.name, streaming: true },
						});
					}
				: undefined;
			const outcome = await consult(
				cfg,
				ctx,
				cid,
				"tool",
				gate.name,
				gate.model,
				params.question,
				params.files ?? [],
				params.context,
				signal,
				(msg) => ctx.ui.setStatus("advisor", msg),
				gate.approval,
				{ proposedConsultant: resolved.name, chosenBy: gate.chosenBy, approveP: gate.approveP },
				streamProgress,
			);
			ctx.ui.setStatus("advisor", undefined);
			return {
				content: [{ type: "text", text: outcome.note }],
				details: {
					cid,
					consultant: gate.name,
					proposed: resolved.name,
					jail: outcome.jail,
					refused: outcome.refused,
					turns: outcome.result.turns,
				},
			};
		},
	});

	pi.registerCommand("consult", {
		description:
			'Consult a stronger model: /consult [@model|@class] [+file[:a-b] …] <question>. "+" tokens stage files for the consulted model (e.g. +docs/outline.md +src/foo.ts:40-120); without them a staged-jail model answers from the question alone.',
		handler: async (args, ctx) => {
			const raw = String(args ?? "").trim();
			if (!raw) {
				ctx.ui.notify("Usage: /consult [@model|@class] [+file[:a-b] …] <question>", "error");
				return;
			}
			let modelName: string | undefined;
			let question = raw;
			const at = /^@(\S+)\s+([\s\S]+)$/.exec(raw);
			if (at) {
				modelName = at[1];
				question = at[2];
			}
			// "+path" tokens anywhere in the question are file specs to stage.
			const fileSpecs: string[] = [];
			question = question
				.replace(/(^|\s)\+(\S+)/g, (_all, pre: string, spec: string) => {
					fileSpecs.push(spec);
					return pre ? " " : "";
				})
				.replace(/\s+/g, " ")
				.trim();
			if (!question) {
				ctx.ui.notify("Usage: /consult [@model|@class] [+file[:a-b] …] <question> — a question is required.", "error");
				return;
			}
			const cfg = loadConfig(ctx.cwd);
			const resolved = resolveModel(cfg, modelName);
			if ("error" in resolved) {
				ctx.ui.notify(resolved.error, "error");
				return;
			}
			const cid = newCid();
			const label = modelLabel(resolved.model);
			ctx.ui.notify(
				`Consulting ${label}${fileSpecs.length ? ` (staging ${fileSpecs.length} file(s))` : ""}…`,
				"info",
			);
			const outcome = await consult(
				cfg,
				ctx,
				cid,
				"command",
				resolved.name,
				resolved.model,
				question,
				fileSpecs,
				undefined,
				undefined,
				(msg) => ctx.ui.setStatus("advisor", msg),
				"user_command",
				undefined,
				// Stream the consultant's live thinking/answer into the footer.
				(p) => {
					const tail = p.text.replace(/\s+/g, " ").trim().slice(-90);
					ctx.ui.setStatus("advisor", `${label} · ${p.phase}${p.phase === "tool" ? ` ${p.text}` : `: …${tail}`}`);
				},
			);
			ctx.ui.setStatus("advisor", undefined);
			// Deliver the advisory into the worker transcript so the model sees it.
			pi.sendUserMessage(
				`Advisory note from ${label} (requested by the user):\n\n${outcome.note}`,
			);
		},
	});

	pi.registerCommand("models", {
		description: "List configured models and advisor status",
		handler: async (_args, ctx) => {
			const cfg = loadConfig(ctx.cwd);
			const names = Object.entries(cfg.models);
			if (names.length === 0) {
				ctx.ui.notify("No models configured. See geocine.example.json in the geocine-pi package.", "error");
				return;
			}
			const defaultName = defaultModelName(cfg);
			const lines = names.map(([name, c]) => {
				const flags = [
					c.jail ?? "staged",
					shouldPrescreen(c) ? "prescreen" : "direct",
					c.autoApprove ? "auto-approved" : "",
					name === defaultName ? "DEFAULT" : "",
				]
					.filter(Boolean)
					.join(", ");
				return `${modelLabel(c)} {${c.classes?.join(", ") || "unclassed"}} (${flags})${c.role ? ` — ${c.role}` : ""}`;
			});
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}
