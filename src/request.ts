import { AguMailError, type AguMailErrorCode } from './errors';
import { API_KEY_ENV, VERSION } from './runtime';

export const DEFAULT_BASE_URL = 'https://api.agumail.com';

const SINGLE_TIMEOUT_MS = 10_000;
// The server works through a batch one record at a time, and the WooCommerce
// plugin gives its batches the same minute.
const BATCH_TIMEOUT_MS = 60_000;
// A longer wait than this is better left to the caller, who has `retryAfter`.
const MAX_RETRY_AFTER_S = 60;
const BACKOFF_BASE_MS = 500;
const BACKOFF_CAP_MS = 8_000;
const KEY_PATTERN = /^agm_[0-9a-f]{40}$/;

export interface Transport {
  apiKey: string;
  /** The key came from AGUMAIL_API_KEY rather than the constructor, which the error names. */
  keyFromEnv: boolean;
  baseUrl: string;
  timeoutMs: number | undefined;
  maxRetries: number;
  fetch: typeof fetch | undefined;
}

export interface RequestSpec {
  method: 'GET' | 'POST';
  path: string;
  body?: unknown;
  /** How many records the request carries, which picks the default timeout. */
  records: number;
  timeoutMs?: number | undefined;
  signal?: AbortSignal | undefined;
}

type Attempt =
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; error: AguMailError; retry: boolean; waitMs?: number };

export function normalizeBaseUrl(raw: string | undefined): string {
  return (raw ?? DEFAULT_BASE_URL).trim().replace(/\/+$/, '').replace(/\/api\/v1$/, '');
}

export function baseUrlProblem(baseUrl: string): string | undefined {
  return /^https?:\/\/[^/]/.test(baseUrl) ? undefined : `options.baseUrl must be an http(s) address, such as ${DEFAULT_BASE_URL}.`;
}

export async function request(t: Transport, spec: RequestSpec): Promise<Record<string, unknown>> {
  checkKey(t.apiKey, t.keyFromEnv);
  // Read at call time, so a fetch installed after the client was made is used.
  const fetchImpl = t.fetch ?? (globalThis.fetch as typeof fetch | undefined);
  if (typeof fetchImpl !== 'function') {
    throw new AguMailError('No fetch is available here. Use Node 18 or newer, or pass options.fetch.', { code: 'unexpected' });
  }
  const headers: Record<string, string> = {
    Authorization: `Bearer ${t.apiKey}`,
    Accept: 'application/json',
    'User-Agent': `agumail-js/${VERSION}`,
  };
  if (spec.body !== undefined) headers['Content-Type'] = 'application/json';
  const init: RequestInit = { method: spec.method, headers };
  if (spec.body !== undefined) init.body = JSON.stringify(spec.body);
  const url = t.baseUrl + spec.path;
  const timeoutMs = spec.timeoutMs ?? t.timeoutMs ?? (spec.records > 1 ? BATCH_TIMEOUT_MS : SINGLE_TIMEOUT_MS);

  for (let attempt = 0; ; attempt++) {
    const result = await attemptOnce(fetchImpl, url, init, timeoutMs, spec.signal);
    if (result.ok) return result.body;
    if (!result.retry || attempt >= t.maxRetries) {
      if (attempt > 0) result.error.message += ` (after ${attempt + 1} attempts)`;
      throw result.error;
    }
    await sleep(result.waitMs ?? backoff(attempt), spec.signal);
  }
}

function checkKey(apiKey: string, fromEnv: boolean): void {
  if (!apiKey) {
    throw new AguMailError(
      `No AguMail API key. Pass it to new AguMail(...) or set ${API_KEY_ENV}. ` +
        'Create one in AguMail under Settings > Store & API > API keys.',
      { code: 'missing_api_key' }
    );
  }
  if (!KEY_PATTERN.test(apiKey)) {
    throw new AguMailError(
      `${fromEnv ? `${API_KEY_ENV} does not hold` : 'That is not'} an AguMail API key: keys are agm_ followed by ` +
        '40 lowercase hex characters. Copy it again from Settings > Store & API > API keys.',
      { code: 'missing_api_key' }
    );
  }
}

async function attemptOnce(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
  signal: AbortSignal | undefined
): Promise<Attempt> {
  if (signal?.aborted) return { ok: false, retry: false, error: abortedError(signal.reason) };
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  // Raced against the request too, so a fetch that ignores its signal still
  // cannot outlive the timeout.
  const stopped = new Promise<never>((_, reject) => {
    controller.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  });
  stopped.catch(() => {});

  try {
    let res: Response;
    let text: string;
    try {
      const pending = fetchImpl(url, { ...init, signal: controller.signal });
      pending.catch(() => {});
      res = await Promise.race([pending, stopped]);
      const reading = res.text();
      reading.catch(() => {});
      text = await Promise.race([reading, stopped]);
    } catch (cause) {
      if (signal?.aborted) return { ok: false, retry: false, error: abortedError(cause) };
      if (timedOut) {
        return {
          ok: false,
          retry: true,
          error: new AguMailError(`AguMail did not answer within ${timeoutMs} ms.`, { code: 'timeout', cause }),
        };
      }
      return {
        ok: false,
        retry: true,
        error: new AguMailError(`Could not reach AguMail: ${messageOf(cause)}`, { code: 'network_error', cause }),
      };
    }
    return classify(res, text);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

function classify(res: Response, text: string): Attempt {
  const body = parseObject(text);
  const status = res.status;
  if (res.ok) {
    if (body) return { ok: true, body };
    return {
      ok: false,
      retry: false,
      error: new AguMailError(`AguMail answered ${status} with something that is not JSON.`, { code: 'unexpected', status }),
    };
  }
  const message =
    typeof body?.error === 'string' && body.error
      ? body.error
      : `AguMail answered ${status}${res.statusText ? ` ${res.statusText}` : ''}.`;

  if (status === 429) {
    const retryAfter = retryAfterOf(res.headers.get('retry-after'), body?.retryAfter);
    const error = new AguMailError(message, { code: 'rate_limited', status, retryAfter });
    if (retryAfter !== null && retryAfter > MAX_RETRY_AFTER_S) return { ok: false, retry: false, error };
    return retryWith(error, retryAfter);
  }
  if (status === 408 || status >= 500) {
    const retryAfter = retryAfterOf(res.headers.get('retry-after'), undefined);
    const error = new AguMailError(message, { code: status === 408 ? 'timeout' : 'server_error', status, retryAfter });
    return retryWith(error, retryAfter !== null && retryAfter <= MAX_RETRY_AFTER_S ? retryAfter : null);
  }
  return { ok: false, retry: false, error: new AguMailError(message, { code: codeFor(status), status }) };
}

function retryWith(error: AguMailError, retryAfter: number | null): Attempt {
  if (retryAfter === null) return { ok: false, retry: true, error };
  // A little jitter, so clients told the same second do not all come back in it.
  return { ok: false, retry: true, error, waitMs: retryAfter * 1000 + Math.random() * 250 };
}

function codeFor(status: number): AguMailErrorCode {
  if (status === 401) return 'unauthorized';
  if (status === 402) return 'payment_required';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not_found';
  return 'bad_request';
}

/** Seconds to wait: the header (seconds or an HTTP date) first, then the body's `retryAfter`. */
function retryAfterOf(header: string | null, fromBody: unknown): number | null {
  const raw = header?.trim();
  if (raw) {
    if (/^\d+(\.\d+)?$/.test(raw)) return Math.ceil(Number(raw));
    const at = Date.parse(raw);
    if (!Number.isNaN(at)) return Math.max(0, Math.ceil((at - Date.now()) / 1000));
  }
  if (typeof fromBody === 'number' && Number.isFinite(fromBody) && fromBody >= 0) return Math.ceil(fromBody);
  return null;
}

function backoff(attempt: number): number {
  const ceiling = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** attempt);
  return ceiling / 2 + Math.random() * (ceiling / 2);
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortedError(signal.reason));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortedError(signal?.reason));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function abortedError(cause: unknown): AguMailError {
  return new AguMailError('The request was aborted.', { code: 'aborted', cause });
}

function parseObject(text: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(text);
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function messageOf(cause: unknown): string {
  if (cause instanceof Error) {
    // Node's fetch says only "fetch failed" and keeps the reason one level down.
    const inner = (cause as { cause?: unknown }).cause;
    return inner instanceof Error && inner.message ? `${cause.message} (${inner.message})` : cause.message;
  }
  return String(cause);
}
