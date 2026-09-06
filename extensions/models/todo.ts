// todo: canonical plan/checklist tool. All three trained scaffolds have one
// (qwen-code todo_write, grok-build todo_write, codex update_plan) and pi has
// none, so models keep reaching for a tool that does not exist. This is the
// shared implementation; each harness aliases it to its trained name/schema.
//
// Semantics follow the originals: the call REPLACES the whole list unless
// merge=true (grok dialect), items carry id/content/status, and the result
// echoes the rendered list so the model sees the state it just wrote. The
// list is persisted as a custom session entry and rehydrated on session
// start, so it survives restarts and compactions.

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export interface TodoItem {
	id: string;
	content: string;
	status: "pending" | "in_progress" | "completed" | "cancelled";
}

const ENTRY_TYPE = "geocine-todos";
let todos: TodoItem[] = [];

const MARKS: Record<TodoItem["status"], string> = {
	pending: "[ ]",
	in_progress: "[~]",
	completed: "[x]",
	cancelled: "[-]",
};

function render(): string {
	if (todos.length === 0) return "Todo list is empty.";
	const lines = todos.map((t) => `${MARKS[t.status]} ${t.content}`);
	const open = todos.filter((t) => t.status === "pending" || t.status === "in_progress").length;
	return `${lines.join("\n")}\n(${open} open / ${todos.length} total)`;
}

/** Rebuild the list from the last persisted entry (called on session_start). */
export function rehydrateTodos(ctx: ExtensionContext): void {
	todos = [];
	for (const entry of ctx.sessionManager.getEntries()) {
		const e = entry as { type?: string; customType?: string; data?: { todos?: TodoItem[] } };
		if (e.type === "custom" && e.customType === ENTRY_TYPE && Array.isArray(e.data?.todos)) {
			todos = e.data.todos;
		}
	}
}

export function registerTodoTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "todo",
		label: "todo",
		description:
			"Maintain the task list for the current session. By default the call REPLACES the entire list, so include every item you want to keep (merge=true updates matching ids instead). Use it to plan multi-step work and mark exactly one item in_progress at a time.",
		parameters: Type.Object({
			todos: Type.Array(
				Type.Object({
					id: Type.Optional(Type.String({ description: "Stable identifier (defaults to the list position)" })),
					content: Type.String({ description: "The task description" }),
					status: Type.Optional(
						Type.Union(
							[
								Type.Literal("pending"),
								Type.Literal("in_progress"),
								Type.Literal("completed"),
								Type.Literal("cancelled"),
							],
							{ description: "Task state (default pending)" },
						),
					),
				}),
				{ description: "The full task list (or, with merge=true, the items to update)" },
			),
			merge: Type.Optional(
				Type.Boolean({ description: "Merge into the existing list by id instead of replacing it. Default false." }),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const incoming: TodoItem[] = params.todos.map((t, i) => ({
				id: t.id && t.id.trim() !== "" ? t.id : String(i + 1),
				content: t.content,
				status: t.status ?? "pending",
			}));
			if (params.merge) {
				for (const item of incoming) {
					const existing = todos.findIndex((t) => t.id === item.id);
					if (existing >= 0) todos[existing] = item;
					else todos.push(item);
				}
			} else {
				todos = incoming;
			}
			pi.appendEntry(ENTRY_TYPE, { todos });
			const open = todos.filter((t) => t.status === "pending" || t.status === "in_progress").length;
			if (ctx.ui?.setStatus) {
				ctx.ui.setStatus("geocine-todos", open > 0 ? `todos ${todos.length - open}/${todos.length}` : undefined);
			}
			return {
				content: [{ type: "text", text: `Todos updated.\n${render()}` }],
				details: { todos },
			};
		},
	});
}
