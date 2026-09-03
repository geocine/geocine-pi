// Spawn a separate `pi` process (optionally inside the docker jail) in JSON
// mode and collect its messages, tool calls, final text, and usage.
//
// Pattern vendored from pi's subagent example: `pi --mode json -p
// --no-session` emits NDJSON events; `message_end` carries full messages.

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

export interface PiProgress {
	/** What the child is currently producing. */
	phase: "thinking" | "answer" | "tool";
	/** Accumulated text of the current thinking/answer block, or the tool name. */
	text: string;
	/** 1-based turn currently streaming. */
	turn: number;
}

export interface PiRunOptions {
	cwd: string;
	provider?: string;
	model?: string;
	thinking?: string;
	/** Restrict tools, e.g. ["read", "grep", "find", "ls"]. */
	tools?: string[];
	prompt: string;
	/** Hard wall-clock cap. Default 10 minutes. */
	timeoutMs?: number;
	signal?: AbortSignal;
	/** Run inside the docker jail: cwd is mounted at /work. */
	docker?: { image: string; envKeys?: string[] };
	/** Streaming progress (thinking/answer deltas, tool starts), throttled. */
	onProgress?: (progress: PiProgress) => void;
}

export interface PiToolCall {
	name: string;
	args: Record<string, unknown>;
}

export interface PiRunResult {
	exitCode: number;
	finalText: string;
	toolCalls: PiToolCall[];
	turns: number;
	usage: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number };
	stderr: string;
	timedOut: boolean;
}

function piCliInvocation(piArgs: string[]): { command: string; args: string[] } {
	// Inside an extension, process.execPath is the runtime running pi itself;
	// argv[1] is the pi entry script when running from a source checkout.
	const currentScript = process.argv[1];
	if (currentScript && fs.existsSync(currentScript) && !currentScript.startsWith("/$bunfs/")) {
		const base = path.basename(process.execPath).toLowerCase();
		if (/^(node|bun)(\.exe)?$/.test(base)) {
			return { command: process.execPath, args: [currentScript, ...piArgs] };
		}
		return { command: process.execPath, args: piArgs };
	}
	return { command: process.platform === "win32" ? "pi.cmd" : "pi", args: piArgs };
}

export async function runPi(options: PiRunOptions): Promise<PiRunResult> {
	const piArgs: string[] = ["--mode", "json", "-p", "--no-session"];
	if (options.provider) piArgs.push("--provider", options.provider);
	if (options.model) piArgs.push("--model", options.model);
	if (options.thinking) piArgs.push("--thinking", options.thinking);
	if (options.tools && options.tools.length > 0) piArgs.push("--tools", options.tools.join(","));
	piArgs.push(options.prompt);

	let command: string;
	let args: string[];
	if (options.docker) {
		command = "docker";
		args = ["run", "--rm", "-v", `${options.cwd}:/work`, "-w", "/work"];
		for (const key of options.docker.envKeys ?? []) {
			if (process.env[key]) args.push("-e", `${key}=${process.env[key]}`);
		}
		args.push(options.docker.image, "pi", ...piArgs);
	} else {
		const invocation = piCliInvocation(piArgs);
		command = invocation.command;
		args = invocation.args;
	}

	const result: PiRunResult = {
		exitCode: -1,
		finalText: "",
		toolCalls: [],
		turns: 0,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
		stderr: "",
		timedOut: false,
	};

	await new Promise<void>((resolve) => {
		const proc = spawn(command, args, {
			cwd: options.docker ? undefined : options.cwd,
			shell: false,
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
		});

		const timeout = setTimeout(() => {
			result.timedOut = true;
			proc.kill();
		}, options.timeoutMs ?? 600_000);

		const onAbort = () => proc.kill();
		options.signal?.addEventListener("abort", onAbort, { once: true });

		let buffer = "";
		// Streaming state for onProgress: accumulate the current block's
		// deltas, throttle emits so the host TUI is not re-rendered per token.
		let streamText = "";
		let streamPhase: "thinking" | "answer" = "answer";
		let lastEmit = 0;
		const emitProgress = (phase: "thinking" | "answer" | "tool", text: string, force = false) => {
			if (!options.onProgress) return;
			const now = Date.now();
			if (!force && now - lastEmit < 250) return;
			lastEmit = now;
			options.onProgress({ phase, text, turn: result.turns + 1 });
		};
		const handleLine = (line: string) => {
			if (!line.trim()) return;
			let event: any;
			try {
				event = JSON.parse(line);
			} catch {
				return;
			}
			if (event.type === "message_update" && options.onProgress) {
				const ame = event.assistantMessageEvent;
				if (!ame) return;
				if (ame.type === "start") {
					streamText = "";
				} else if (ame.type === "thinking_delta") {
					if (streamPhase !== "thinking") {
						streamPhase = "thinking";
						streamText = "";
					}
					streamText += ame.delta ?? "";
					emitProgress("thinking", streamText);
				} else if (ame.type === "text_delta") {
					if (streamPhase !== "answer") {
						streamPhase = "answer";
						streamText = "";
					}
					streamText += ame.delta ?? "";
					emitProgress("answer", streamText);
				} else if (ame.type === "thinking_end" || ame.type === "text_end") {
					emitProgress(streamPhase, ame.content ?? streamText, true);
				} else if (ame.type === "toolcall_start") {
					emitProgress("tool", String(ame.toolName ?? "tool"), true);
				}
				return;
			}
			if (event.type !== "message_end" || !event.message) return;
			const msg = event.message;
			if (msg.role !== "assistant") return;
			result.turns++;
			for (const part of msg.content ?? []) {
				if (part.type === "text" && typeof part.text === "string") {
					result.finalText = part.text;
				} else if (part.type === "toolCall") {
					result.toolCalls.push({ name: part.name, args: part.arguments ?? {} });
				}
			}
			const usage = msg.usage;
			if (usage) {
				result.usage.input += usage.input || 0;
				result.usage.output += usage.output || 0;
				result.usage.cacheRead += usage.cacheRead || 0;
				result.usage.cacheWrite += usage.cacheWrite || 0;
				const cost = typeof usage.cost === "number" ? usage.cost : usage.cost?.total;
				if (typeof cost === "number") result.usage.cost += cost;
			}
		};

		proc.stdout.on("data", (chunk: Buffer) => {
			buffer += chunk.toString("utf8");
			let idx = buffer.indexOf("\n");
			while (idx !== -1) {
				handleLine(buffer.slice(0, idx));
				buffer = buffer.slice(idx + 1);
				idx = buffer.indexOf("\n");
			}
		});
		proc.stderr.on("data", (chunk: Buffer) => {
			if (result.stderr.length < 16_384) result.stderr += chunk.toString("utf8");
		});
		proc.on("error", (err) => {
			result.stderr += `\nspawn error: ${String(err)}`;
			clearTimeout(timeout);
			resolve();
		});
		proc.on("close", (code) => {
			if (buffer) handleLine(buffer);
			result.exitCode = code ?? -1;
			clearTimeout(timeout);
			options.signal?.removeEventListener("abort", onAbort);
			resolve();
		});
	});

	return result;
}

const REFUSAL_PATTERN =
	/\b(I (?:can(?:no|')t|cannot|won't|am (?:not able|unable)|'m (?:not able|unable)))\s+(?:help|assist|provide|comply|continue|analyze|do that)|against (?:my|our) (?:guidelines|policy|policies)|I must (?:decline|refuse)/i;

/** Heuristic refusal detector: refusal phrasing + little/no actual work. */
export function looksLikeRefusal(result: PiRunResult): boolean {
	if (!result.finalText) return false;
	if (result.toolCalls.length > 2) return false;
	return REFUSAL_PATTERN.test(result.finalText);
}
