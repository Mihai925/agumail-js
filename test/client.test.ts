import { afterEach, describe, expect, it, vi } from 'vitest';
import { AguMail, noThrow } from '../src/index';
import { client, contactsOk, eventsOk, KEY, mockFetch, ok, rejection } from './helpers';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const zeroContacts = { created: 0, updated: 0, suppressedSkipped: 0, overCapacity: 0 };
const zeroEvents = { created: 0, duplicates: 0, unknownContacts: 0 };

describe('methods taken off the client', () => {
  it('work like the calls on the client', async () => {
    const { fetch, sent } = mockFetch((request) =>
      request.url.endsWith('/events') ? eventsOk() : request.url.endsWith('/ping') ? ok({ shop: { userId: 'u_1' } }) : contactsOk()
    );
    const { identify, identifyMany, track, trackMany, ping, flush, queue } = client(fetch, { flushIntervalMs: 0 });
    expect(await identify({ email: 'sam@example.com' })).toMatchObject({ created: 1 });
    expect(await identifyMany([{ email: 'sam@example.com' }])).toMatchObject({ created: 1 });
    expect(await track({ email: 'sam@example.com', event: 'Logged in' })).toMatchObject({ created: 1 });
    expect(await trackMany([{ email: 'sam@example.com', event: 'Logged in' }])).toMatchObject({ created: 1 });
    expect(await ping()).toEqual({ shop: { userId: 'u_1', shopName: null } });
    queue.identify({ email: 'alex@example.com' });
    expect((await flush()).contacts.created).toBe(1);
    expect(sent).toHaveLength(6);
  });

  it('never throw with throwOnError: false, even with no key', async () => {
    const { fetch, calls } = mockFetch(contactsOk());
    const { identify, track, ping } = new AguMail(undefined, { fetch });
    const results = await Promise.all([
      identify({ email: 'sam@example.com' }, noThrow),
      track({ email: 'sam@example.com', event: 'x' }, { throwOnError: false }),
      ping(noThrow),
    ]);
    expect(results.map((r) => r.error?.code)).toEqual(['missing_api_key', 'missing_api_key', 'missing_api_key']);
    expect(calls()).toBe(0);
  });
});

describe('noThrow', () => {
  it('makes a call resolve to { data, error }', async () => {
    const { fetch } = mockFetch(contactsOk());
    expect(await client(fetch).identify({ email: 'sam@example.com' }, noThrow)).toEqual({
      data: { created: 1, updated: 0, suppressedSkipped: 0, overCapacity: 0 },
      error: null,
    });
    expect(Object.isFrozen(noThrow)).toBe(true);
  });
});

describe('disabled: true', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const disabled = () => {
    const mock = mockFetch(contactsOk());
    return { ...mock, agumail: new AguMail(undefined, { fetch: mock.fetch, disabled: true }) };
  };

  it('sends nothing and needs no key, resolving every call with empty results', async () => {
    const { agumail, calls } = disabled();
    expect(await agumail.identify({ email: 'sam@example.com' })).toEqual(zeroContacts);
    expect(await agumail.identifyMany([{ email: 'sam@example.com' }, { email: 'alex@example.com' }])).toEqual(zeroContacts);
    expect(await agumail.contacts.subscribe('sam@example.com')).toEqual(zeroContacts);
    expect(await agumail.contacts.unsubscribe(['sam@example.com'])).toEqual(zeroContacts);
    expect(await agumail.signups.create({ email: 'sam@example.com', doubleOptIn: true, form: { id: 'f' } })).toEqual({
      received: 0,
      overCapacity: 0,
      limited: 0,
    });
    expect(await agumail.forms.list()).toEqual({ loaderUrl: '', forms: [] });
    expect(await agumail.ping()).toEqual({ shop: { userId: '', shopName: null } });
    expect(calls()).toBe(0);
  });

  it('still generates uniqueIds', async () => {
    const { agumail } = disabled();
    const one = await agumail.track({ email: 'sam@example.com', event: 'Logged in', contact: { firstName: 'Sam' } });
    expect(one).toEqual({ ...zeroEvents, uniqueId: expect.stringMatching(UUID), contact: zeroContacts });
    const many = await agumail.trackMany([
      { email: 'sam@example.com', event: 'Logged in' },
      { email: 'sam@example.com', event: 'Logged in', uniqueId: 'login:2' },
    ]);
    expect(many).toEqual({ ...zeroEvents, uniqueIds: [expect.stringMatching(UUID), 'login:2'] });
  });

  it('answers every address as not on your list', async () => {
    const { agumail } = disabled();
    expect(await agumail.contacts.status('sam@example.com')).toEqual({ email: 'sam@example.com', status: null, subscribed: false });
    expect(await agumail.contacts.status(['a@example.com', 'b@example.com'])).toEqual([
      { email: 'a@example.com', status: null, subscribed: false },
      { email: 'b@example.com', status: null, subscribed: false },
    ]);
  });

  it('still refuses bad records, bad call options and bad settings', async () => {
    const { agumail } = disabled();
    expect((await rejection(agumail.identify({ email: 'nope' }))).code).toBe('invalid_input');
    expect((await rejection(agumail.track({ email: 'sam@example.com', event: '' }))).message).toContain('event.event');
    expect((await rejection(agumail.ping({ timeoutMs: -1 }))).message).toContain('timeoutMs');
    const misconfigured = new AguMail(undefined, { disabled: true, maxRetries: -1 });
    expect((await rejection(misconfigured.ping())).message).toContain('maxRetries');
    const badUrl = new AguMail(undefined, { disabled: true, baseUrl: 'agumail' });
    expect((await rejection(badUrl.ping())).message).toContain('baseUrl');
  });

  it('accepts queued records and flushes them as zero counts', async () => {
    const onError = vi.fn();
    const { calls } = mockFetch();
    const agumail = new AguMail(undefined, { disabled: true, onError, flushIntervalMs: 0 });
    agumail.queue.identify({ email: 'sam@example.com' });
    agumail.queue.track({ email: 'sam@example.com', event: 'Logged in', contact: { firstName: 'Sam' } });
    agumail.queue.identify({ email: 'nope' });
    expect(await agumail.flush()).toEqual({ contacts: zeroContacts, events: zeroEvents, error: null });
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]![0]).toMatchObject({ code: 'invalid_input' });
    expect(calls()).toBe(0);
  });

  it('fires no warnings', async () => {
    const onWarning = vi.fn();
    const agumail = new AguMail(undefined, { disabled: true, onWarning });
    await agumail.track({ email: 'sam@example.com', event: 'Logged in', occurredAt: '2020-01-01T00:00:00Z' });
    expect(onWarning).not.toHaveBeenCalled();
  });

  it('still refuses to run in a browser', () => {
    vi.stubGlobal('window', {});
    vi.stubGlobal('document', {});
    expect(() => new AguMail(KEY, { disabled: true })).toThrow(/server only/);
  });
});
