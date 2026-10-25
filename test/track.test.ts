import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { client, contactsOk, eventsOk, fail, mockFetch, ok, rejection, settle } from './helpers';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('track', () => {
  it('posts one event, with event sent as metric', async () => {
    const { fetch, sent } = mockFetch(eventsOk());
    const result = await client(fetch).track({
      email: 'sam@example.com',
      event: 'Created first campaign',
      properties: { campaignId: 'c_1', blocks: [{ type: 'text' }] },
      value: 49,
      occurredAt: new Date('2026-10-24T10:15:00Z'),
      uniqueId: 'campaign_created:c_1',
    });
    expect(sent[0]!.url).toBe('https://api.agumail.com/api/v1/events');
    expect(sent[0]!.body).toEqual({
      events: [
        {
          email: 'sam@example.com',
          metric: 'Created first campaign',
          uniqueId: 'campaign_created:c_1',
          occurredAt: '2026-10-24T10:15:00.000Z',
          value: 49,
          properties: { campaignId: 'c_1', blocks: [{ type: 'text' }] },
        },
      ],
    });
    expect(result).toEqual({ created: 1, duplicates: 0, unknownContacts: 0, uniqueId: 'campaign_created:c_1' });
  });

  it('generates a uniqueId when there is none, and returns it', async () => {
    const { fetch, sent } = mockFetch(eventsOk());
    const result = await client(fetch).track({ email: 'sam@example.com', event: 'Logged in' });
    expect(result.uniqueId).toMatch(UUID);
    expect(sent[0]!.body.events[0].uniqueId).toBe(result.uniqueId);
  });

  it('never sends consent, and does not touch contacts without contact fields', async () => {
    const { fetch, sent } = mockFetch(eventsOk());
    await client(fetch).track({ email: 'sam@example.com', event: 'Logged in' });
    expect(sent).toHaveLength(1);
    expect(JSON.stringify(sent[0]!.body)).not.toContain('consent');
  });

  it('upserts the contact first, with no consent, when contact fields are given', async () => {
    const { fetch, sent } = mockFetch(contactsOk(), eventsOk());
    const result = await client(fetch).track({
      email: 'sam@example.com',
      event: 'Upgraded',
      contact: { firstName: 'Sam', properties: { plan: 'pro', seats: 5 } },
    });
    expect(sent.map((r) => r.url)).toEqual([
      'https://api.agumail.com/api/v1/contacts',
      'https://api.agumail.com/api/v1/events',
    ]);
    expect(sent[0]!.body).toEqual({
      contacts: [{ email: 'sam@example.com', firstName: 'Sam', customFields: { plan: 'pro', seats: '5' } }],
    });
    expect(result.contact).toEqual({ created: 1, updated: 0, suppressedSkipped: 0, overCapacity: 0 });
  });

  it('refuses subscribed inside contact: track never changes a subscription', async () => {
    const { fetch, calls } = mockFetch(eventsOk());
    const error = await rejection(
      client(fetch).track({ email: 'sam@example.com', event: 'Upgraded', contact: { subscribed: true } as any })
    );
    expect(error.message).toContain('event.contact.subscribed is not a field');
    expect(calls()).toBe(0);
  });

  it('reports unknown contacts as the server counts them', async () => {
    const { fetch } = mockFetch(ok({ created: 0, duplicates: 0, unknownContacts: 1 }));
    const result = await client(fetch).track({ email: 'nobody@example.com', event: 'Logged in' });
    expect(result.unknownContacts).toBe(1);
  });

  it('does not change the event it was given', async () => {
    const { fetch } = mockFetch(eventsOk());
    const event = { email: 'sam@example.com', event: 'Logged in', properties: { at: new Date(0) } };
    await client(fetch).track(event);
    expect(event).not.toHaveProperty('uniqueId');
    expect(event.properties.at).toBeInstanceOf(Date);
  });

  it.each([
    ['metric instead of event', { email: 'sam@example.com', metric: 'Logged in' }, 'event.metric is not a field AguMail knows. Use event.'],
    ['eventName instead of event', { email: 'sam@example.com', eventName: 'Logged in' }, 'event.eventName is not a field AguMail knows. Use event.'],
    ['event_name instead of event', { email: 'sam@example.com', event_name: 'Logged in' }, 'event.event_name is not a field AguMail knows. Use event.'],
    ['a missing event', { email: 'sam@example.com' }, 'event.event is required'],
    ['an event name over 60 characters', { email: 'sam@example.com', event: 'e'.repeat(61) }, 'at most 60'],
    ['an event name with no letters or digits', { email: 'sam@example.com', event: '!!!' }, 'at least one letter or digit'],
    ['a uniqueId over 120 characters', { email: 'sam@example.com', event: 'x', uniqueId: 'u'.repeat(121) }, 'at most 120'],
    ['an empty uniqueId', { email: 'sam@example.com', event: 'x', uniqueId: '' }, 'event.uniqueId is required'],
    ['a value that is not a number', { email: 'sam@example.com', event: 'x', value: '49' }, 'value must be a finite number'],
    ['an unreadable occurredAt', { email: 'sam@example.com', event: 'x', occurredAt: 'yesterday-ish' }, 'not a date AguMail can read'],
    [
      'more than 30 properties',
      { email: 'sam@example.com', event: 'x', properties: Object.fromEntries(Array.from({ length: 31 }, (_, i) => [`p${i}`, i])) },
      'at most 30 properties',
    ],
    ['properties over 8000 characters', { email: 'sam@example.com', event: 'x', properties: { blob: 'b'.repeat(8000) } }, 'at most 8000 characters'],
    ['properties that are not JSON', { email: 'sam@example.com', event: 'x', properties: { n: BigInt(1) } }, 'cannot be sent as JSON'],
    ['properties that are an array', { email: 'sam@example.com', event: 'x', properties: [1, 2] }, 'must be an object'],
  ])('refuses %s', async (_label, event, message) => {
    const { fetch, calls } = mockFetch(eventsOk());
    const error = await rejection(client(fetch).track(event as any));
    expect(error.code).toBe('invalid_input');
    expect(error.message).toContain(message);
    expect(calls()).toBe(0);
  });
});

describe('uniqueIds after a failure', () => {
  it('puts the id track sent on the error', async () => {
    const { fetch, sent } = mockFetch(fail(400, 'events.0.email: Invalid email'));
    const error = await rejection(client(fetch).track({ email: 'sam@example.com', event: 'Logged in' }));
    expect(error.uniqueIds).toEqual([sent[0]!.body.events[0].uniqueId]);
    expect(error.uniqueIds[0]).toMatch(UUID);
  });

  it('puts them on the error of a quiet call too, and when the contact upsert fails first', async () => {
    const { fetch, sent } = mockFetch(fail(401, 'Invalid or revoked API key.'));
    const result = await client(fetch).track(
      { email: 'sam@example.com', event: 'Logged in', uniqueId: 'login:1', contact: { firstName: 'Sam' } },
      { throwOnError: false }
    );
    expect(sent.map((r) => r.url.split('/').pop())).toEqual(['contacts']);
    expect(result.error?.uniqueIds).toEqual(['login:1']);
  });

  it('lines trackMany ids up with the events passed in, yours and generated alike', async () => {
    const { fetch, sent } = mockFetch(eventsOk(500), fail(503));
    const events = Array.from({ length: 700 }, (_, i) => ({
      email: `p${i}@example.com`,
      event: 'Logged in',
      ...(i % 3 === 0 ? { uniqueId: `login:${i}` } : {}),
    }));
    const error = await rejection(client(fetch, { maxRetries: 0 }).trackMany(events));
    expect(error.uniqueIds).toHaveLength(700);
    expect(error.uniqueIds[0]).toBe('login:0');
    expect(error.uniqueIds[3]).toBe('login:3');
    expect(error.uniqueIds[1]).toMatch(UUID);
    expect(error.uniqueIds).toEqual(sent.flatMap((r) => r.body.events.map((e: any) => e.uniqueId)));
    expect(error.partial).toEqual({ sent: 500, result: { created: 500, duplicates: 0, unknownContacts: 0 } });
  });

  it('lets a failed trackMany be sent again with the same ids', async () => {
    const { fetch, sent } = mockFetch(fail(400, 'bad'), eventsOk(2));
    const agumail = client(fetch);
    const events = [
      { email: 'a@example.com', event: 'Imported' },
      { email: 'b@example.com', event: 'Imported' },
    ];
    const first = await agumail.trackMany(events, { throwOnError: false });
    const ids = first.error!.uniqueIds!;
    const again = await agumail.trackMany(events.map((e, i) => ({ ...e, uniqueId: ids[i] })));
    expect(again.uniqueIds).toEqual(ids);
    expect(sent[1]!.body.events.map((e: any) => e.uniqueId)).toEqual(sent[0]!.body.events.map((e: any) => e.uniqueId));
  });

  it('are not set when a record is refused before anything is sent', async () => {
    const { fetch } = mockFetch(eventsOk());
    const error = await rejection(client(fetch).trackMany([{ email: 'nope', event: 'x' }]));
    expect(error.code).toBe('invalid_input');
    expect(error.uniqueIds).toBeUndefined();
  });
});

describe('uniqueId across retries', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps the generated id on every retry of the same event', async () => {
    const { fetch, sent } = mockFetch(fail(503), new TypeError('fetch failed'), 'hang', eventsOk());
    const result = await settle(client(fetch).track({ email: 'sam@example.com', event: 'Logged in' }));
    expect(sent).toHaveLength(4);
    const ids = sent.map((r) => r.body.events[0].uniqueId);
    expect(new Set(ids).size).toBe(1);
    expect(ids[0]).toBe(result.uniqueId);
  });

  it('keeps every generated id of a batch on its retry', async () => {
    const { fetch, sent } = mockFetch(fail(500), eventsOk(3));
    const events = [1, 2, 3].map((n) => ({ email: `p${n}@example.com`, event: 'Logged in' }));
    await settle(client(fetch).trackMany(events));
    const first = sent[0]!.body.events.map((e: any) => e.uniqueId);
    const retry = sent[1]!.body.events.map((e: any) => e.uniqueId);
    expect(retry).toEqual(first);
    expect(new Set(first).size).toBe(3);
  });
});

describe('trackMany', () => {
  it('sends batches of 500 and adds up the counts', async () => {
    const { fetch, sent } = mockFetch((request) => ok({ created: request.body.events.length - 1, duplicates: 1, unknownContacts: 0 }));
    const events = Array.from({ length: 1001 }, (_, i) => ({ email: `p${i}@example.com`, event: 'Logged in' }));
    const result = await client(fetch).trackMany(events);
    expect(sent.map((r) => r.body.events.length)).toEqual([500, 500, 1]);
    expect(result).toEqual({ created: 998, duplicates: 3, unknownContacts: 0, uniqueIds: expect.any(Array) });
    expect(result.uniqueIds).toEqual(sent.flatMap((r) => r.body.events.map((e: any) => e.uniqueId)));
  });

  it('upserts each batch of contacts before its events, passing backfill to both', async () => {
    const { fetch, sent } = mockFetch((request) => (request.url.endsWith('/contacts') ? contactsOk(1) : eventsOk(1)));
    const events = Array.from({ length: 600 }, (_, i) => ({
      email: `p${i}@example.com`,
      event: 'Signed up',
      occurredAt: '2024-01-01T00:00:00Z',
      ...(i % 2 === 0 ? { contact: { firstName: `P${i}` } } : {}),
    }));
    const result = await client(fetch).trackMany(events, { backfill: true });
    expect(sent.map((r) => [r.url.split('/').pop(), (r.body.contacts ?? r.body.events).length])).toEqual([
      ['contacts', 250],
      ['events', 500],
      ['contacts', 50],
      ['events', 100],
    ]);
    expect(sent.every((r) => r.body.backfill === true)).toBe(true);
    expect(sent.every((r) => !JSON.stringify(r.body).includes('consent'))).toBe(true);
    expect(result.contacts).toEqual({ created: 2, updated: 0, suppressedSkipped: 0, overCapacity: 0 });
  });

  it('gives every event its own generated id, and returns them in order', async () => {
    const { fetch, sent } = mockFetch(eventsOk());
    const events = Array.from({ length: 50 }, (_, i) => ({
      email: 'sam@example.com',
      event: 'Viewed report',
      ...(i === 7 ? { uniqueId: 'report:7' } : {}),
    }));
    const result = await client(fetch).trackMany(events);
    expect(new Set(sent[0]!.body.events.map((e: any) => e.uniqueId)).size).toBe(50);
    expect(result.uniqueIds).toEqual(sent[0]!.body.events.map((e: any) => e.uniqueId));
    expect(result.uniqueIds[7]).toBe('report:7');
  });

  it('sends nothing for an empty list', async () => {
    const { fetch, calls } = mockFetch(eventsOk());
    expect(await client(fetch).trackMany([])).toEqual({ created: 0, duplicates: 0, unknownContacts: 0, uniqueIds: [] });
    expect(calls()).toBe(0);
  });

  it('sends no events when the contacts before them fail, and reports nothing as landed', async () => {
    const { fetch, sent } = mockFetch(fail(400, 'contacts.0.email: Invalid email'));
    const events = [{ email: 'sam@example.com', event: 'Logged in', contact: { firstName: 'Sam' } }];
    const error = await rejection(client(fetch).trackMany(events));
    expect(sent.map((r) => r.url.split('/').pop())).toEqual(['contacts']);
    expect(error.partial).toBeUndefined();
  });

  it('reports what landed when a later batch fails', async () => {
    const { fetch } = mockFetch(eventsOk(500), fail(401, 'Invalid or revoked API key.'));
    const events = Array.from({ length: 700 }, (_, i) => ({ email: `p${i}@example.com`, event: 'Logged in' }));
    const error = await rejection(client(fetch).trackMany(events));
    expect(error.code).toBe('unauthorized');
    expect(error.partial).toEqual({ sent: 500, result: { created: 500, duplicates: 0, unknownContacts: 0 } });
  });
});
