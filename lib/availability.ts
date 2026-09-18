// Model availability: which registry entries are actually usable RIGHT NOW,
// so choice surfaces (the route node, the approval picker, /consult,
// /models) never offer a model that cannot answer.
//
// Two checks, both scoped to llama.cpp entries — a local server that is
// simply not running is the common failure; cloud providers are assumed up
// (their rare outages surface at call time with a clear error):
//  1. Known to pi: the entry must resolve in pi's own model catalogue
//     (ctx.modelRegistry.find) — a consult child is a `pi --provider
//     --model` process, so a model pi cannot resolve cannot run at all.
//  2. Alive: GET /health on the server origin pi resolves for the model
//     (llama.cpp serves /health natively: 200 = ready, 503 = loading).
//     Results are cached briefly per origin so pickers and per-consult
//     routing don't re-ping a server on every call.

import type { ModelConfig } from "./config.ts";

/** The slice of pi's ModelRegistry that availability needs. */
export interface PiModelRegistry {
	find(provider: string, modelId: string): { baseUrl?: string } | undefined;
}

const PROBED_PROVIDERS = ["llama.cpp"];
const PROBE_TIMEOUT_MS = 800;
const CACHE_TTL_MS = 15_000;

/** origin -> last probe result. */
const probeCache = new Map<string, { ok: boolean; ts: number }>();

async function serverAlive(baseUrl: string): Promise<boolean> {
	let origin: string;
	try {
		origin = new URL(baseUrl).origin;
	} catch {
		return true; // unparseable URL — let the real call surface the error
	}
	const cached = probeCache.get(origin);
	if (cached && Date.now() - cached.ts < CACHE_TTL_MS) return cached.ok;
	let ok = false;
	try {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
		const res = await fetch(`${origin}/health`, { signal: controller.signal });
		clearTimeout(timer);
		ok = res.ok;
	} catch {
		ok = false;
	}
	probeCache.set(origin, { ok, ts: Date.now() });
	return ok;
}

/**
 * Offline registry entries in `pool`: map of entry name -> human reason.
 * Empty map = everything offered is usable. Only llama.cpp entries are
 * ever marked; without a registry handle (headless call sites) nothing is.
 */
export async function offlineModels(
	pool: Record<string, ModelConfig>,
	registry: PiModelRegistry | undefined,
): Promise<Map<string, string>> {
	const offline = new Map<string, string>();
	if (!registry) return offline;
	await Promise.all(
		Object.entries(pool).map(async ([name, c]) => {
			if (!c.provider || !PROBED_PROVIDERS.includes(c.provider)) return;
			let known: { baseUrl?: string } | undefined;
			try {
				known = registry.find(c.provider, c.model);
			} catch {
				return; // registry hiccup — do not exclude on a lookup error
			}
			if (!known) {
				offline.set(name, `not in pi's model catalogue (pi --list-models)`);
				return;
			}
			if (known.baseUrl && !(await serverAlive(known.baseUrl))) {
				offline.set(name, `server not responding at ${known.baseUrl}`);
			}
		}),
	);
	return offline;
}
