// ask-user: a native way for the model to ask the human a question.
//
// Why this exists: pi has no built-in user-question tool, so when a model
// decides it needs the user's input mid-run, it improvises. A real incident
// with the local Qwen fine-tune: it hallucinated an entire Claude Code
// plugin protocol from its training data — wrote an "ask-user" JSON config
// to %TEMP%\claudecode\ask-user\<invented-uuid>\, then ran a python script
// importing a nonexistent ask_user_tool module from a plugin cache path
// that has never existed on this machine. The impulse was right (grok's
// advisory told it to ask the user which topic order to keep); the outlet
// was memorized garbage. This tool gives the impulse a real outlet backed
// by pi's own select/input dialogs.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { richSelect, type SelectItem } from "../lib/rich-select.ts";

export default function askUser(pi: ExtensionAPI) {
	pi.registerTool({
		name: "ask_user",
		label: "Ask user",
		description:
			"Ask the human user ONE question and wait for the answer. Use it for decisions only the user can make: choosing between approaches, confirming a destructive or costly action, clarifying ambiguous requirements. Give `options` for a pick-one question; omit them for free text. This is the ONLY mechanism for asking the user something mid-run — never improvise file-based, plugin-based, or script-based prompting.",
		promptSnippet: "Ask the user one question (pick-one options or free text) and block until they answer",
		promptGuidelines: [
			"When advice or requirements hinge on a user decision, ask with ask_user instead of guessing or inventing an interaction mechanism.",
			"Keep ask_user questions self-contained: the user sees only the question and options, not your reasoning.",
		],
		parameters: Type.Object({
			question: Type.String({
				description: "The question. Short, specific, self-contained — the user sees nothing else.",
			}),
			options: Type.Optional(
				Type.Array(Type.String(), {
					description: "2-8 answer choices for a pick-one question. Omit for a free-text answer.",
				}),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!ctx.hasUI) {
				return {
					content: [
						{
							type: "text",
							text: "No interactive user is attached (headless run). Proceed with your best judgment and state the assumption you made.",
						},
					],
					details: { answered: false },
				};
			}
			const options = (params.options ?? []).map((o) => o.trim()).filter((o) => o.length > 0);
			let answer: string | undefined;
			if (options.length >= 2) {
				const items: SelectItem[] = [
					...options.slice(0, 8).map((o, i) => ({ value: `opt:${i}`, label: o, description: "" })),
					{ value: "other", label: "Type an answer", description: "none of these — write a free-text reply" },
				];
				const picked = await richSelect(ctx, "The model has a question", items, {
					header: [params.question],
					labelWidth: 24,
				});
				answer =
					picked === "other"
						? await ctx.ui.input(params.question)
						: picked?.startsWith("opt:")
							? options[Number(picked.slice(4))]
							: undefined;
			} else {
				answer = await ctx.ui.input(params.question);
			}
			if (answer === undefined || answer.trim() === "") {
				return {
					content: [
						{
							type: "text",
							text: "The user dismissed the question without answering. Do not re-ask the same question; proceed with your best judgment.",
						},
					],
					details: { answered: false },
				};
			}
			return {
				content: [{ type: "text", text: `User answered: ${answer}` }],
				details: { answered: true },
			};
		},
	});
}
