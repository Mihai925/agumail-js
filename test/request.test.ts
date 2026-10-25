import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AguMail, VERSION } from '../src/index';
import { client, contactsOk, fail, KEY, mockFetch, ok, rejection, settle } from './helpers';

const contact = { email: 'sam@example.com' };

describe('requests', () => {
  it('sends the key, JSON headers and a user agent', async () => {
    const { fetch, sent } = mockFetch(contactsOk());
    await client(fetch).identify(contact);
    expect(sent[0]!.headers).toEqual({
      Authorization: `Bearer ${KEY}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'User-Agent': `agumail-js/${VERSION}`,
    });
  });

  it.each([
    ['http://localhost:3011', 'http://localhost:3011/api/v1/contacts'],
    ['http://localhost:3011/', 'http://localhost:3011/api/v1/contacts'],
    ['http://localhost:3011/api/v1/', 'http://localhost:3011/api/v1/contacts'],
  ])('uses baseUrl %s', async (baseUrl, url) => {
    const { fetch, sent } = mockFetch(contactsOk());
    await client(fetch, { baseUrl }).identify(contact);
    expect(sent[0]!.url).toBe(url);
  });

  it('uses the global fetch at call time when none is passed', async () => {
    const { fetch, sent } = mockFetch(contactsOk());
    const agumail = new AguMail(KEY);
    vi.stubGlobal('fetch', fetch);
    try {
      await agumail.identify(contact);
    } finally {
      vi.unstubAllGlobals();
    }
    expect(sent).toHaveLength(1);
  });

  it('uses the message the server sends', async () => {
    const { fetch } = mockFetch(fail(400, 'contacts.0.email: Invalid email'));
    const error = await rejection(client(fetch).identify(contact));
    expect(error).toMatchObject({ name: 'AguMailError', status: 400, code: 'bad_request', retryAfter: null });
    expect(error.message).toBe('contacts.0.email: Invalid email');
  });

  it('refuses a 200 that is not JSON', async () => {
    const { fetch } = mockFetch({ status: 200, text: '<html>captive portal</html>' });
    const error = await rejection(client(fetch).identify(contact));
    expect(error.code).toBe('unexpected');
  });
});

describe('retries', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it.each([500, 502, 503, 504, 408])('retries a %s and then succeeds', async (status) => {
    const { fetch, calls } = mockFetch(fail(status), contactsOk());
    const result = await settle(client(fetch).identify(contact));
    expect(result.created).toBe(1);
    expect(calls()).toBe(2);
  });

  it('retries a 5xx whose body is not JSON', async () => {
    const { fetch, calls } = mockFetch({ status: 502, text: 'Bad Gateway' }, contactsOk());
    await settle(client(fetch).identify(contact));
    expect(calls()).toBe(2);
  });

  it('retries a network error', async () => {
    const { fetch, calls } = mockFetch(new TypeError('fetch failed'), contactsOk());
    await settle(client(fetch).identify(contact));
    expect(calls()).toBe(2);
  });

  it('retries a timeout, even with a fetch that ignores its signal', async () => {
    const { fetch, calls } = mockFetch('hang', contactsOk());
    await settle(client(fetch, { timeoutMs: 2000 }).identify(contact));
    expect(calls()).toBe(2);
  });

  it('times out after 10 seconds for one record and 60 for a batch', async () => {
    const one = mockFetch('hang');
    const single = client(one.fetch, { maxRetries: 0 }).identify(contact);
    single.catch(() => {});
    await vi.advanceTimersByTimeAsync(9_999);
    expect(one.calls()).toBe(1);
    await vi.advanceTimersByTimeAsync(2);
    const error = await rejection(single);
    expect(error.code).toBe('timeout');
    expect(error.message).toContain('10000 ms');

    const many = mockFetch('hang');
    const batch = client(many.fetch, { maxRetries: 0 }).identifyMany([contact, { email: 'alex@example.com' }]);
    batch.catch(() => {});
    await vi.advanceTimersByTimeAsync(59_999);
    let settled = false;
    batch.then(
      () => (settled = true),
      () => (settled = true)
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(2);
    expect((await rejection(batch)).message).toContain('60000 ms');
  });

  it('lets timeoutMs on the call override the default', async () => {
    const { fetch } = mockFetch('hang');
    const promise = client(fetch, { maxRetries: 0 }).identify(contact, { timeoutMs: 500 });
    promise.catch(() => {});
    await vi.advanceTimersByTimeAsync(501);
    expect((await rejection(promise)).message).toContain('500 ms');
  });

  it('waits as long as the Retry-After header says on a 429', async () => {
    const { fetch, calls } = mockFetch(fail(429, 'Rate limit', { 'Retry-After': '3' }), contactsOk());
    const promise = client(fetch).identify(contact);
    await vi.advanceTimersByTimeAsync(2_999);
    expect(calls()).toBe(1);
    await vi.advanceTimersByTimeAsync(300);
    await promise;
    expect(calls()).toBe(2);
  });

  it('falls back to retryAfter in the body', async () => {
    const { fetch, calls } = mockFetch({ status: 429, body: { ok: false, error: 'Rate limit', retryAfter: 2 } }, contactsOk());
    const promise = client(fetch).identify(contact);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(calls()).toBe(1);
    await vi.advanceTimersByTimeAsync(300);
    await promise;
    expect(calls()).toBe(2);
  });

  it('reads Retry-After as an HTTP date', async () => {
    const at = new Date(Date.now() + 5_000).toUTCString();
    const { fetch, calls } = mockFetch(fail(429, 'Rate limit', { 'Retry-After': at }), contactsOk());
    const promise = client(fetch).identify(contact);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(calls()).toBe(1);
    await vi.advanceTimersByTimeAsync(3_000);
    await promise;
    expect(calls()).toBe(2);
  });

  it('gives up straight away when asked to wait more than a minute', async () => {
    const { fetch, calls } = mockFetch(fail(429, 'Rate limit', { 'Retry-After': '120' }));
    const error = await rejection(client(fetch).identify(contact));
    expect(error).toMatchObject({ status: 429, code: 'rate_limited', retryAfter: 120 });
    expect(calls()).toBe(1);
  });

  it('reports retryAfter on the last 429 when retries run out', async () => {
    const { fetch, calls } = mockFetch(fail(429, 'Rate limit', { 'Retry-After': '1' }));
    const error = await rejection(settle(client(fetch).identify(contact)));
    expect(calls()).toBe(4);
    expect(error).toMatchObject({ code: 'rate_limited', retryAfter: 1 });
  });

  it.each([
    [400, 'bad_request'],
    [401, 'unauthorized'],
    [402, 'payment_required'],
    [403, 'forbidden'],
    [404, 'not_found'],
    [422, 'bad_request'],
  ])('never retries a %s', async (status, code) => {
    const { fetch, calls } = mockFetch(fail(status));
    const error = await rejection(settle(client(fetch).identify(contact)));
    expect(error).toMatchObject({ status, code });
    expect(calls()).toBe(1);
  });

  it('retries 3 times by default, then throws the last error', async () => {
    const { fetch, calls } = mockFetch(fail(503, 'Down for maintenance'));
    const error = await rejection(settle(client(fetch).identify(contact)));
    expect(calls()).toBe(4);
    expect(error).toMatchObject({ status: 503, code: 'server_error' });
    expect(error.message).toBe('Down for maintenance (after 4 attempts)');
  });

  it('honours maxRetries', async () => {
    const none = mockFetch(fail(500));
    await rejection(settle(client(none.fetch, { maxRetries: 0 }).identify(contact)));
    expect(none.calls()).toBe(1);

    const five = mockFetch(fail(500));
    await rejection(settle(client(five.fetch, { maxRetries: 5 }).identify(contact)));
    expect(five.calls()).toBe(6);
  });

  it('backs off exponentially between retries', async () => {
    const { fetch, calls } = mockFetch(fail(500));
    // At the top of the jitter the waits are just under 0.5s, 1s and 2s.
    vi.spyOn(Math, 'random').mockReturnValue(0.999);
    const promise = client(fetch).identify(contact);
    promise.catch(() => {});
    const start = Date.now();
    const at = async (ms: number) => vi.advanceTimersByTimeAsync(ms - (Date.now() - start));
    await at(0);
    expect(calls()).toBe(1);
    await at(450);
    expect(calls()).toBe(1);
    await at(550);
    expect(calls()).toBe(2);
    await at(1_450);
    expect(calls()).toBe(2);
    await at(1_550);
    expect(calls()).toBe(3);
    await at(3_450);
    expect(calls()).toBe(3);
    await at(3_550);
    expect(calls()).toBe(4);
    await rejection(promise);
  });

  it('stops at once when your signal aborts, and never retries it', async () => {
    const { fetch, calls } = mockFetch('hang');
    const controller = new AbortController();
    const promise = client(fetch).identify(contact, { signal: controller.signal });
    promise.catch(() => {});
    await vi.advanceTimersByTimeAsync(100);
    controller.abort();
    const error = await rejection(promise);
    expect(error.code).toBe('aborted');
    expect(calls()).toBe(1);
  });

  it('stops waiting between retries when your signal aborts', async () => {
    const { fetch, calls } = mockFetch(fail(500));
    const controller = new AbortController();
    const promise = client(fetch).identify(contact, { signal: controller.signal });
    promise.catch(() => {});
    await vi.advanceTimersByTimeAsync(10);
    controller.abort();
    expect((await rejection(promise)).code).toBe('aborted');
    expect(calls()).toBe(1);
  });

  it('sends nothing when the signal is already aborted', async () => {
    const { fetch, calls } = mockFetch(ok());
    const error = await rejection(client(fetch).ping({ signal: AbortSignal.abort() }));
    expect(error.code).toBe('aborted');
    expect(calls()).toBe(0);
  });
});
