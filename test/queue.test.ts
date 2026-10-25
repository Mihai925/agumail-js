import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AguMailWarning } from '../src/index';
import { client, contactsOk, eventsOk, fail, mockFetch, ok, settle, type SentRequest } from './helpers';

const zeroContacts = { created: 0, updated: 0, suppressedSkipped: 0, overCapacity: 0 };
const zeroEvents = { created: 0, duplicates: 0, unknownContacts: 0 };
const nothing = { contacts: zeroContacts, events: zeroEvents, error: null };

/** Answers every contact or event as created. */
const created = (request: SentRequest) =>
  request.url.endsWith('/events') ? eventsOk(request.body.events.length) : contactsOk(request.body.contacts.length);

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/** A fetch that holds each request until `release` is called. */
function gatedFetch() {
  const sent: SentRequest[] = [];
  const gates: (() => void)[] = [];
  const fetch = async (url: string, init: RequestInit = {}) => {
    const body = JSON.parse(init.body as string);
    sent.push({ url, method: init.method ?? 'GET', headers: {}, body });
    await new Promise<void>((resolve) => gates.push(resolve));
    const n = (body.contacts ?? body.events).length;
    const counts = { created: n, updated: 0, suppressedSkipped: 0, overCapacity: 0, duplicates: 0, unknownContacts: 0 };
    return new Response(JSON.stringify({ ok: true, ...counts }), { status: 200 });
  };
  return { fetch: fetch as unknown as typeof globalThis.fetch, sent, release: () => gates.shift()?.() };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('queue', () => {
  it('sends nothing until it flushes, then every contact before any event', async () => {
    const { fetch, sent } = mockFetch(created);
    const agumail = client(fetch, { flushIntervalMs: 0 });
    agumail.queue.track({ email: 'sam@example.com', event: 'Signed up', contact: { firstName: 'Sam' } });
    agumail.queue.identify({ email: 'alex@example.com' });
    agumail.queue.track({ email: 'alex@example.com', event: 'Signed up' });
    await tick();
    expect(sent).toHaveLength(0);

    const result = await agumail.flush();
    expect(sent.map((r) => r.url.split('/').pop())).toEqual(['contacts', 'events']);
    expect(sent[0]!.body.contacts).toEqual([
      // track's contact carries no consent, as with track itself.
      { email: 'sam@example.com', firstName: 'Sam' },
      { email: 'alex@example.com', consent: { optedIn: true, source: 'api' } },
    ]);
    expect(sent[1]!.body.events.map((e: any) => [e.email, e.metric])).toEqual([
      ['sam@example.com', 'Signed up'],
      ['alex@example.com', 'Signed up'],
    ]);
    expect(sent[1]!.body).not.toHaveProperty('backfill');
    expect(result).toEqual({ contacts: { ...zeroContacts, created: 2 }, events: { ...zeroEvents, created: 2 }, error: null });
  });

  it('queues by userId, and numbers a conflict in a flush by the order the contacts were queued', async () => {
    const warnings: AguMailWarning[] = [];
    const conflicted = [{ index: 2, userId: 'user_3', email: 'taken@example.com', reason: 'email_taken' }];
    const { fetch, sent } = mockFetch((request) =>
      request.url.endsWith('/events')
        ? eventsOk(request.body.events.length)
        : ok({ created: 1, updated: 1, suppressedSkipped: 0, overCapacity: 0, unknownContacts: 0, conflicts: 1, conflicted })
    );
    const agumail = client(fetch, { flushIntervalMs: 0, onWarning: (w) => void warnings.push(w) });
    agumail.queue.identify({ userId: 'user_1' });
    agumail.queue.track({ userId: 'user_2', event: 'Signed up', contact: { firstName: 'Sam' } });
    agumail.queue.identify({ userId: 'user_3', email: 'taken@example.com' });
    const result = await agumail.flush();
    expect(sent[0]!.body.contacts).toEqual([
      { userId: 'user_1', consent: { optedIn: true, source: 'api' } },
      { userId: 'user_2', firstName: 'Sam' },
      { userId: 'user_3', email: 'taken@example.com', consent: { optedIn: true, source: 'api' } },
    ]);
    expect(sent[1]!.body.events.map((e: any) => e.userId)).toEqual(['user_2']);
    expect(result.contacts).toMatchObject({ conflicts: 1, conflicted });
    expect(warnings).toEqual([{ code: 'conflicts', count: 1, message: expect.any(String), conflicted }]);
  });

  it('fixes an event uniqueId when it is queued, without changing the event', async () => {
    const { fetch, sent } = mockFetch(created);
    const agumail = client(fetch, { flushIntervalMs: 0 });
    const randomUUID = vi.spyOn(globalThis.crypto, 'randomUUID');
    const event = { email: 'sam@example.com', event: 'Logged in' };
    agumail.queue.track(event);
    expect(randomUUID).toHaveBeenCalledTimes(1);
    await agumail.flush();
    expect(sent[0]!.body.events[0].uniqueId).toBe(randomUUID.mock.results[0]!.value);
    expect(event).toEqual({ email: 'sam@example.com', event: 'Logged in' });
  });

  it('flushes nothing when nothing is queued', async () => {
    const { fetch, calls } = mockFetch(created);
    expect(await client(fetch).flush()).toEqual(nothing);
    expect(calls()).toBe(0);
  });

  it('flushes on its own once flushAt records are queued, counting a track contact as one', async () => {
    const { fetch, sent } = mockFetch(created);
    const agumail = client(fetch, { flushAt: 3, flushIntervalMs: 0 });
    agumail.queue.identify({ email: 'a@example.com' });
    await tick();
    expect(sent).toHaveLength(0);
    agumail.queue.track({ email: 'b@example.com', event: 'Signed up', contact: { firstName: 'B' } });
    await vi.waitFor(() => expect(sent).toHaveLength(2));
    expect(sent[0]!.body.contacts.map((c: any) => c.email)).toEqual(['a@example.com', 'b@example.com']);
  });

  it('sends a large queue in batches of 500', async () => {
    const { fetch, sent } = mockFetch(created);
    const agumail = client(fetch, { flushIntervalMs: 0 });
    for (let i = 0; i < 501; i++) agumail.queue.identify({ email: `p${i}@example.com` });
    await agumail.flush();
    expect(sent.map((r) => r.body.contacts.length)).toEqual([500, 1]);
  });

  it('flushes flushIntervalMs after the first record is queued', async () => {
    vi.useFakeTimers();
    const { fetch, sent } = mockFetch(created);
    const agumail = client(fetch);
    agumail.queue.identify({ email: 'a@example.com' });
    await vi.advanceTimersByTimeAsync(4_000);
    agumail.queue.identify({ email: 'b@example.com' });
    await vi.advanceTimersByTimeAsync(999);
    expect(sent).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.body.contacts).toHaveLength(2);
    expect(await agumail.flush()).toEqual(nothing);
  });

  it('keeps a timer only while records are queued', async () => {
    vi.useFakeTimers();
    const { fetch, sent } = mockFetch(created);
    const agumail = client(fetch, { flushIntervalMs: 1_000 });
    expect(vi.getTimerCount()).toBe(0);
    agumail.queue.identify({ email: 'a@example.com' });
    agumail.queue.identify({ email: 'b@example.com' });
    expect(vi.getTimerCount()).toBe(1);
    await agumail.flush();
    expect(vi.getTimerCount()).toBe(0);

    agumail.queue.identify({ email: 'c@example.com' });
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(sent).toHaveLength(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('starts no timer with flushIntervalMs: 0', () => {
    vi.useFakeTimers();
    const { fetch } = mockFetch(created);
    client(fetch, { flushIntervalMs: 0 }).queue.identify({ email: 'a@example.com' });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('never lets its timer keep the process alive', async () => {
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    const { fetch } = mockFetch(created);
    const agumail = client(fetch);
    agumail.queue.identify({ email: 'a@example.com' });
    const timer = setTimeoutSpy.mock.results.at(-1)!.value as ReturnType<typeof setTimeout>;
    expect(timer.hasRef()).toBe(false);
    await agumail.flush();
  });

  it('runs flushes one after another, sending each record once', async () => {
    const { fetch, sent, release } = gatedFetch();
    const agumail = client(fetch, { flushIntervalMs: 0 });
    agumail.queue.identify({ email: 'a@example.com' });
    const first = agumail.flush();
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    agumail.queue.identify({ email: 'b@example.com' });
    const second = agumail.flush();
    const third = agumail.flush();
    await tick();
    expect(sent).toHaveLength(1);

    release();
    expect((await first).contacts.created).toBe(1);
    await vi.waitFor(() => expect(sent).toHaveLength(2));
    release();
    expect((await second).contacts.created).toBe(1);
    expect(await third).toEqual(nothing);
    expect(sent.map((r) => r.body.contacts.map((c: any) => c.email))).toEqual([['a@example.com'], ['b@example.com']]);
  });

  it('reports a failure to onError and in the result, and drops those records', async () => {
    const onError = vi.fn();
    const { fetch, sent } = mockFetch(fail(401, 'Invalid or revoked API key.'));
    const agumail = client(fetch, { onError, flushIntervalMs: 0 });
    agumail.queue.identify({ email: 'sam@example.com' });
    agumail.queue.track({ email: 'sam@example.com', event: 'Signed up', uniqueId: 'signup:1' });
    const result = await agumail.flush();
    expect(result.error).toMatchObject({ code: 'unauthorized', uniqueIds: ['signup:1'] });
    expect(result.contacts).toEqual(zeroContacts);
    expect(result.events).toEqual(zeroEvents);
    expect(onError).toHaveBeenCalledWith(result.error);
    // No events after their contacts failed.
    expect(sent.map((r) => r.url.split('/').pop())).toEqual(['contacts']);

    expect(await agumail.flush()).toEqual(nothing);
    expect(sent).toHaveLength(1);
  });

  it('reports what landed before a later batch failed', async () => {
    const onError = vi.fn();
    const { fetch } = mockFetch(eventsOk(500), fail(400, 'bad'));
    const agumail = client(fetch, { onError, flushIntervalMs: 0 });
    for (let i = 0; i < 600; i++) agumail.queue.track({ email: `p${i}@example.com`, event: 'Logged in' });
    await agumail.flush();
    expect(onError).toHaveBeenCalledTimes(1);
    const error = onError.mock.calls[0]![0];
    expect(error).toMatchObject({ code: 'bad_request', partial: { sent: 500, result: { ...zeroEvents, created: 500 } } });
    expect(error.uniqueIds).toHaveLength(600);
  });

  it('retries like any call before giving up', async () => {
    vi.useFakeTimers();
    const { fetch, calls } = mockFetch(fail(503), contactsOk());
    const agumail = client(fetch, { flushIntervalMs: 0 });
    agumail.queue.identify({ email: 'sam@example.com' });
    const result = await settle(agumail.flush());
    expect(result).toEqual({ contacts: { ...zeroContacts, created: 1 }, events: zeroEvents, error: null });
    expect(calls()).toBe(2);
  });

  it('never rejects, even when onError throws', async () => {
    const { fetch } = mockFetch(fail(400));
    const agumail = client(fetch, {
      flushIntervalMs: 0,
      onError: () => {
        throw new Error('logger down');
      },
    });
    agumail.queue.identify({ email: 'sam@example.com' });
    expect((await agumail.flush()).error?.code).toBe('bad_request');
  });

  it('refuses a bad record at once, through onError, and does not queue it', async () => {
    const onError = vi.fn();
    const { fetch, calls } = mockFetch(created);
    const agumail = client(fetch, { onError, flushIntervalMs: 0 });
    expect(() => agumail.queue.identify({ email: 'nope' })).not.toThrow();
    agumail.queue.track({ email: 'sam@example.com', event: 'x', contact: { subscribed: true } as any });
    agumail.queue.track(null as any);
    agumail.queue.identify({ firstName: 'Sam' });
    agumail.queue.track({ event: 'Logged in', userId: '' });
    expect(onError.mock.calls.map(([e]) => [e.code, e.message.split(' ')[0]])).toEqual([
      ['invalid_input', 'contact.email'],
      ['invalid_input', 'event.contact.subscribed'],
      ['invalid_input', 'event'],
      ['invalid_input', 'contact.email'],
      ['invalid_input', 'event.userId'],
    ]);
    expect(await agumail.flush()).toEqual(nothing);
    expect(calls()).toBe(0);
  });

  it('never throws, even with bad settings and no onError', () => {
    const { fetch } = mockFetch(created);
    const onError = vi.fn();
    expect(() => client(fetch, { maxRetries: -1, onError }).queue.identify({ email: 'sam@example.com' })).not.toThrow();
    expect(onError.mock.calls[0]![0].message).toContain('maxRetries');
    expect(() => client(fetch).queue.track({ email: 'nope', event: 'x' })).not.toThrow();
  });

  it('keeps the queue when flush options are wrong', async () => {
    const { fetch, calls } = mockFetch(created);
    const agumail = client(fetch, { flushIntervalMs: 0 });
    agumail.queue.identify({ email: 'sam@example.com' });
    const bad = await agumail.flush({ timeoutMs: -1 });
    expect(bad.error).toMatchObject({ code: 'invalid_input' });
    expect(calls()).toBe(0);
    expect((await agumail.flush()).contacts.created).toBe(1);
  });

  it('stops for your signal', async () => {
    const { fetch, calls } = mockFetch(created);
    const agumail = client(fetch, { flushIntervalMs: 0 });
    agumail.queue.identify({ email: 'sam@example.com' });
    const result = await agumail.flush({ signal: AbortSignal.abort() });
    expect(result.error?.code).toBe('aborted');
    expect(calls()).toBe(0);
  });

  it('fires warnings for what a flush sent, once per flush', async () => {
    const warnings: AguMailWarning[] = [];
    const { fetch } = mockFetch((request) =>
      request.url.endsWith('/events') ? ok({ created: 1, duplicates: 0, unknownContacts: 2 }) : contactsOk()
    );
    const agumail = client(fetch, { flushIntervalMs: 0, onWarning: (w) => void warnings.push(w) });
    const old = new Date(Date.now() - 80 * 60 * 60 * 1000);
    agumail.queue.track({ email: 'a@example.com', event: 'Paid', occurredAt: old });
    agumail.queue.track({ email: 'b@example.com', event: 'Paid', occurredAt: old });
    agumail.queue.track({ email: 'c@example.com', event: 'Paid' });
    await agumail.flush();
    expect(warnings.map((w) => [w.code, w.count])).toEqual([
      ['unknown_contacts', 2],
      ['history', 2],
    ]);
  });
});
