// Consult-child marker. runPi sets GEOCINE_CONSULT_CHILD=1 on every child
// pi process (consultant, prescreen, distill). geocine-pi is installed as a
// global pi package, so the child discovers the same extensions as the main
// session; the behavioral ones (triage, watchdog, outcome gate, context
// keeper, advisor, …) must stay inert there. A consult is one bounded brief:
// nothing may steer, hop, nudge, or inject into it. Provider and model
// harness extensions still load — the child needs them to talk to its model.

export const CONSULT_CHILD_ENV = "GEOCINE_CONSULT_CHILD";

export function isConsultChild(): boolean {
	return process.env[CONSULT_CHILD_ENV] === "1";
}
