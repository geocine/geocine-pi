// baseten-limits: client-side RPM/TPM gate for the Baseten provider only.
// Baseten Basic (unverified): 15 RPM / 100,000 TPM.
// https://docs.baseten.co/inference/model-apis/pricing-and-limits
//
// Two layers:
//   1. Server-informed: after_provider_response watches for 429s and honors
//      the Retry-After header (Baseten's retry_after also lands in the JSON
//      body, but the body stream is not consumed yet in that hook — the
//      header carries the same reset value). All requests are held until
//      the window resets.
//   2. Fallback: when the server gives no Retry-After (or before any 429),
//      the built-in sliding-window RPM/TPM computation below paces requests
//      proactively.
//
// Pi has no settings.json RPM/TPM fields. before_provider_request is the
// hook that can delay a request. Provider comes from ctx.model.provider.

const env: Record<string, string | undefined> = (globalThis as any).process?.env ?? {};

const RPM = Number(env.BASETEN_RPM ?? 14);
const TPM = Number(env.BASETEN_TPM ?? 90_000);
const WINDOW_MS = 60_000;
const DEFAULT_INPUT = 12_000;
const DEFAULT_OUTPUT = 4_096;

const requests: number[] = [];
const tokens: { t: number; n: number }[] = [];

function prune(now: number) {
  while (requests.length && now - requests[0] >= WINDOW_MS) requests.shift();
  while (tokens.length && now - tokens[0].t >= WINDOW_MS) tokens.shift();
}

function usedTokens() {
  return tokens.reduce((s, x) => s + x.n, 0);
}

function waitRpm(now: number) {
  prune(now);
  if (requests.length < RPM) return 0;
  return WINDOW_MS - (now - requests[0]) + 50;
}

function waitTpm(now: number, need: number) {
  prune(now);
  const used = usedTokens();
  if (used + need <= TPM) return 0;
  let released = 0;
  for (const x of tokens) {
    released += x.n;
    if (used - released + need <= TPM) return WINDOW_MS - (now - x.t) + 50;
  }
  return WINDOW_MS;
}

function isBaseten(ctx: { model?: { provider?: unknown } } | undefined) {
  return String(ctx?.model?.provider) === "baseten";
}

// Server-informed hold: set from 429 responses, cleared by any success.
let blockedUntil = 0;

/** Parse Retry-After: either delta-seconds or an HTTP date. */
function parseRetryAfter(value: unknown): number | undefined {
  if (typeof value !== "string" || value.trim() === "") return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds;
  const date = Date.parse(value);
  if (!Number.isNaN(date)) return Math.max(0, (date - Date.now()) / 1000);
  return undefined;
}

function waitServer(now: number) {
  return blockedUntil > now ? blockedUntil - now : 0;
}

function estimateNeed(event: { payload?: unknown }, ctx: any) {
  const payload = (event?.payload ?? {}) as Record<string, unknown>;
  const usageTokens = ctx?.getContextUsage?.()?.tokens;
  const input = Number(
    usageTokens != null && Number.isFinite(usageTokens) ? usageTokens : DEFAULT_INPUT,
  );
  const rawOut = Number(
    payload.max_tokens ?? payload.max_completion_tokens ?? DEFAULT_OUTPUT,
  );
  const output = Number.isFinite(rawOut) && rawOut > 0 ? rawOut : DEFAULT_OUTPUT;
  return Math.min(TPM, input + Math.min(output, TPM));
}

function sleep(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error("aborted"));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason ?? new Error("aborted"));
      },
      { once: true },
    );
  });
}

export default function (pi: any) {
  pi.on("before_provider_request", async (event: any, ctx: any) => {
    if (!isBaseten(ctx)) return;

    const need = estimateNeed(event, ctx);

    for (;;) {
      const now = Date.now();
      // Server-informed hold first; the built-in RPM/TPM computation is the
      // fallback pacing when the server has not told us anything.
      const wait = Math.max(waitServer(now), waitRpm(now), waitTpm(now, need));
      if (wait <= 0) break;
      if (waitServer(now) > 0) {
        ctx?.ui?.setStatus?.("baseten", `baseten 429: waiting ${Math.ceil(wait / 1000)}s (server retry_after)`);
      }
      await sleep(wait, ctx?.signal);
    }
    ctx?.ui?.setStatus?.("baseten", undefined);

    const t = Date.now();
    requests.push(t);
    tokens.push({ t, n: need });
  });

  pi.on("after_provider_response", (event: any, ctx: any) => {
    if (!isBaseten(ctx)) return;

    if (event?.status === 429) {
      const retrySec = parseRetryAfter(event?.headers?.["retry-after"]);
      if (retrySec !== undefined) {
        // Trust the server's window reset (+1s slack).
        blockedUntil = Date.now() + (retrySec + 1) * 1000;
        ctx?.ui?.notify?.(`Baseten rate limited: server says retry in ${Math.ceil(retrySec)}s`, "warning");
      } else {
        // 429 without Retry-After: our window drifted from the server's.
        // Hold until the oldest tracked request leaves our window as the
        // best local estimate (min 5s).
        const now = Date.now();
        const est = requests.length > 0 ? WINDOW_MS - (now - requests[0]) : WINDOW_MS;
        blockedUntil = now + Math.max(5_000, est);
        ctx?.ui?.notify?.(
          `Baseten rate limited (no retry-after header): backing off ${Math.ceil(Math.max(5_000, est) / 1000)}s`,
          "warning",
        );
      }
      return;
    }
    if (typeof event?.status === "number" && event.status < 400) {
      blockedUntil = 0;
    }
  });
}
