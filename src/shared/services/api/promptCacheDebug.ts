/**
 * Prompt-cache diagnostics.
 *
 * Two independent probes, both provider-agnostic:
 *
 *   - `logCacheUsage` — always on. One line per API call with the cache-read
 *     share of the input, so a collapsed hit rate is visible in the console
 *     without instrumenting anything.
 *   - `probePrefixDivergence` — opt-in via `globalThis.__GREMLIN_CACHE_DEBUG__`.
 *     Hashes each segment of the outgoing request (instructions, tools, then
 *     every input item) and diffs it against the previous request under the
 *     same routing key, naming the first segment that changed. A provider
 *     caches on a stable prefix; when the hit rate collapses this says whether
 *     the prefix moved and where, instead of leaving it to inspection.
 *
 * The probe stringifies the request, so it stays behind the flag — on a large
 * context that is a few hundred KB per call.
 */

/** Per-call cache numbers, as the clients already report them. */
export interface CacheUsageSample {
  /** Input tokens excluding cache reads — the house convention for `StreamResult`. */
  inputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  servedModel?: string;
}

/** Whether the prefix probe is armed. Dev-only; no UI, no persisted setting. */
export function isCacheDebugEnabled(): boolean {
  return (globalThis as { __GREMLIN_CACHE_DEBUG__?: boolean }).__GREMLIN_CACHE_DEBUG__ === true;
}

/**
 * Report the cache-read share of one call. `inputTokens` is net of cache reads
 * everywhere except Anthropic/Bedrock, so the denominator is their sum.
 */
export function logCacheUsage(
  apiType: string,
  cacheRoutingKey: string | undefined,
  usage: CacheUsageSample
): void {
  const cacheRead = usage.cacheReadTokens ?? 0;
  const freshInput = usage.inputTokens ?? 0;
  const totalInput = freshInput + cacheRead;
  console.debug('[promptCache] usage', {
    apiType,
    key: shortKey(cacheRoutingKey),
    servedModel: usage.servedModel,
    input: freshInput,
    cacheRead,
    cacheWrite: usage.cacheCreationTokens ?? 0,
    hitPct: totalInput > 0 ? Math.round((cacheRead / totalInput) * 100) : 0,
  });
}

/** Segment hashes of one request, keyed by routing key. Only the last call is kept. */
const lastRequestSegments = new Map<string, string[]>();

/**
 * Compare this request's prefix against the previous one under the same
 * routing key and log where they diverge. No-op unless the debug flag is set.
 */
export function probePrefixDivergence(
  apiType: string,
  cacheRoutingKey: string | undefined,
  request: { instructions?: unknown; tools?: unknown; input?: unknown }
): void {
  if (!isCacheDebugEnabled()) return;

  const segments = segmentHashes(request);
  const key = cacheRoutingKey ?? '<no-routing-key>';
  const previous = lastRequestSegments.get(key);
  lastRequestSegments.set(key, segments);

  if (!previous) {
    console.debug('[promptCache] prefix baseline', {
      apiType,
      key: shortKey(cacheRoutingKey),
      segments: segments.length,
    });
    return;
  }

  const shared = Math.min(previous.length, segments.length);
  let divergedAt = -1;
  for (let i = 0; i < shared; i++) {
    if (previous[i] !== segments[i]) {
      divergedAt = i;
      break;
    }
  }

  if (divergedAt === -1) {
    console.debug('[promptCache] prefix stable', {
      apiType,
      key: shortKey(cacheRoutingKey),
      kept: shared,
      appended: segments.length - previous.length,
    });
    return;
  }

  console.debug('[promptCache] PREFIX DIVERGED — cache reads will be lost from here', {
    apiType,
    key: shortKey(cacheRoutingKey),
    // 0 = instructions, 1 = tools, 2+ = input[index - 2]
    segment: segmentLabel(divergedAt),
    stablePrefixSegments: divergedAt,
    previousSegments: previous.length,
    currentSegments: segments.length,
  });
}

/** Drop retained hashes. Tests use this; production never needs it. */
export function resetPrefixProbe(): void {
  lastRequestSegments.clear();
}

function segmentHashes(request: {
  instructions?: unknown;
  tools?: unknown;
  input?: unknown;
}): string[] {
  const items = Array.isArray(request.input) ? request.input : [];
  const hashes = [hash(request.instructions), hash(request.tools)];
  for (const item of items) {
    hashes.push(hash(item));
  }
  return hashes;
}

function segmentLabel(index: number): string {
  if (index === 0) return 'instructions';
  if (index === 1) return 'tools';
  return `input[${index - 2}]`;
}

/** FNV-1a over the serialized value. Collision risk is irrelevant for a debug diff. */
function hash(value: unknown): string {
  const text = value === undefined ? '' : JSON.stringify(value);
  let acc = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    acc ^= text.charCodeAt(i);
    acc = Math.imul(acc, 0x01000193);
  }
  return (acc >>> 0).toString(16);
}

/** Routing keys are 64-char digests; the head is enough to tell buckets apart. */
function shortKey(cacheRoutingKey: string | undefined): string {
  return cacheRoutingKey ? cacheRoutingKey.slice(0, 8) : '<none>';
}
