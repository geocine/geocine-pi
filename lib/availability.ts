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
import { sameOrigin } from "./judge/index.ts";

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

// ---------- worker prompt-cache protection ----------
//
// A consult on the server that is serving a local worker competes for the
// worker's KV cache. On a single-slot llama.cpp server the consult prompt
// replaces the worker's slot and the worker's next turn re-prefills the
// whole session. A model-swapping router on that origin is worse (the
// worker model is unloaded). Same rule as the judge fallback tier and the
// prescreen: avoid it. Cloud endpoints never count — their prompt caches
// are not a single shared slot.

const SLOT_CACHE_TTL_MS = 60_000;
/** origin -> llama.cpp total_slots (undefined = unknown). */
const slotCache = new Map<string, { slots?: number; ts: number }>();

async function serverSlots(origin: string): Promise<number | undefined> {
	const cached = slotCache.get(origin);
	if (cached && Date.now() - cached.ts < SLOT_CACHE_TTL_MS) return cached.slots;
	let slots: number | undefined;
	try {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
		const res = await fetch(`${origin}/props`, { signal: controller.signal });
		clearTimeout(timer);
		if (res.ok) {
			const body = (await res.json()) as { total_slots?: unknown };
			if (typeof body.total_slots === "number") slots = body.total_slots;
		}
	} catch {
		slots = undefined;
	}
	slotCache.set(origin, { slots, ts: Date.now() });
	return slots;
}

/** Loopback or private-network URL: a self-hosted server, not a cloud API. */
export function selfHostedUrl(raw: string): boolean {
	try {
		return selfHosted(new URL(raw));
	} catch {
		return false;
	}
}

function selfHosted(url: URL): boolean {
	const h = url.hostname.replace(/^\[|\]$/g, "");
	return (
		h === "localhost" ||
		h === "::1" ||
		h.endsWith(".local") ||
		/^127\./.test(h) ||
		/^10\./.test(h) ||
		/^192\.168\./.test(h) ||
		/^172\.(1[6-9]|2\d|3[01])\./.test(h)
	);
}

/**
 * Entries in `pool` whose consult would evict the local worker's prompt
 * cache: served from the worker's own self-hosted server, and that server
 * has one slot (or an unknown count — fail toward keeping the cache).
 * Map of entry name -> human reason. Empty for cloud workers.
 */
export async function cacheSharingModels(
	pool: Record<string, ModelConfig>,
	registry: PiModelRegistry | undefined,
	workerBaseUrl: string | undefined,
): Promise<Map<string, string>> {
	const sharing = new Map<string, string>();
	if (!registry || !workerBaseUrl) return sharing;
	let worker: URL;
	try {
		worker = new URL(workerBaseUrl);
	} catch {
		return sharing;
	}
	if (!selfHosted(worker)) return sharing;
	const same = Object.entries(pool).filter(([, c]) => {
		if (!c.provider) return false;
		try {
			const url = registry.find(c.provider, c.model)?.baseUrl;
			return url !== undefined && sameOrigin(url, workerBaseUrl);
		} catch {
			return false;
		}
	});
	if (same.length === 0) return sharing;
	const slots = await serverSlots(worker.origin);
	if (slots !== undefined && slots > 1) return sharing;
	const why = `shares the worker's server (${worker.origin}, ${slots === 1 ? "1 slot" : "slot count unknown"}) — would evict its prompt cache`;
	for (const [name] of same) sharing.set(name, why);
	return sharing;
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
