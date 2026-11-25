// Claude Code routine API trigger: POST <fire url> with {"text": "..."}.
// There is no idempotency key, so callers must dedupe before firing (the relay keys runs by event_id).

export const FIRE_URL_RE = /^https:\/\/api\.anthropic\.com\/v1\/claude_code\/routines\/[A-Za-z0-9_-]{1,128}\/fire$/;
export const TOKEN_RE = /^sk-ant-[A-Za-z0-9_-]{20,400}$/;

export const DEFAULT_ANTHROPIC_VERSION = '2023-06-01';
export const DEFAULT_ANTHROPIC_BETA = 'experimental-cc-routine-2026-04-01';

export function isValidFireUrl(url) {
  return typeof url === 'string' && FIRE_URL_RE.test(url.trim());
}

export function isValidRoutineToken(token) {
  return typeof token === 'string' && TOKEN_RE.test(token.trim());
}

/**
 * Fire a routine. Never throws; returns
 *   { ok: true, sessionId, sessionUrl }
 *   { ok: false, status, error, retryAfter }
 */
export async function fireRoutine({ url, token, text, fetchImpl = fetch, timeoutMs = 10000, env = process.env }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'anthropic-version': env.ROUTINE_ANTHROPIC_VERSION || DEFAULT_ANTHROPIC_VERSION,
        'anthropic-beta': env.ROUTINE_ANTHROPIC_BETA || DEFAULT_ANTHROPIC_BETA,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(text ? { text } : {}),
      signal: controller.signal,
    });
    const raw = await res.text();
    let data = null;
    try {
      data = raw ? JSON.parse(raw) : null;
    } catch {
      /* non-JSON error body */
    }
    if (res.ok) {
      return {
        ok: true,
        sessionId: data?.claude_code_session_id ?? null,
        sessionUrl: data?.claude_code_session_url ?? null,
      };
    }
    const retryAfter = res.headers?.get?.('retry-after') ?? null;
    const message = data?.error?.message || data?.message || raw.slice(0, 300) || res.statusText;
    return { ok: false, status: res.status, retryAfter, error: `HTTP ${res.status}: ${message}` };
  } catch (e) {
    const error = e?.name === 'AbortError' ? `timeout after ${timeoutMs}ms` : `network error: ${e?.message ?? e}`;
    return { ok: false, status: 0, retryAfter: null, error };
  } finally {
    clearTimeout(timer);
  }
}

/** Human-readable error for storing on a run / credential. */
export function describeFireError(result) {
  if (result.status === 429) return `rate_limited: ${result.error}${result.retryAfter ? ` (Retry-After ${result.retryAfter}s)` : ''}`;
  if (result.status === 401 || result.status === 403) return `token_rejected: ${result.error}`;
  return result.error;
}
