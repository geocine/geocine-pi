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
import { cacheSharingModels, offlineModels, type PiModelRegistry } from "../lib/availability.ts";
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
import { choiceOf, DEFAULT_MIN_CONFIDENCE, judge, type JudgeQuestion, modelBaseUrl, noulOf, sameOrigin, scoreOf } from "../lib/judge/index.ts";
import { looksLikeRefusal, runPi, type PiProgress, type PiRunResult } from "../lib/pi-exec.ts";
import { richSelect, type SelectItem } from "../lib/rich-select.ts";
import { startKeepAlive } from "../lib/keepalive.ts";
import { historySummary, routeHistoryState } from "../lib/route-history.ts";
import { taskIsRefusalSensitive } from "./triage.ts";
import { isConsultChild } from "../lib/consult-child.ts";

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
		label: "high-risk / protection-bypass security work",
		instructions:
			"Does `files` or `request` weaponize reverse engineering — protection/DRM bypass, license cracks, malware unpackers for deployment, unauthorized access? Ordinary decompiled code or disassembly to understand a program does not count.",
	},
	{
		id: "t_secrets",
		label: "credentials, keys, or personal data",
		instructions: "Does `files` contain credentials, API keys, tokens, or personal data?",
	},
	{
		id: "t_prose",
		label: "policy-sensitive prose or media",
		instructions:
			"Does `files` or `request` contain NSFW/adult/sexual content (including captions of adult images), or violent, extremist, or otherwise policy-sensitive prose?",
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
	workerBaseUrl: string | undefined,
): Promise<PrescreenVerdict | undefined> {
	const questions: Record<string, JudgeQuestion> = {
		refusal_risk: {
			type: "score",
			instructions:
				"The `files` plus `request` are about to be sent to a strict cloud LLM. How likely is that model to REFUSE? Count NSFW/adult/sexual content and blackhat-borderline work (exploit payloads, protection bypass, malware, unauthorized access). Do NOT count ordinary reverse engineering (decompile/disassemble to understand a binary) or defensive analysis — aligned models handle those.",
			criteria: [
				"Benign — coding, research, or ordinary reverse engineering; a refusal is very unlikely",
				"Some risky-looking surface (secrets, security tooling that looks offensive, adult/NSFW mention); a refusal is plausible",
				"Strict model will likely refuse — explicit NSFW/adult, or blackhat-borderline work (exploit payloads, protection bypass, malware)",
			],
		},
	};
	for (const t of PRESCREEN_TRIGGER_NOULS) {
		questions[t.id] = { type: "noul", instructions: t.instructions };
	}
	const result = await judge(cfg.judge, { state: { request: question, files }, questions }, { signal, node: "prescreen", workerBaseUrl });
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
	workerBaseUrl: string | undefined,
	registry: PiModelRegistry | undefined,
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
	const judged = await prescreenWithJudge(cfg, files, question, signal, workerBaseUrl);
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
	// A dead local screener would burn the full runPi timeout to answer
	// nothing — skip the model screen and let the consult proceed unscreened.
	const offline = await offlineModels({ [resolved.name]: resolved.model }, registry);
	const offlineReason = offline.get(resolved.name);
	if (offlineReason) {
		return {
			risk: "unknown",
			triggers: [],
			raw: `prescreen model "${resolved.name}" offline: ${offlineReason}`,
			elapsedMs: 0,
			screener: `offline:${resolved.name}`,
		};
	}
	// Same rule as the judge fallback tier: a side request on the worker's
	// single-slot server evicts its KV cache.
	let screenerBaseUrl: string | undefined;
	try {
		screenerBaseUrl = resolved.model.provider ? registry?.find(resolved.model.provider, resolved.model.model)?.baseUrl : undefined;
	} catch {
		screenerBaseUrl = undefined;
	}
	if (sameOrigin(screenerBaseUrl, workerBaseUrl)) {
		return {
			risk: "unknown",
			triggers: [],
			raw: `prescreen model "${resolved.name}" shares the worker's server (${screenerBaseUrl}); skipped to keep its cache warm`,
			elapsedMs: 0,
			screener: `skipped:${resolved.name}`,
		};
	}
	const excerpts = files.map((f) => `=== ${f.file} ===\n${f.content}`);

	const prompt = [
		"You are screening content before it is sent to a strict cloud LLM with aggressive safety guardrails. Strict models refuse NSFW/adult/sexual content and blackhat-borderline work (exploit payloads, protection bypass, malware). Ordinary reverse engineering — decompiling or disassembling to understand a binary — is fine and should score low.",
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

// ---------- full model list + pinned preferences ----------

/** Max pinned preferences kept (newest win). */
const MAX_PINS = 20;

interface CatalogModel {
	provider: string;
	id: string;
	input: string[];
	/** USD per million tokens; 0 often means "unknown" for custom providers. */
	cost: { input: number; output: number };
}

/** Every model pi's own picker offers (auth configured). */
function piCatalog(ctx: ExtensionContext): CatalogModel[] {
	try {
		return ctx.modelRegistry.getAvailable().map((m) => ({
			provider: String(m.provider),
			id: m.id,
			input: m.input ?? [],
			cost: { input: m.cost?.input ?? 0, output: m.cost?.output ?? 0 },
		}));
	} catch {
		return [];
	}
}

/** Providers that serve from this machine. */
const ON_MACHINE_PROVIDERS = ["llama.cpp", "lmstudio", "ollama"];
/** Price ceiling (USD per Mtok) for the derived "cheap" class. */
const CHEAP_MAX_INPUT = 0.5;
const CHEAP_MAX_OUTPUT = 2.5;

/**
 * Classes read from pi's catalog facts, never guessed: vision from the
 * input modalities, local from the provider, cheap from price (or a
 * configured budget provider). frontier/intelligent/abliterated aren't
 * derivable — an unclassified model stays aligned and staged until the
 * user adds them.
 */
function deriveClasses(cfg: GeocineConfig, m: CatalogModel): string[] {
	const classes: string[] = [];
	const local = ON_MACHINE_PROVIDERS.includes(m.provider);
	if (local) classes.push("local");
	const budgetProvider = (cfg.rescue?.localProviders ?? DEFAULT_LOCAL_PROVIDERS).includes(m.provider);
	const lowPrice = m.cost.input > 0 && m.cost.input <= CHEAP_MAX_INPUT && m.cost.output <= CHEAP_MAX_OUTPUT;
	if (local || budgetProvider || lowPrice) classes.push("cheap");
	if (m.input.includes("image")) classes.push("vision");
	return classes;
}

/** A model pi knows but geocine.json doesn't: derived classes, staged jail (safe default). */
function unregisteredConfig(cfg: GeocineConfig, m: CatalogModel): ModelConfig {
	const classes = deriveClasses(cfg, m);
	return { provider: m.provider, model: m.id, ...(classes.length ? { classes } : {}), jail: "staged" };
}

/**
 * Pi-catalog models not already in the registry, online only, keyed by
 * provider/id.
 */
async function unregisteredPool(cfg: GeocineConfig, ctx: ExtensionContext): Promise<Record<string, ModelConfig>> {
	const known = new Set(Object.values(cfg.models).map(modelLabel));
	const pool = Object.fromEntries(
		piCatalog(ctx)
			.filter((m) => !known.has(`${m.provider}/${m.id}`))
			.map((m) => [`${m.provider}/${m.id}`, unregisteredConfig(cfg, m)]),
	);
	const offline = await offlineModels(pool, ctx.modelRegistry);
	for (const name of offline.keys()) delete pool[name];
	return pool;
}

/**
 * Resolve a /consult target: a registry name or class first, then any
 * provider/model from pi's catalog (run unregistered, staged).
 */
async function resolveAnyModel(
	cfg: GeocineConfig,
	available: Record<string, ModelConfig>,
	offline: Map<string, string>,
	spec: string | undefined,
	ctx: ExtensionContext,
): Promise<{ name: string; model: ModelConfig } | { error: string }> {
	const resolved = resolveModel({ ...cfg, models: available }, spec);
	if (!("error" in resolved)) return resolved;
	const full = resolveModel(cfg, spec);
	if (!("error" in full)) return { error: `${full.name} is offline: ${offline.get(full.name) ?? "offline"}` };
	if (spec?.includes("/")) {
		const byLabel = Object.entries(cfg.models).find(([, c]) => modelLabel(c) === spec);
		if (byLabel) {
			return offline.has(byLabel[0])
				? { error: `${byLabel[0]} is offline: ${offline.get(byLabel[0])}` }
				: { name: byLabel[0], model: byLabel[1] };
		}
		const extra = (await unregisteredPool(cfg, ctx))[spec];
		if (extra) return { name: spec, model: extra };
	}
	return { error: `${resolved.error} — or any provider/model from pi's model list.` };
}

/** Registry key for a newly registered model: named after the model, provider/id on collision. */
function registryKeyFor(models: Record<string, ModelConfig>, provider: string, id: string): string {
	const short = id.split("/").pop() || id;
	return models[short] ? `${provider}/${id}` : short;
}

/** Pins whose model is in `pool`, resolved to current keys (identity survives a rename). */
function pinsForPool(cfg: GeocineConfig, pool: Record<string, ModelConfig>): Array<{ task: string; model: string }> {
	const out: Array<{ task: string; model: string }> = [];
	for (const p of cfg.routing?.pinned ?? []) {
		const key =
			pool[p.model] && (!p.id || modelLabel(pool[p.model]) === p.id)
				? p.model
				: Object.keys(pool).find((n) => p.id !== undefined && modelLabel(pool[n]) === p.id);
		if (key) out.push({ task: p.task, model: key });
	}
	return out.slice(-MAX_PINS);
}

/**
 * After a user override: keep this pick for tasks like this one? A pin
 * registers the model when needed (staged jail, role = the task) and
 * records a standing preference the route node matches against.
 */
async function offerPin(
	ctx: ExtensionContext,
	cfg: GeocineConfig,
	name: string,
	model: ModelConfig,
	registered: boolean,
	question: string,
): Promise<{ name: string; pinned: boolean }> {
	const label = modelLabel(model);
	const choice = await richSelect(
		ctx,
		`Use ${label} for tasks like this from now on?`,
		[
			{ value: "once", label: "Just this once", description: "run it now; routing stays as it was" },
			{
				value: "pin",
				label: "Yes, from now on",
				description: "save globally; proposed next time for this kind of task (you still approve)",
			},
		],
		{ header: [`q: ${question.slice(0, 200)}${question.length > 200 ? "…" : ""}`] },
	);
	if (choice !== "pin") return { name, pinned: false };
	const typed = await ctx.ui.input(
		"What kind of task is this? (Enter keeps the question)",
		"e.g. reviewing shader code, debugging Rust lifetimes",
	);
	if (typed === undefined) return { name, pinned: false }; // escape = don't pin
	const task = (typed.trim() || question).replace(/\s+/g, " ").slice(0, 200);
	let key = name;
	updateGlobalConfig((g) => {
		g.models = g.models ?? {};
		if (!registered) {
			key = registryKeyFor({ ...cfg.models, ...g.models }, model.provider ?? "?", model.model);
			g.models[key] = g.models[key] ?? { ...model, role: task };
		}
		const pins = (g.routing?.pinned ?? []).filter((p) => p.task.toLowerCase() !== task.toLowerCase());
		pins.push({ task, model: key, id: label, ts: nowIso() });
		g.routing = { ...(g.routing ?? {}), pinned: pins.slice(-MAX_PINS) };
	});
	ctx.ui.notify(
		registered
			? `Pinned ${label} for "${task}" (geocine.json → routing.pinned).`
			: `Pinned ${label} for "${task}" and registered it as "${key}" {${model.classes?.join(", ") || "unclassed"}} — role: ${task}. Edit its classes in geocine.json if they're off.`,
		"info",
	);
	return { name: key, pinned: true };
}

function rosterLine(name: string, c: ModelConfig, isDefault: boolean): string {
	const role = c.role ?? "general consultant";
	// Classes are the public handles; the map key appears only for
	// unclassed consultants (nothing else can address them).
	const handles = c.classes?.length ? c.classes.join(", ") : `@${name}`;
	const rank = c.rank !== undefined ? ` #${c.rank}` : "";
	return `${c.provider ?? "?"}/${c.model}${isDefault ? " (default)" : ""} {${handles}}${rank} — ${role}`;
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
 * the need) and guardrail fit (strict models may decline policy-sensitive
 * or high-risk security work; ordinary decompile-to-understand stays
 * aligned). Every consult is
 * routed per task across
 * the whole roster. Falls back to the static default below minConfidence
 * or without a judge; the user still owns the final choice at the
 * approval gate.
 */
async function routeModel(
	cfg: GeocineConfig,
	pool: Record<string, ModelConfig>,
	question: string,
	contextNote: string | undefined,
	files: string[],
	worker: string | undefined,
	workerBaseUrl: string | undefined,
): Promise<string | undefined> {
	const names = Object.keys(pool);
	if (names.length < 2) return undefined;
	const locals = cfg.rescue?.localProviders ?? DEFAULT_LOCAL_PROVIDERS;
	// Cost from the entry's own classes; the provider list only covers
	// unclassed entries.
	const isCheap = (c: ModelConfig) =>
		c.classes?.includes("cheap") || c.classes?.includes("local") || locals.includes(c.provider ?? "");
	// Routing memory: past outcomes per consultant (refusals, overrides,
	// denials) with a same-worker projection — see lib/route-history.ts.
	const history = routeHistoryState(cfg, pool, worker);
	// Standing user picks ("for tasks like X, use Y") — see offerPin.
	const pinned = pinsForPool(cfg, pool);
	const result = await judge(cfg.judge, {
		state: {
			question: question.slice(0, 1200),
			context: contextNote?.slice(0, 400) ?? "(none)",
			files,
			...(pinned.length ? { pinned } : {}),
			...(history ? { history } : {}),
			models: Object.fromEntries(
				Object.entries(pool).map(([n, c]) => [
					n,
					{
						role: c.role ?? "general consultant",
						classes: c.classes ?? [],
						model: `${c.provider ?? "?"}/${c.model}`,
						cost: isCheap(c) ? "cheap (free/budget)" : "paid (frontier)",
						guardrails: c.prescreen
							? "strict — may decline policy-sensitive or high-risk security work; ordinary decompile-to-understand is fine"
							: "permissive",
						...(c.rank !== undefined ? { rank: c.rank } : {}),
					},
				]),
			),
		},
		questions: {
			rescuer: {
				type: "choice",
				instructions:
					"Pick the model in `models` whose role and classes best fit `question` (with `context` and `files`). `pinned`, when present, lists standing user choices: if `question` is the same kind of task as a pinned `task`, pick that entry's `model` — it outranks cost, rank, and history — unless the model clearly lacks a capability the question needs or the content is refusal-prone for a strict model; a newer pin wins over an older conflicting one. Otherwise: the standing goal is to spend as few LLM tokens as possible: choose the cheapest model whose capabilities cover the need (classes cheap/fast/local first), and pick intelligent/frontier only when the problem genuinely demands it. Match capability tags to the question — e.g. a question about an image or screenshot needs a vision-classed model. Avoid strict-guardrail models when the content looks likely to trigger a refusal — NSFW/adult/sexual content (including image captions), or blackhat-borderline work (exploit payloads, protection bypass, malware, unauthorized access). Ordinary reverse engineering (decompile/disassemble to understand a binary, defensive analysis) stays on aligned models. Prefer an abliterated-class one only for the refusal cases; among those, prefer one also classed local over a hosted abliterated fallback. Weigh `history` when present — it is how past consults from this user actually went: prefer models the user picked over a proposal for similar tasks (`overridden_to`, `recent_user_choices`), avoid ones that refused, were overridden away, or were denied for similar work; counts under `same_worker` happened with the same `worker` model active as now and weigh more than the overall counts. `history.unexplored` lists models with no recorded outcomes yet: when the task is low-stakes (a quick review, summary, or second opinion — not critical debugging, not refusal-sensitive content) and an unexplored model's role and classes fit just as well, prefer it over an equally-fitting known model so its history can form; never pick an unexplored model when the stakes or a capability mismatch argue otherwise. When several fit equally, prefer the lower `rank` (1 = first choice).",
				criteria: Object.fromEntries(names.map((n) => [n, pool[n].role ?? null])),
			},
		},
	}, { node: "route", workerBaseUrl });
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
	/** "Something else": what the user wants the worker to do instead. */
	instead?: string;
	/** The user pinned this override for tasks like this one. */
	pinned?: boolean;
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
	workerBaseUrl: string | undefined,
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
		{ node: "approve", timeoutMs: 2500, workerBaseUrl },
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
	offline: Map<string, string>,
	/** Registered models that would evict the local worker's prompt cache. */
	sharing: Map<string, string>,
): Promise<GateResult> {
	// Whenever the approve node answered, its probability rides EVERY
	// outcome (including user yes/no): the pair is a calibration label.
	let approveP: number | undefined;
	const take = (approval: Approval, chosenBy: ChosenBy): GateResult => ({
		approved: true,
		approval,
		name: proposedName,
		model: proposed,
		chosenBy,
		approveP,
	});
	if (proposed.autoApprove || cfg.approval?.consultTool === "auto") {
		return take("auto", "auto");
	}

	// Fabric approve node: confident yes skips the prompt; anything else
	// (unsure, no judge, rate-capped) falls through to the ask dialog.
	if (cfg.approval?.consultTool === "judge") {
		approveP = await judgeApprove(cfg, proposedName, proposed, proposedBy, question, files, modelBaseUrl(ctx.model));
		if (approveP !== undefined && approveP >= (cfg.approval?.approveThreshold ?? 0.85)) {
			if (ctx.hasUI) ctx.ui.notify(`consult auto-approved by judge (p=${approveP.toFixed(2)}): ${modelLabel(proposed)}`, "info");
			return take("judge_auto", proposedBy);
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
		{ value: "pick", label: "Pick another", description: "override with any model from pi's model list" },
		{ value: "instead", label: "Something else…", description: "skip the consult — type what the model should do instead" },
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
	// Loop so backing out of a sub-step (picker, free-text box) returns
	// here instead of silently denying.
	for (;;) {
		const choice = await richSelect(
			ctx,
			`Consult approval — ${label} proposed${proposedLabel}`,
			items,
			{
				header: [
					`{${proposed.classes?.join(", ") || "unclassed"}} · jail ${proposed.jail ?? "staged"}${approveP !== undefined ? ` · judge unsure (p=${approveP.toFixed(2)})` : ""}`,
					`files: ${files.join(", ") || "(none)"}`,
					`q: ${question.slice(0, 200)}${question.length > 200 ? "…" : ""}`,
					...(sharing.has(proposedName) ? [`⚠ ${sharing.get(proposedName)}`] : []),
				],
			},
		);

		if (choice === "use") return take("user_yes", proposedBy);
		if (choice === "instead") {
			const text = await ctx.ui.input("What should the model do instead?", "e.g. read the full error log first, then try X");
			if (!text?.trim()) continue;
			return { ...take("user_instead", proposedBy), approved: false, approval: "user_instead", instead: text.trim() };
		}
		if (choice === "pick") {
			const pool = cfg.models;
			const defaultName = defaultModelName(cfg);
			// Registered rescuers first (with their roles), then everything
			// else pi's own model picker offers. Offline models are not
			// choices — a picked rescuer must be able to run.
			const extras = await unregisteredPool(cfg, ctx);
			const extrasSharing = await cacheSharingModels(extras, ctx.modelRegistry, modelBaseUrl(ctx.model));
			const evictTag = (why: string | undefined) => (why ? " · ⚠ evicts worker cache" : "");
			const rosterItems: SelectItem[] = [
				...Object.entries(pool)
					.filter(([n]) => !offline.has(n))
					.map(([n, c]) => ({
						value: n,
						label: `${n === defaultName ? "* " : "  "}${modelLabel(c)}`,
						description: `${c.role ?? "general consultant"} — {${c.classes?.join(", ") || "unclassed"}}${c.rank !== undefined ? ` #${c.rank}` : ""} · ${c.jail ?? "staged"}${evictTag(sharing.get(n))}`,
					})),
				...Object.keys(extras).map((n) => ({
					value: `pi:${n}`,
					label: `  ${n}`,
					description: `unregistered — {${extras[n].classes?.join(", ") || "unclassed"}} · staged${evictTag(extrasSharing.get(n))}`,
				})),
			];
			const picked = await richSelect(ctx, "Who should rescue this? (type to filter)", rosterItems, {
				header: offline.size > 0 ? [...offline].map(([n, why]) => `offline: ${n} — ${why}`) : undefined,
			});
			if (!picked) continue;
			const registered = !picked.startsWith("pi:");
			const name = registered ? picked : picked.slice(3);
			const model = registered ? pool[name] : extras[name];
			if (name === proposedName) return take("user_yes", proposedBy);
			const pin = await offerPin(ctx, cfg, name, model, registered, question);
			return {
				approved: true,
				approval: "user_yes",
				name: pin.name,
				model,
				chosenBy: "user_override",
				approveP,
				pinned: pin.pinned,
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
}

// ---------- jail resolution ----------

/** Max sensitive-content probability at which "auto" loosens to a live run. */
const JAIL_BLAND_MAX_P = 0.15;

interface JailDecision {
	jail: "staged" | "none";
	by: NonNullable<ConsultRequestRecord["jailBy"]>;
	sensitiveP?: number;
}

/**
 * Effective jail for one consult. Static "staged"/"none" stand as written
 * (absent = "staged"). "auto" resolves per consult, and the judge may only
 * ever LOOSEN the boundary — every uncertain path lands on "staged":
 *  1. an abliterated-class target is the model such work is FOR — it runs
 *     live, same as a static "none", even in a refusal-sensitive session;
 *  2. a refusal-sensitive session (active abliterated lease or a
 *     refusal-high task) stages deterministically — an aligned consultant
 *     must not see the live workspace of policy-sensitive work;
 *  3. everything else asks the fabric's jail node whether the consult
 *     carries content that should only leave in bounded excerpts;
 *     confidently bland (calibrated tier only — the naive-llm fallback may
 *     never loosen a boundary) runs live, anything else stages.
 */
async function resolveJail(
	cfg: GeocineConfig,
	model: ModelConfig,
	question: string,
	files: string[],
	workerBaseUrl: string | undefined,
	signal: AbortSignal | undefined,
): Promise<JailDecision> {
	const configured = model.jail ?? "staged";
	if (configured !== "auto") return { jail: configured, by: "static" };
	if (model.classes?.includes("abliterated")) return { jail: "none", by: "abliterated_target" };
	if (taskIsRefusalSensitive()) return { jail: "staged", by: "lease" };
	const result = await judge(
		cfg.judge,
		{
			state: {
				question: question.slice(0, 1200),
				files,
				consultant: {
					model: modelLabel(model),
					role: model.role ?? "general consultant",
					classes: model.classes ?? [],
				},
			},
			questions: {
				sensitive: {
					type: "noul",
					instructions:
						"The worker wants to consult `consultant`, a safety-aligned model. Decide the isolation boundary: must the consultant see ONLY explicitly staged excerpts (true), or is it safe to run it in the live workspace (false)? True when `question` or `files` suggest policy-sensitive, adult/NSFW, offensive-security, secret-bearing, or otherwise refusal-prone or private content. False when this is clearly ordinary software work — coding, debugging, planning, research.",
					criteria: {
						true: "Sensitive or doubtful — expose only the staged excerpts",
						false: "Clearly ordinary software work — the live workspace is safe to read",
					},
				},
			},
		},
		{ node: "jail", timeoutMs: 2500, workerBaseUrl, signal },
	);
	const p = noulOf(result, "sensitive");
	if (result?.calibrated && p !== undefined && p <= JAIL_BLAND_MAX_P) {
		return { jail: "none", by: "judge", sensitiveP: p };
	}
	return { jail: "staged", by: p === undefined ? "failsafe" : "judge", sensitiveP: p };
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
	routing?: {
		proposedConsultant?: string;
		proposedConsultantModel?: string;
		chosenBy?: ChosenBy;
		approveP?: number;
		offline?: Map<string, string>;
		pinned?: boolean;
	},
	onProgress?: (progress: PiProgress) => void,
): Promise<ConsultOutcome> {
	const dir = logDir(cfg);
	const cwd = ctx.cwd;
	const base = { cid, cwd, mainModel: mainModelId(ctx) };
	const decision = await resolveJail(cfg, model, question, fileSpecs, modelBaseUrl(ctx.model), signal);
	const jail = decision.jail;
	if ((model.jail ?? "staged") === "auto" && decision.by !== "abliterated_target") {
		notify(`consult: jail auto → ${jail} (${decision.by}${decision.sensitiveP !== undefined ? ` p=${decision.sensitiveP.toFixed(2)}` : ""})`);
	}

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
		proposedConsultantModel: routing?.proposedConsultantModel,
		approveP: routing?.approveP,
		chosenBy: routing?.chosenBy,
		pinned: routing?.pinned || undefined,
		offlineExcluded: routing?.offline?.size ? Object.fromEntries(routing.offline) : undefined,
		jail,
		jailBy: decision.by,
		jailSensitiveP: decision.sensitiveP,
		consultantModel: modelLabel(model),
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
		const verdict = await prescreen(cfg, cwd, staging, question, signal, modelBaseUrl(ctx.model), ctx.modelRegistry);
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
		consultantModel: modelLabel(model),
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

/**
 * Start the worker cache keep-alive; returns its stop function. Pings show
 * in the footer with the cached tokens the provider reported, so a miss
 * (0 cached) is visible instead of assumed away.
 */
function keepWorkerWarm(ctx: ExtensionContext): () => void {
	const ka = startKeepAlive(ctx, (s) => {
		const read = s.lastCacheRead ?? 0;
		ctx.ui.setStatus("keepalive", `keep-alive: ${s.pings} ping${s.pings === 1 ? "" : "s"} · cached ${read.toLocaleString()} tok${read ? "" : " (miss)"}`);
	});
	return () => {
		const s = ka.stop();
		ctx.ui.setStatus("keepalive", undefined);
		if (s.pings > 0) {
			ctx.ui.notify(`keep-alive: ${s.pings} ping${s.pings === 1 ? "" : "s"} kept the worker cache warm (last: ${(s.lastCacheRead ?? 0).toLocaleString()} cached tok)`, "info");
		}
	};
}

// ---------- extension ----------

export default function advisor(pi: ExtensionAPI) {
	// Inert inside a consult child: the brief is the only context it gets.
	if (isConsultChild()) return;
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
			// Availability first: offline models (llama.cpp server down, or
			// unknown to pi) are not consult candidates at all — the router
			// never sees them and a class resolves to an online carrier.
			const offline = await offlineModels(cfg.models, ctx.modelRegistry);
			const available = Object.fromEntries(Object.entries(cfg.models).filter(([n]) => !offline.has(n)));
			// Worker prompt cache: models on the local worker's own
			// single-slot server would evict it. Routing and class
			// resolution skip them; only an explicit name still reaches one.
			const sharing = await cacheSharingModels(available, ctx.modelRegistry, modelBaseUrl(ctx.model));
			const cacheSafe = Object.fromEntries(Object.entries(available).filter(([n]) => !sharing.has(n)));
			// Routing: an explicit model proposal stands; otherwise the judge
			// assigns by role/cost/guardrail fit, and only then the static
			// default.
			let proposedBy: "model" | "default" | "judge" = params.model ? "model" : "default";
			let wanted = params.model;
			if (!wanted) {
				const routed = await routeModel(cfg, cacheSafe, params.question, params.context, params.files ?? [], mainModelId(ctx), modelBaseUrl(ctx.model));
				if (routed) {
					wanted = routed;
					proposedBy = "judge";
				}
			}
			let resolved = resolveModel({ ...cfg, models: cacheSafe }, wanted);
			if ("error" in resolved) resolved = resolveModel({ ...cfg, models: available }, wanted);
			if ("error" in resolved) {
				// Distinguish "no such model" from "it exists but is offline".
				const full = resolveModel(cfg, wanted);
				if (!("error" in full)) {
					const why = offline.get(full.name) ?? "offline";
					return {
						content: [
							{
								type: "text",
								text: `The "${full.name}" model (${modelLabel(full.model)}) is offline: ${why}. Pick another model or class, or continue without consulting.`,
							},
						],
						details: {},
					};
				}
				return { content: [{ type: "text", text: resolved.error }], details: {} };
			}
			const cid = newCid();

			// Keep the worker's prompt cache warm while it waits (approval + consult).
			const stopWarm = keepWorkerWarm(ctx);
			try {
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
					offline,
					sharing,
				);
				if (gate.approved && ctx.hasUI) {
					const evicts = await cacheSharingModels({ [gate.name]: gate.model }, ctx.modelRegistry, modelBaseUrl(ctx.model));
					if (evicts.size) ctx.ui.notify(`consult: ${modelLabel(gate.model)} ${evicts.get(gate.name)}`, "warning");
				}
				if (!gate.approved) {
					// A denied request is itself a training label: log it.
					appendRecord(logDir(cfg), {
						type: "consult_request",
						cid,
						ts: nowIso(),
						cwd: ctx.cwd,
						mainModel: mainModelId(ctx),
						consultant: resolved.name,
						consultantModel: modelLabel(resolved.model),
						source: "tool",
						question: params.question,
						files: params.files ?? [],
						contextNote: params.context,
						approval: gate.approval,
						instead: gate.instead,
						approveP: gate.approveP,
						proposedConsultant: resolved.name,
						proposedConsultantModel: modelLabel(resolved.model),
						chosenBy: proposedBy,
						offlineExcluded: offline.size ? Object.fromEntries(offline) : undefined,
					});
					if (gate.instead) {
						return {
							content: [
								{
									type: "text",
									text: `The user skipped this consultation and wants you to do this instead:\n\n${gate.instead}\n\nFollow that direction. Do not call consult again for this problem unless the user asks.`,
								},
							],
							details: { cid, consultant: resolved.name, denied: true, instead: gate.instead },
						};
					}
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
					{
						proposedConsultant: resolved.name,
						proposedConsultantModel: modelLabel(resolved.model),
						chosenBy: gate.chosenBy,
						approveP: gate.approveP,
						offline,
						pinned: gate.pinned,
					},
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
			} finally {
				stopWarm();
			}
		},
	});

	pi.registerCommand("consult", {
		description:
			'Consult a stronger model: /consult [@model|@class|@provider/model] [+file[:a-b] …] <question>. @provider/model takes any model from pi\'s list (unregistered ones run staged). "+" tokens stage files for the consulted model (e.g. +docs/outline.md +src/foo.ts:40-120); without them a staged-jail model answers from the question alone.',
		handler: async (args, ctx) => {
			const raw = String(args ?? "").trim();
			if (!raw) {
				ctx.ui.notify("Usage: /consult [@model|@class|@provider/model] [+file[:a-b] …] <question>", "error");
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
				ctx.ui.notify("Usage: /consult [@model|@class|@provider/model] [+file[:a-b] …] <question> — a question is required.", "error");
				return;
			}
			const cfg = loadConfig(ctx.cwd);
			const offline = await offlineModels(cfg.models, ctx.modelRegistry);
			const available = Object.fromEntries(Object.entries(cfg.models).filter(([n]) => !offline.has(n)));
			// A registry name/class, or any provider/model from pi's list.
			const resolved = await resolveAnyModel(cfg, available, offline, modelName, ctx);
			if ("error" in resolved) {
				ctx.ui.notify(resolved.error, "error");
				return;
			}
			// You picked it, so it runs — but say what it costs the worker.
			const evicts = await cacheSharingModels({ [resolved.name]: resolved.model }, ctx.modelRegistry, modelBaseUrl(ctx.model));
			if (evicts.size) ctx.ui.notify(`${modelLabel(resolved.model)} ${evicts.get(resolved.name)}`, "warning");
			const cid = newCid();
			const label = modelLabel(resolved.model);
			ctx.ui.notify(
				`Consulting ${label}${fileSpecs.length ? ` (staging ${fileSpecs.length} file(s))` : ""}…`,
				"info",
			);
			const stopWarm = keepWorkerWarm(ctx);
			let outcome: ConsultOutcome;
			try {
				outcome = await consult(
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
					{ offline },
					// Stream the consultant's live thinking/answer into the footer.
					(p) => {
						const tail = p.text.replace(/\s+/g, " ").trim().slice(-90);
						ctx.ui.setStatus("advisor", `${label} · ${p.phase}${p.phase === "tool" ? ` ${p.text}` : `: …${tail}`}`);
					},
				);
				ctx.ui.setStatus("advisor", undefined);
			} finally {
				stopWarm();
			}
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
			const offline = await offlineModels(cfg.models, ctx.modelRegistry);
			const lines = names.map(([name, c]) => {
				const flags = [
					c.rank !== undefined ? `rank ${c.rank}` : "",
					c.jail ?? "staged",
					shouldPrescreen(c) ? "prescreen" : "direct",
					c.autoApprove ? "auto-approved" : "",
					name === defaultName ? "DEFAULT" : "",
				]
					.filter(Boolean)
					.join(", ");
				const off = offline.has(name) ? ` — OFFLINE: ${offline.get(name)}` : "";
				// What the router remembers about this consultant (route-history).
				const hist = historySummary(cfg, name);
				return `${modelLabel(c)} {${c.classes?.join(", ") || "unclassed"}} (${flags})${c.role ? ` — ${c.role}` : ""}${off}${hist ? `\n  history: ${hist}` : ""}`;
			});
			const pins = pinsForPool(cfg, cfg.models);
			if (pins.length) {
				lines.push("", "pinned (geocine.json → routing.pinned):");
				for (const p of pins) lines.push(`  "${p.task}" → ${modelLabel(cfg.models[p.model])}`);
			}
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}
