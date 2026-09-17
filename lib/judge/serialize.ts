// Training-data serialization: the single source of truth for how a judge
// call becomes (context, schema, labels) — the row format of the trace
// JSONL and therefore of the offline classifier's training set. The target
// technique is parallel constrained decoding over boolean/enum fields (see
// jev-model-reference: a small head answers a whole schema in one broadcast
// pass, probs from candidate-token logits). The naive-llm fallback tier
// prompts with THIS exact serialization, so fallback inference, logged
// rows, and the future local head share one format: train/serve parity by
// construction, never by convention.
//
// Folding rules (lossless for training):
//  - noul   -> boolean field; instructions + true/false rubric -> description
//  - choice -> enum field; criteria keys -> choices, rubric -> description
//  - score  -> enum field; level indices -> choices, levels -> description
//  - state  -> context string (verbatim if already a string, else JSON)
//  - answer -> {value, prob, probs} soft label

import type { JudgeAnswer, JudgeQuestion, JudgeState } from "./types.ts";

export interface TrainingField {
	type: "boolean" | "enum";
	choices?: string[];
	description: string;
}

export interface TrainingLabel {
	value: string;
	prob: number;
	probs?: Record<string, number>;
}

export function toContext(state: JudgeState): string {
	return typeof state === "string" ? state : JSON.stringify(state, null, 1);
}

export function toSchema(questions: Record<string, JudgeQuestion>): Record<string, TrainingField> {
	const fields: Record<string, TrainingField> = {};
	for (const [name, q] of Object.entries(questions)) {
		if (q.type === "noul") {
			const parts = [q.instructions];
			if (q.criteria?.true) parts.push(`true: ${q.criteria.true}`);
			if (q.criteria?.false) parts.push(`false: ${q.criteria.false}`);
			fields[name] = { type: "boolean", description: parts.join(" | ") };
		} else if (q.type === "choice") {
			const rubric = Object.entries(q.criteria)
				.filter(([, d]) => d)
				.map(([c, d]) => `${c}: ${d}`);
			fields[name] = {
				type: "enum",
				choices: Object.keys(q.criteria),
				description: [q.instructions, ...rubric].join(" | "),
			};
		} else {
			fields[name] = {
				type: "enum",
				choices: q.criteria.map((_, i) => String(i)),
				description: [q.instructions, ...q.criteria.map((d, i) => `${i}: ${d}`)].join(" | "),
			};
		}
	}
	return fields;
}

export function toLabels(answers: Record<string, JudgeAnswer>): Record<string, TrainingLabel> {
	const labels: Record<string, TrainingLabel> = {};
	for (const [name, a] of Object.entries(answers)) {
		if (a.type === "noul") {
			const yes = a.noul >= 0.5;
			labels[name] = {
				value: String(yes),
				prob: yes ? a.noul : 1 - a.noul,
				probs: { true: a.noul, false: 1 - a.noul },
			};
		} else if (a.type === "choice") {
			labels[name] = { value: a.choice, prob: a.confidence, probs: a.probabilities };
		} else {
			const top = Object.entries(a.probabilities).sort((x, y) => y[1] - x[1])[0];
			labels[name] = {
				value: top?.[0] ?? String(Math.round(a.score)),
				prob: a.confidence,
				probs: a.probabilities,
			};
		}
	}
	return labels;
}

/**
 * TS-style schema block for naive JSON prompting (the reference's
 * to_json_schema_prompt_str shape, one field per line with its rubric).
 */
export function schemaPromptBlock(schema: Record<string, TrainingField>): string {
	const lines = ["{"];
	for (const [name, f] of Object.entries(schema)) {
		const t = f.type === "boolean" ? "true | false" : (f.choices ?? []).map((c) => JSON.stringify(c)).join(" | ");
		lines.push(`  "${name}": { "value": ${t}, "prob": number }, // ${f.description.replace(/\s*\n\s*/g, " ")}`);
	}
	lines.push("}");
	return lines.join("\n");
}
