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
//      process — in the staged dir, in a docker jail, or in-place read-only
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
	activeMode,
	type ConsultantConfig,
	type GeocineConfig,
	loadConfig,
	logDir,
	modeConsultants,
	resolveConsultant,
	resolveRescuer,
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
import { looksLikeRefusal, runPi, type PiProgress, type PiRunResult } from "../lib/pi-exec.ts";

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
	consultantNotes?: string;
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
	if (params.consultantNotes) parts.push(params.consultantNotes);
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

async function prescreen(
	cfg: GeocineConfig,
	cwd: string,
	staged: StagingResult,
	question: string,
	signal: AbortSignal | undefined,
): Promise<PrescreenVerdict> {
	const screenerName = cfg.prescreen?.consultant;
	const resolved = screenerName ? resolveConsultant(cfg, screenerName) : undefined;
	if (!resolved || "error" in resolved) {
		return { risk: "unknown", triggers: [], raw: "no prescreen consultant configured", elapsedMs: 0, screener: "none" };
	}
	const maxBytes = cfg.prescreen?.maxBytes ?? PRESCREEN_DEFAULT_MAX_BYTES;
	let budget = maxBytes;
	const excerpts: string[] = [];
	for (const f of staged.files) {
		if (budget <= 0) break;
		try {
			const content = fs.readFileSync(path.join(staged.dir, f.stagedAs), "utf8");
			const slice = content.slice(0, Math.min(content.length, budget));
			budget -= slice.length;
			excerpts.push(`=== ${f.stagedAs} ===\n${slice}`);
		} catch {
			// staged moments ago; ignore races
		}
	}

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
		provider: resolved.consultant.provider,
		model: resolved.consultant.model,
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

function rosterLine(name: string, c: ConsultantConfig, isDefault: boolean): string {
	const role = c.role ?? "general consultant";
	return `${name}${isDefault ? " (default)" : ""} — ${role} [${c.provider ?? "?"}/${c.model}]`;
}

/**
 * One-line-per-consultant roster, used in the tool description and dialogs.
 * Mode-filtered: only rescuers selectable under the active mode appear.
 */
export function buildRoster(cfg: GeocineConfig): string {
	const active = activeMode(cfg);
	const defaultName = active?.mode.defaultConsultant ?? cfg.defaultConsultant;
	return Object.entries(modeConsultants(cfg))
		.map(([n, c]) => rosterLine(n, c, n === defaultName))
		.join("\n");
}

interface GateResult {
	approved: boolean;
	approval: Approval;
	/** The rescuer that will actually run (may differ from the proposal). */
	name: string;
	consultant: ConsultantConfig;
	chosenBy: ChosenBy;
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
	proposed: ConsultantConfig,
	proposedBy: "model" | "default",
	question: string,
	files: string[],
): Promise<GateResult> {
	const take = (approval: Approval, chosenBy: ChosenBy): GateResult => ({
		approved: true,
		approval,
		name: proposedName,
		consultant: proposed,
		chosenBy,
	});
	if (proposed.autoApprove || cfg.approval?.consultTool === "auto") {
		return take("auto", "auto");
	}
	if (!ctx.hasUI) {
		// Headless/scripted runs were launched deliberately; don't block them.
		return take("headless", proposedBy);
	}

	const USE = `Use ${proposedName}${proposed.role ? ` — ${proposed.role}` : ""}`;
	const PICK = "Choose a different rescuer…";
	const NO = "No — deny (the local model should keep trying)";
	const ALWAYS = `Always allow "${proposedName}" (persist)`;
	const AUTO_ALL = "Auto-approve all consultants (persist)";
	const choice = await ctx.ui.select(
		`Rescuer proposed${proposedBy === "model" ? " by the model" : " (default)"}: ${proposedName} (${proposed.provider ?? "?"}/${proposed.model}, jail: ${proposed.jail ?? "staged"})\n` +
			`Files: ${files.join(", ") || "(none)"}\nQ: ${question.slice(0, 300)}`,
		[USE, PICK, NO, ALWAYS, AUTO_ALL],
	);

	if (choice === USE) return take("user_yes", proposedBy);
	if (choice === PICK) {
		const pool = modeConsultants(cfg);
		const names = Object.keys(pool);
		const labels = names.map((n) => rosterLine(n, pool[n], n === cfg.defaultConsultant));
		const picked = await ctx.ui.select("Who should rescue this?", labels);
		if (!picked) return { ...take("user_no", proposedBy), approved: false, approval: "user_no" };
		const name = names[labels.indexOf(picked)];
		return {
			approved: true,
			approval: "user_yes",
			name,
			consultant: pool[name],
			chosenBy: name === proposedName ? proposedBy : "user_override",
		};
	}
	if (choice === ALWAYS) {
		updateGlobalConfig((g) => {
			const existing = g.consultants?.[proposedName];
			if (existing) existing.autoApprove = true;
			else {
				g.consultants = g.consultants ?? {};
				g.consultants[proposedName] = { ...proposed, autoApprove: true };
			}
		});
		ctx.ui.notify(`"${proposedName}" is now auto-approved (geocine.json).`, "info");
		return take("always_allow", proposedBy);
	}
	if (choice === AUTO_ALL) {
		updateGlobalConfig((g) => {
			g.approval = { ...(g.approval ?? {}), consultTool: "auto" };
		});
		ctx.ui.notify("All consult tool calls are now auto-approved (geocine.json).", "info");
		return take("auto", proposedBy);
	}
	// "No" or dialog cancelled.
	return { ...take("user_no", proposedBy), approved: false, approval: "user_no" };
}

// ---------- consultation ----------

interface ConsultOutcome {
	note: string;
	refused: boolean;
	result: PiRunResult;
	staging?: StagingResult;
	jail: "staged" | "docker" | "none";
}

async function consult(
	cfg: GeocineConfig,
	ctx: ExtensionContext,
	cid: string,
	source: "tool" | "command",
	consultantName: string,
	consultant: ConsultantConfig,
	question: string,
	fileSpecs: string[],
	contextNote: string | undefined,
	signal: AbortSignal | undefined,
	notify: (msg: string) => void,
	approval: Approval,
	routing?: { proposedConsultant: string; chosenBy: ChosenBy },
	onProgress?: (progress: PiProgress) => void,
): Promise<ConsultOutcome> {
	const dir = logDir(cfg);
	const cwd = ctx.cwd;
	const base = { cid, cwd, mainModel: mainModelId(ctx) };
	const jail = consultant.jail ?? "staged";

	appendRecord(dir, {
		type: "consult_request",
		...base,
		ts: nowIso(),
		consultant: consultantName,
		source,
		question,
		files: fileSpecs,
		contextNote,
		approval,
		proposedConsultant: routing?.proposedConsultant,
		chosenBy: routing?.chosenBy,
		mode: activeMode(cfg)?.name,
	});

	// 1. Stage (context firewall) unless running in place.
	let staging: StagingResult | undefined;
	if (jail !== "none") {
		staging = stageFiles(cwd, fileSpecs);
		appendRecord(dir, {
			type: "staging",
			...base,
			ts: nowIso(),
			consultant: consultantName,
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

	// 2. Pre-screen. The active mode's policy wins ("force" screens every
	// staged consult, "skip" screens none); otherwise the per-consultant
	// flag decides. Nothing to screen when no files were staged.
	let reframe: string | undefined;
	if (shouldPrescreen(cfg, consultant) && staging && !noWorkspace) {
		notify(`consult: pre-screening ${staging.files.length} staged file(s) locally…`);
		const verdict = await prescreen(cfg, cwd, staging, question, signal);
		appendRecord(dir, {
			type: "prescreen",
			...base,
			ts: nowIso(),
			consultant: consultantName,
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
			const lenient = Object.entries(modeConsultants(cfg))
				.filter(([n, c]) => n !== consultantName && ((c.jail ?? "staged") === "none" || !shouldPrescreen(cfg, c)))
				.map(([n]) => n);
			return {
				note:
					`Consultation NOT sent: the local pre-screen judged this content HIGH risk for a false safety refusal by "${consultantName}".\n` +
					`Likely triggers: ${verdict.triggers.join("; ") || "unspecified"}.\n` +
					`Use a lenient consultant instead${lenient.length ? ` (available: ${lenient.join(", ")})` : ""}, or reduce the staged content and retry.`,
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
		consultantNotes: consultant.notes,
		stagedFiles: staging?.files,
		inPlaceFiles: jail === "none" ? fileSpecs : undefined,
		reframe,
		noWorkspace,
	});

	const runCwd = staging ? staging.dir : cwd;
	notify(`consult: asking ${consultantName} (${consultant.model})…`);
	const result = await runPi({
		cwd: runCwd,
		provider: consultant.provider,
		model: consultant.model,
		thinking: consultant.thinking,
		tools: noWorkspace ? [] : READ_ONLY_TOOLS,
		prompt: briefing,
		timeoutMs: 900_000,
		signal,
		onProgress,
		docker:
			jail === "docker"
				? { image: cfg.docker?.image ?? "geocine-consult", envKeys: consultant.envKeys }
				: undefined,
	});

	const refused = looksLikeRefusal(result);

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
		consultant: consultantName,
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
	});

	let note: string;
	if (result.exitCode !== 0 && !result.finalText) {
		note = `Consultation failed (exit ${result.exitCode}, timedOut=${result.timedOut}). stderr:\n${result.stderr.slice(0, 1500) || "(empty)"}`;
	} else if (refused) {
		note =
			`Consultant "${consultantName}" appears to have REFUSED (guardrail false positive is likely — this exchange will not be continued).\n` +
			`Its reply:\n${result.finalText.slice(0, 1200)}\n\n` +
			`Options: retry with less/reframed content, or use a lenient consultant.`;
	} else {
		note = `[advisory from ${consultantName}]\n${result.finalText}`;
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
			"Ask a stronger consultant model for advice when stuck, when a plan is needed for a hard task, or after repeated failed attempts. Stage ONLY the files needed to answer the question: the consultant can read nothing else, and staged bytes are the cost of the call. Returns one advisory note.\n" +
			"Pick the consultant whose role fits the problem:\n" +
			(rosterAtLoad || "(no consultants configured)") +
			"\nThe active session mode may narrow this set; an unavailable name returns an error listing who is available.",
		promptSnippet: "Consult a stronger model with a question plus a minimal set of relevant files",
		promptGuidelines: [
			"Use consult after several failed attempts at the same problem, before trying the same approach again.",
			"When calling consult, stage the minimum files that let the consultant answer — every staged byte costs tokens.",
			"Propose the consultant whose role matches the problem (debugging vs planning vs sensitive content); the user confirms or overrides.",
		],
		parameters: Type.Object({
			question: Type.String({
				description: "The specific question. Include what was tried and what failed — the consultant sees nothing else.",
			}),
			files: Type.Optional(
				Type.Array(Type.String(), {
					description: 'Files to stage, workspace-relative. Optional line slice: "src/foo.ts:40-120".',
				}),
			),
			context: Type.Optional(
				Type.String({ description: "Short background note: goal, constraints, what has been ruled out." }),
			),
			consultant: Type.Optional(
				Type.String({
					description:
						"Proposed rescuer: the consultant name whose role best fits this problem (see tool description). Omit for the default.",
				}),
			),
		}),
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const cfg = loadConfig(ctx.cwd);
			const resolved = resolveRescuer(cfg, params.consultant);
			if ("error" in resolved) {
				return { content: [{ type: "text", text: resolved.error }], details: {} };
			}
			const cid = newCid();

			// Rescuer selection + permission gate: the model proposed a
			// rescuer (or the default applies); the user confirms, overrides,
			// or rejects.
			const gate = await gateConsult(
				cfg,
				ctx,
				resolved.name,
				resolved.consultant,
				params.consultant ? "model" : "default",
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
					chosenBy: params.consultant ? "model" : "default",
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
				ctx.ui.notify(`Rescuer overridden: ${resolved.name} → ${gate.name}`, "info");
			}

			// Stream the consultant's thinking/answer into the tool display
			// so the wait is observable instead of a spinner.
			const streamProgress = onUpdate
				? (p: PiProgress) => {
						const body =
							p.phase === "tool"
								? `→ using tool: ${p.text}`
								: p.text.length > 1500
									? `…${p.text.slice(-1500)}`
									: p.text;
						onUpdate({
							content: [{ type: "text", text: `[${gate.name} · turn ${p.turn} · ${p.phase}]\n${body}` }],
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
				gate.consultant,
				params.question,
				params.files ?? [],
				params.context,
				signal,
				(msg) => ctx.ui.setStatus("advisor", msg),
				gate.approval,
				{ proposedConsultant: resolved.name, chosenBy: gate.chosenBy },
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
			'Consult a stronger model: /consult [@consultant] [+file[:a-b] …] <question>. "+" tokens stage files for the consultant (e.g. +docs/outline.md +src/foo.ts:40-120); without them a staged-jail consultant answers from the question alone.',
		handler: async (args, ctx) => {
			const raw = String(args ?? "").trim();
			if (!raw) {
				ctx.ui.notify("Usage: /consult [@consultant] [+file[:a-b] …] <question>", "error");
				return;
			}
			let consultantName: string | undefined;
			let question = raw;
			const at = /^@(\S+)\s+([\s\S]+)$/.exec(raw);
			if (at) {
				consultantName = at[1];
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
				ctx.ui.notify("Usage: /consult [@consultant] [+file[:a-b] …] <question> — a question is required.", "error");
				return;
			}
			const cfg = loadConfig(ctx.cwd);
			const resolved = resolveRescuer(cfg, consultantName);
			if ("error" in resolved) {
				ctx.ui.notify(resolved.error, "error");
				return;
			}
			const cid = newCid();
			ctx.ui.notify(
				`Consulting ${resolved.name}${fileSpecs.length ? ` (staging ${fileSpecs.length} file(s))` : ""}…`,
				"info",
			);
			const outcome = await consult(
				cfg,
				ctx,
				cid,
				"command",
				resolved.name,
				resolved.consultant,
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
					ctx.ui.setStatus("advisor", `${resolved.name} · ${p.phase}${p.phase === "tool" ? ` ${p.text}` : `: …${tail}`}`);
				},
			);
			ctx.ui.setStatus("advisor", undefined);
			// Deliver the advisory into the worker transcript so the model sees it.
			pi.sendUserMessage(
				`Advisory note from consultant "${resolved.name}" (requested by the user):\n\n${outcome.note}`,
			);
		},
	});

	pi.registerCommand("consultants", {
		description: "List configured consultants and advisor status",
		handler: async (_args, ctx) => {
			const cfg = loadConfig(ctx.cwd);
			const names = Object.entries(cfg.consultants);
			if (names.length === 0) {
				ctx.ui.notify("No consultants configured. See geocine.example.json in the geocine-pi package.", "error");
				return;
			}
			const active = activeMode(cfg);
			const pool = modeConsultants(cfg);
			const defaultName = active?.mode.defaultConsultant ?? cfg.defaultConsultant;
			const lines = names.map(([name, c]) => {
				const flags = [
					c.jail ?? "staged",
					shouldPrescreen(cfg, c) ? "prescreen" : "direct",
					c.autoApprove ? "auto-approved" : "",
					name === defaultName ? "DEFAULT" : "",
					active && !pool[name] ? `unavailable in mode "${active.name}"` : "",
				]
					.filter(Boolean)
					.join(", ");
				return `${name}: ${c.provider ?? "?"}/${c.model} (${flags})${c.role ? ` — ${c.role}` : ""}`;
			});
			if (active) {
				lines.unshift(
					`mode: ${active.name}${active.mode.description ? ` — ${active.mode.description}` : ""} (prescreen: ${active.mode.prescreen ?? "consultant"})`,
				);
			}
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}
