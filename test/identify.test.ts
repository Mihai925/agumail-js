import { describe, expect, it } from 'vitest';
import { client, contactsOk, fail, KEY, mockFetch, ok, rejection } from './helpers';

describe('identify', () => {
  it('posts one contact, subscribed by default with source api', async () => {
    const { fetch, sent } = mockFetch(contactsOk());
    const result = await client(fetch).identify({ email: 'sam@example.com', firstName: 'Sam', lastName: 'Rivera' });

    expect(result).toEqual({ created: 1, updated: 0, suppressedSkipped: 0, overCapacity: 0 });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toBe('https://api.agumail.com/api/v1/contacts');
    expect(sent[0]!.method).toBe('POST');
    expect(sent[0]!.headers).toMatchObject({ Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' });
    expect(sent[0]!.body).toEqual({
      contacts: [
        { email: 'sam@example.com', firstName: 'Sam', lastName: 'Rivera', consent: { optedIn: true, source: 'api' } },
      ],
    });
  });

  it('sends optedIn false for subscribed: false', async () => {
    const { fetch, sent } = mockFetch(contactsOk());
    await client(fetch).identify({ email: 'sam@example.com', subscribed: false });
    expect(sent[0]!.body.contacts[0].consent).toEqual({ optedIn: false, source: 'api' });
  });

  it('sends every contact field the API knows', async () => {
    const { fetch, sent } = mockFetch(contactsOk());
    await client(fetch).identify({
      email: '  sam@example.com ',
      firstName: 'Sam',
      lastName: 'Rivera',
      phone: '+351 900 000 000',
      timezone: 'Europe/Lisbon',
      tags: ['Trial', 'Founder'],
      properties: { plan: 'pro' },
      customerSince: new Date('2024-03-02T09:00:00Z'),
    });
    expect(sent[0]!.body.contacts[0]).toEqual({
      email: 'sam@example.com',
      firstName: 'Sam',
      lastName: 'Rivera',
      phone: '+351 900 000 000',
      timezone: 'Europe/Lisbon',
      tags: ['Trial', 'Founder'],
      customFields: { plan: 'pro' },
      customerSince: '2024-03-02T09:00:00.000Z',
      consent: { optedIn: true, source: 'api' },
    });
  });

  it('passes the counts only some servers send through, when they send them', async () => {
    const { fetch } = mockFetch(
      ok({
        created: 0,
        updated: 1,
        suppressedSkipped: 0,
        overCapacity: 0,
        confirmationsSent: 1,
        unknownContacts: 0,
        conflicts: 1,
        conflicted: [{ index: 0, userId: 'user_77', email: 'alex@example.com', reason: 'email_taken' }],
      })
    );
    const result = await client(fetch).identify({ email: 'alex@example.com', userId: 'user_77' });
    expect(result).toEqual({
      created: 0,
      updated: 1,
      suppressedSkipped: 0,
      overCapacity: 0,
      confirmationsSent: 1,
      unknownContacts: 0,
      conflicts: 1,
      conflicted: [{ index: 0, userId: 'user_77', email: 'alex@example.com', reason: 'email_taken' }],
    });
  });

  it('sends your userId beside the email', async () => {
    const { fetch, sent } = mockFetch(contactsOk());
    await client(fetch).identify({ email: 'sam@example.com', userId: 'user_8412', firstName: 'Sam' });
    expect(sent[0]!.body.contacts[0]).toEqual({
      email: 'sam@example.com',
      userId: 'user_8412',
      firstName: 'Sam',
      consent: { optedIn: true, source: 'api' },
    });
  });

  it('takes a userId in place of the email', async () => {
    const { fetch, sent } = mockFetch(contactsOk());
    await client(fetch).identify({ userId: 'user_8412', properties: { plan: 'pro' } });
    expect(sent[0]!.body.contacts[0]).toEqual({
      userId: 'user_8412',
      customFields: { plan: 'pro' },
      consent: { optedIn: true, source: 'api' },
    });
  });

  it('sends a whole-number userId as text, and any other exactly as given', async () => {
    const { fetch, sent } = mockFetch(contactsOk());
    await client(fetch).identifyMany([{ userId: 8412 }, { userId: ' User_8412 ' }, { userId: 0, email: null }]);
    expect(sent[0]!.body.contacts.map((c: any) => c.userId)).toEqual(['8412', ' User_8412 ', '0']);
  });

  it('leaves out fields given as null', async () => {
    const { fetch, sent } = mockFetch(contactsOk());
    await client(fetch).identify({ email: 'sam@example.com', firstName: null, phone: null, tags: null, properties: null });
    expect(sent[0]!.body.contacts[0]).toEqual({ email: 'sam@example.com', consent: { optedIn: true, source: 'api' } });
  });
});

describe('contact properties', () => {
  it('converts numbers, booleans and Dates to text, blanks null, skips undefined', async () => {
    const { fetch, sent } = mockFetch(contactsOk());
    await client(fetch).identify({
      email: 'sam@example.com',
      properties: {
        plan: 'pro',
        seats: 3,
        price: 9.5,
        trial: true,
        churned: false,
        trialEndsAt: new Date('2026-11-01T00:00:00Z'),
        company: null,
        nickname: undefined,
      },
    });
    expect(sent[0]!.body.contacts[0].customFields).toEqual({
      plan: 'pro',
      seats: '3',
      price: '9.5',
      trial: 'true',
      churned: 'false',
      trialEndsAt: '2026-11-01T00:00:00.000Z',
      company: '',
    });
  });

  it('allows exactly 30 properties, 60-character names and 500-character values', async () => {
    const { fetch, calls } = mockFetch(contactsOk());
    const properties: Record<string, string> = {};
    for (let i = 0; i < 29; i++) properties[`field${i}`] = 'x';
    properties['k'.repeat(60)] = 'v'.repeat(500);
    await client(fetch).identify({ email: 'sam@example.com', properties });
    expect(calls()).toBe(1);
  });

  it.each([
    ['more than 30 properties', Object.fromEntries(Array.from({ length: 31 }, (_, i) => [`f${i}`, 'x'])), 'at most 30 properties'],
    ['a name over 60 characters', { ['k'.repeat(61)]: 'x' }, 'at most 60 characters'],
    ['a value over 500 characters', { bio: 'v'.repeat(501) }, 'at most 500 characters'],
    ['an array', { list: ['a', 'b'] }, 'use JSON.stringify for a structure, or tags'],
    ['an object', { address: { city: 'Porto' } }, 'must be text, a number, a boolean or a Date'],
    ['NaN', { score: Number.NaN }, 'finite number'],
    ['Infinity', { score: Number.POSITIVE_INFINITY }, 'finite number'],
    ['an invalid Date', { at: new Date('nope') }, 'invalid Date'],
  ])('refuses %s before sending anything', async (_label, properties, message) => {
    const { fetch, calls } = mockFetch(contactsOk());
    const error = await rejection(client(fetch).identify({ email: 'sam@example.com', properties: properties as any }));
    expect(error.code).toBe('invalid_input');
    expect(error.status).toBeNull();
    expect(error.message).toContain(message);
    expect(error.message).toContain('contact.properties');
    expect(calls()).toBe(0);
  });

  it('counts properties after dropping undefined ones', async () => {
    const { fetch, calls } = mockFetch(contactsOk());
    const properties: Record<string, string | undefined> = {};
    for (let i = 0; i < 30; i++) properties[`f${i}`] = 'x';
    properties.extra = undefined;
    await client(fetch).identify({ email: 'sam@example.com', properties });
    expect(calls()).toBe(1);
  });
});

describe('contact checks', () => {
  it.each([
    ['a malformed email', { email: 'sam@' }, 'contact.email is not an email address'],
    ['no email and no userId', {}, 'contact.email is required when there is no userId'],
    ['a null email and a null userId', { email: null, userId: null }, 'contact.email is required when there is no userId'],
    ['an email that is not text', { email: 42 }, 'contact.email must be an email address'],
    ['a malformed email beside a userId', { email: 'sam@', userId: 'user_1' }, 'contact.email is not an email address'],
    ['an empty userId', { userId: '' }, 'contact.userId cannot be blank'],
    ['a blank userId', { email: 'sam@example.com', userId: '  ' }, 'contact.userId cannot be blank'],
    ['a userId over 200 characters', { userId: 'u'.repeat(201) }, 'contact.userId can be at most 200 characters'],
    ['a userId that is not a whole number', { userId: 84.5 }, 'contact.userId must be text or a whole number'],
    ['a userId too big to be exact', { userId: 2 ** 60 }, 'contact.userId is too big to be exact as a number'],
    ['a userId that is an object', { userId: { id: 1 } }, 'contact.userId must be text or a whole number'],
    ['an unknown field', { email: 'sam@example.com', name: 'Sam' }, 'contact.name is not a field AguMail knows. Use firstName'],
    ['customFields instead of properties', { email: 'sam@example.com', customFields: {} }, 'Use properties'],
    ['a first name over 100 characters', { email: 'sam@example.com', firstName: 'a'.repeat(101) }, 'at most 100'],
    ['a phone over 40 characters', { email: 'sam@example.com', phone: '1'.repeat(41) }, 'at most 40'],
    ['an unknown time zone', { email: 'sam@example.com', timezone: 'Mars/Olympus' }, 'not a time zone'],
    ['more than 20 tags', { email: 'sam@example.com', tags: Array.from({ length: 21 }, (_, i) => `t${i}`) }, 'at most 20 tags'],
    ['a tag over 60 characters', { email: 'sam@example.com', tags: ['t'.repeat(61)] }, 'contact.tags[0]'],
    ['an empty tag', { email: 'sam@example.com', tags: [' '] }, 'must be a tag name'],
    ['an unreadable customerSince', { email: 'sam@example.com', customerSince: 'last spring' }, 'not a date AguMail can read'],
    ['a non-boolean subscribed', { email: 'sam@example.com', subscribed: 'no' }, 'subscribed must be true or false'],
  ])('refuses %s', async (_label, contact, message) => {
    const { fetch, calls } = mockFetch(contactsOk());
    const error = await rejection(client(fetch).identify(contact as any));
    expect(error.code).toBe('invalid_input');
    expect(error.message).toContain(message);
    expect(calls()).toBe(0);
  });

  it('does not change the object it was given', async () => {
    const { fetch } = mockFetch(contactsOk());
    const contact = { email: ' sam@example.com', properties: { seats: 3 } };
    const copy = structuredClone(contact);
    await client(fetch).identify(contact);
    expect(contact).toEqual(copy);
  });
});

describe('identifyMany', () => {
  const people = (n: number) => Array.from({ length: n }, (_, i) => ({ email: `person${i}@example.com` }));

  it('sends batches of 500 and adds up the counts', async () => {
    const { fetch, sent } = mockFetch((request) =>
      ok({ created: request.body.contacts.length, updated: 1, suppressedSkipped: 2, overCapacity: 0 })
    );
    const result = await client(fetch).identifyMany(people(1201));
    expect(sent.map((r) => r.body.contacts.length)).toEqual([500, 500, 201]);
    expect(sent[2]!.body.contacts[200].email).toBe('person1200@example.com');
    expect(result).toEqual({ created: 1201, updated: 3, suppressedSkipped: 6, overCapacity: 0 });
  });

  it('adds up conflicts and unknown user ids over batches, numbering each conflict by your array', async () => {
    const { fetch } = mockFetch((request) => {
      const batch = request.body.contacts;
      return ok({
        created: batch.length - 2,
        updated: 0,
        suppressedSkipped: 0,
        overCapacity: 0,
        unknownContacts: 1,
        conflicts: 1,
        conflicted: [{ index: 3, userId: batch[3].userId, email: batch[3].email, reason: 'user_id_mismatch' }],
      });
    });
    const users = Array.from({ length: 1201 }, (_, i) => ({ email: `person${i}@example.com`, userId: `user_${i}` }));
    const result = await client(fetch).identifyMany(users);
    expect(result).toEqual({
      created: 1195,
      updated: 0,
      suppressedSkipped: 0,
      overCapacity: 0,
      unknownContacts: 3,
      conflicts: 3,
      conflicted: [3, 503, 1003].map((i) => ({
        index: i,
        userId: `user_${i}`,
        email: `person${i}@example.com`,
        reason: 'user_id_mismatch',
      })),
    });
  });

  it('numbers conflicts by your array when it puts conflicts on a partial result', async () => {
    const { fetch } = mockFetch(
      ok({
        created: 499,
        updated: 0,
        suppressedSkipped: 0,
        overCapacity: 0,
        unknownContacts: 0,
        conflicts: 1,
        conflicted: [{ index: 7, userId: 'user_7', email: null, reason: 'email_taken' }],
      }),
      ok({
        created: 99,
        updated: 0,
        suppressedSkipped: 0,
        overCapacity: 0,
        unknownContacts: 0,
        conflicts: 1,
        conflicted: [{ index: 2, userId: 'user_502', email: null, reason: 'email_taken' }],
      }),
      fail(400, 'bad')
    );
    const users = Array.from({ length: 1100 }, (_, i) => ({ userId: `user_${i}` }));
    const error = await rejection(client(fetch).identifyMany(users));
    expect(error.partial.sent).toBe(1000);
    expect(error.partial.result.conflicted.map((c: any) => c.index)).toEqual([7, 502]);
  });

  it('marks every batch as history with backfill: true', async () => {
    const { fetch, sent } = mockFetch(contactsOk());
    await client(fetch).identifyMany(people(501), { backfill: true });
    expect(sent.map((r) => r.body.backfill)).toEqual([true, true]);
  });

  it('leaves the flag out without backfill', async () => {
    const { fetch, sent } = mockFetch(contactsOk());
    await client(fetch).identifyMany(people(2));
    expect(sent[0]!.body).not.toHaveProperty('backfill');
  });

  it('sends nothing for an empty list', async () => {
    const { fetch, calls } = mockFetch(contactsOk());
    expect(await client(fetch).identifyMany([])).toEqual({ created: 0, updated: 0, suppressedSkipped: 0, overCapacity: 0 });
    expect(calls()).toBe(0);
  });

  it('sends nothing when any record is bad, and names it', async () => {
    const { fetch, calls } = mockFetch(contactsOk());
    const list = people(1000);
    list[700] = { email: 'not-an-email' };
    const error = await rejection(client(fetch).identifyMany(list));
    expect(error.message).toContain('contacts[700].email');
    expect(calls()).toBe(0);
  });

  it('reports what landed when a later batch fails', async () => {
    const { fetch } = mockFetch(contactsOk(500), fail(400, 'contacts.3.email: Invalid email'));
    const error = await rejection(client(fetch).identifyMany(people(900)));
    expect(error.status).toBe(400);
    expect(error.code).toBe('bad_request');
    expect(error.message).toBe('contacts.3.email: Invalid email');
    expect(error.partial).toEqual({ sent: 500, result: { created: 500, updated: 0, suppressedSkipped: 0, overCapacity: 0 } });
  });

  it('splits batches that would pass the server body limit', async () => {
    const { fetch, sent } = mockFetch(contactsOk());
    const big = Array.from({ length: 500 }, (_, i) => ({
      email: `person${i}@example.com`,
      properties: Object.fromEntries(Array.from({ length: 30 }, (_, k) => [`field${k}`, 'é'.repeat(500)])),
    }));
    await client(fetch).identifyMany(big);
    expect(sent.length).toBeGreaterThan(1);
    for (const request of sent) expect(new TextEncoder().encode(JSON.stringify(request.body)).length).toBeLessThan(5 * 1024 * 1024);
    expect(sent.reduce((n, r) => n + r.body.contacts.length, 0)).toBe(500);
  });

  it('takes a frozen array, with frozen tags', async () => {
    const { fetch, sent } = mockFetch(contactsOk());
    await client(fetch).identifyMany(Object.freeze([{ email: 'sam@example.com', tags: Object.freeze(['Trial']) }]));
    expect(sent[0]!.body.contacts[0].tags).toEqual(['Trial']);
  });

  it('refuses something that is not an array', async () => {
    const { fetch } = mockFetch(contactsOk());
    const error = await rejection(client(fetch).identifyMany({ email: 'sam@example.com' } as any));
    expect(error.message).toContain('contacts must be an array');
  });
});
