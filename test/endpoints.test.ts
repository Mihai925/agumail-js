import { describe, expect, it } from 'vitest';
import { client, contactsOk, mockFetch, ok, rejection } from './helpers';

describe('contacts.status', () => {
  it('asks in batches of 500 and keeps the order asked', async () => {
    const { fetch, sent } = mockFetch((request) =>
      ok({
        contacts: request.body.emails.map((email: string, i: number) => ({
          email,
          status: i % 2 ? 'active' : null,
          subscribed: i % 2 === 1,
        })),
      })
    );
    const emails = Array.from({ length: 1001 }, (_, i) => `p${i}@example.com`);
    const answers = await client(fetch).contacts.status(emails);
    expect(sent.map((r) => [r.url, r.body.emails.length])).toEqual([
      ['https://api.agumail.com/api/v1/contacts/status', 500],
      ['https://api.agumail.com/api/v1/contacts/status', 500],
      ['https://api.agumail.com/api/v1/contacts/status', 1],
    ]);
    expect(answers.map((a) => a.email)).toEqual(emails);
    expect(answers[1]).toEqual({ email: 'p1@example.com', userId: null, status: 'active', subscribed: true });
    expect(answers[0]).toEqual({ email: 'p0@example.com', userId: null, status: null, subscribed: false });
  });

  it('sends nothing for no addresses', async () => {
    const { fetch, calls } = mockFetch(ok());
    expect(await client(fetch).contacts.status([])).toEqual([]);
    expect(calls()).toBe(0);
  });

  it('answers one address with one status', async () => {
    const { fetch, sent } = mockFetch(ok({ contacts: [{ email: 'sam@example.com', status: 'active', subscribed: true }] }));
    const answer = await client(fetch).contacts.status('sam@example.com');
    expect(sent[0]!.body).toEqual({ emails: ['sam@example.com'] });
    expect(answer).toEqual({ email: 'sam@example.com', userId: null, status: 'active', subscribed: true });
  });

  it('names the userId the contact has, when it has one', async () => {
    const { fetch } = mockFetch(
      ok({ contacts: [{ email: 'sam@example.com', userId: 'user_8412', status: 'active', subscribed: true }] })
    );
    expect(await client(fetch).contacts.status('sam@example.com')).toEqual({
      email: 'sam@example.com',
      userId: 'user_8412',
      status: 'active',
      subscribed: true,
    });
  });

  it('names a bad single address as email', async () => {
    const { fetch, calls } = mockFetch(ok());
    const result = await client(fetch).contacts.status(`${'a'.repeat(320)}@x.co`, { throwOnError: false });
    expect(result.error?.message).toContain('email can be at most 320');
    expect(calls()).toBe(0);
  });

  it('takes frozen arrays', async () => {
    const { fetch, sent } = mockFetch(ok({ contacts: [] }));
    await client(fetch).contacts.status(Object.freeze(['sam@example.com']));
    expect(sent[0]!.body).toEqual({ emails: ['sam@example.com'] });
  });

  it('refuses an address over 320 characters', async () => {
    const { fetch } = mockFetch(ok());
    const error = await rejection(client(fetch).contacts.status([`${'a'.repeat(320)}@x.co`]));
    expect(error.message).toContain('emails[0]');
  });
});

describe('contacts.statusByUserId', () => {
  it('asks by userIds in batches of 500, sends numbers as text, and keeps the order asked', async () => {
    const { fetch, sent } = mockFetch((request) =>
      ok({
        contacts: request.body.userIds.map((userId: string, i: number) => ({
          email: i % 2 ? `${userId}@example.com` : null,
          userId,
          status: i % 2 ? 'active' : null,
          subscribed: i % 2 === 1,
        })),
      })
    );
    const ids = Array.from({ length: 1001 }, (_, i) => (i === 0 ? 8412 : `user_${i}`));
    const answers = await client(fetch).contacts.statusByUserId(ids);
    expect(sent.map((r) => [r.url, r.body.userIds.length])).toEqual([
      ['https://api.agumail.com/api/v1/contacts/status', 500],
      ['https://api.agumail.com/api/v1/contacts/status', 500],
      ['https://api.agumail.com/api/v1/contacts/status', 1],
    ]);
    expect(sent[0]!.body).not.toHaveProperty('emails');
    expect(answers.map((a) => a.userId)).toEqual(ids.map(String));
    expect(answers[0]).toEqual({ email: null, userId: '8412', status: null, subscribed: false });
    expect(answers[1]).toEqual({ email: 'user_1@example.com', userId: 'user_1', status: 'active', subscribed: true });
  });

  it('answers one id with one status', async () => {
    const { fetch, sent } = mockFetch(
      ok({ contacts: [{ email: 'sam@example.com', userId: 'user_8412', status: 'active', subscribed: true }] })
    );
    const answer = await client(fetch).contacts.statusByUserId('user_8412');
    expect(sent[0]!.body).toEqual({ userIds: ['user_8412'] });
    expect(answer).toEqual({ email: 'sam@example.com', userId: 'user_8412', status: 'active', subscribed: true });
  });

  it('answers an id with no contact as not on your list, even when AguMail sends no answer', async () => {
    const { fetch } = mockFetch(ok({ contacts: [] }));
    expect(await client(fetch).contacts.statusByUserId(42)).toEqual({
      email: null,
      userId: '42',
      status: null,
      subscribed: false,
    });
  });

  it('sends nothing for no ids', async () => {
    const { fetch, calls } = mockFetch(ok());
    expect(await client(fetch).contacts.statusByUserId([])).toEqual([]);
    expect(calls()).toBe(0);
  });

  it('takes frozen arrays', async () => {
    const { fetch, sent } = mockFetch(ok({ contacts: [] }));
    await client(fetch).contacts.statusByUserId(Object.freeze(['user_1', 2]));
    expect(sent[0]!.body).toEqual({ userIds: ['user_1', '2'] });
  });

  it.each([
    ['an id over 200 characters', ['u'.repeat(201)], 'userIds[0] can be at most 200 characters'],
    ['an id that is not a whole number', ['user_1', 1.5], 'userIds[1] must be text or a whole number'],
    ['an id that is an object', [{ id: 1 }], 'userIds[0] must be text or a whole number'],
  ])('refuses %s before asking', async (_label, ids, message) => {
    const { fetch, calls } = mockFetch(ok());
    const error = await rejection(client(fetch).contacts.statusByUserId(ids as any));
    expect(error.code).toBe('invalid_input');
    expect(error.message).toContain(message);
    expect(calls()).toBe(0);
  });

  it('names a bad single id as userId', async () => {
    const { fetch } = mockFetch(ok());
    const result = await client(fetch).contacts.statusByUserId('u'.repeat(201), { throwOnError: false });
    expect(result.error?.message).toContain('userId can be at most 200');
  });

  it('refuses something that is neither an id nor an array', async () => {
    const { fetch } = mockFetch(ok());
    const error = await rejection(client(fetch).contacts.statusByUserId(null as any));
    expect(error.message).toContain('userIds must be an array');
  });
});

describe('contacts.subscribe and contacts.unsubscribe', () => {
  it('subscribe sends a my_account opt-in', async () => {
    const { fetch, sent } = mockFetch(contactsOk());
    await client(fetch).contacts.subscribe('sam@example.com');
    expect(sent[0]!.url).toBe('https://api.agumail.com/api/v1/contacts');
    expect(sent[0]!.body).toEqual({
      contacts: [{ email: 'sam@example.com', consent: { optedIn: true, source: 'my_account' } }],
    });
  });

  it('unsubscribe sends a my_account opt-out', async () => {
    const { fetch, sent } = mockFetch(ok({ created: 0, updated: 0, suppressedSkipped: 2, overCapacity: 0 }));
    const result = await client(fetch).contacts.unsubscribe(['sam@example.com', 'alex@example.com']);
    expect(sent[0]!.body).toEqual({
      contacts: [
        { email: 'sam@example.com', unsubscribed: true, consentSource: 'my_account' },
        { email: 'alex@example.com', unsubscribed: true, consentSource: 'my_account' },
      ],
    });
    expect(result.suppressedSkipped).toBe(2);
  });

  it('takes frozen arrays', async () => {
    const { fetch, sent } = mockFetch(contactsOk());
    await client(fetch).contacts.subscribe(Object.freeze(['sam@example.com']));
    expect(sent[0]!.body.contacts).toHaveLength(1);
  });

  it('checks every address first', async () => {
    const { fetch, calls } = mockFetch(contactsOk());
    const error = await rejection(client(fetch).contacts.unsubscribe(['sam@example.com', 'oops']));
    expect(error.message).toContain('emails[1]');
    expect(calls()).toBe(0);
  });
});

describe('forms.list', () => {
  it('gets the published forms and the loader', async () => {
    const { fetch, sent } = mockFetch(
      ok({
        loaderUrl: 'https://api.agumail.com/embed/agumail-forms.js',
        forms: [{ slug: 'ab12', name: 'Footer', doubleOptIn: true, publishedAt: '2026-10-01T00:00:00.000Z' }],
      })
    );
    const result = await client(fetch).forms.list();
    expect(sent[0]).toMatchObject({ method: 'GET', url: 'https://api.agumail.com/api/v1/forms', body: undefined });
    expect(sent[0]!.headers).not.toHaveProperty('Content-Type');
    expect(result).toEqual({
      loaderUrl: 'https://api.agumail.com/embed/agumail-forms.js',
      forms: [{ slug: 'ab12', name: 'Footer', doubleOptIn: true, publishedAt: '2026-10-01T00:00:00.000Z' }],
    });
  });
});

describe('signups.create', () => {
  const signup = {
    email: 'sam@example.com',
    doubleOptIn: true,
    form: { id: 'footer', name: 'Footer newsletter' },
    pageUrl: 'https://example.com/pricing?utm_source=x',
    ip: '203.0.113.7',
    consentText: 'Send me product news.',
    occurredAt: new Date('2026-10-24T08:00:00Z'),
    tags: ['Newsletter'],
  };

  it('posts the signup', async () => {
    const { fetch, sent } = mockFetch(ok({ received: 1, overCapacity: 0, limited: 0 }));
    const result = await client(fetch).signups.create(signup);
    expect(sent[0]!.url).toBe('https://api.agumail.com/api/v1/signups');
    expect(sent[0]!.body).toEqual({
      signups: [{ ...signup, occurredAt: '2026-10-24T08:00:00.000Z' }],
    });
    expect(result).toEqual({ received: 1, overCapacity: 0, limited: 0 });
  });

  it('names the form after its id when it has no name, and sends a builder only when given', async () => {
    const { fetch, sent } = mockFetch(ok({ received: 2, overCapacity: 0, limited: 0 }));
    await client(fetch).signups.create([
      { email: 'a@example.com', doubleOptIn: false, form: { id: 'hero' } },
      { email: 'b@example.com', doubleOptIn: false, form: { id: 'hero', builder: 'webflow' } },
    ]);
    expect(sent[0]!.body.signups.map((s: any) => s.form)).toEqual([
      { id: 'hero', name: 'hero' },
      { id: 'hero', name: 'hero', builder: 'webflow' },
    ]);
  });

  it('takes a frozen array of signups, with frozen tags', async () => {
    const { fetch, sent } = mockFetch(ok({ received: 1, overCapacity: 0, limited: 0 }));
    await client(fetch).signups.create(
      Object.freeze([{ email: 'a@example.com', doubleOptIn: false, form: { id: 'f' }, tags: Object.freeze(['News']) }])
    );
    expect(sent[0]!.body.signups[0].tags).toEqual(['News']);
  });

  it('adds up batches of 500', async () => {
    const { fetch, sent } = mockFetch((request) => ok({ received: request.body.signups.length, overCapacity: 0, limited: 1 }));
    const many = Array.from({ length: 501 }, (_, i) => ({ email: `p${i}@example.com`, doubleOptIn: false, form: { id: 'f' } }));
    const result = await client(fetch).signups.create(many);
    expect(sent).toHaveLength(2);
    expect(result).toEqual({ received: 501, overCapacity: 0, limited: 2 });
  });

  it.each([
    ['a missing doubleOptIn', { email: 'a@example.com', form: { id: 'f' } }, 'doubleOptIn must be true or false'],
    ['a missing form', { email: 'a@example.com', doubleOptIn: true }, 'signup.form must be an object'],
    ['a form without an id', { email: 'a@example.com', doubleOptIn: true, form: {} }, 'signup.form.id is required'],
    ['a builder that is not a short name', { email: 'a@example.com', doubleOptIn: true, form: { id: 'f', builder: 'My Builder' } }, 'short lowercase name'],
    ['a page URL over 2000 characters', { email: 'a@example.com', doubleOptIn: true, form: { id: 'f' }, pageUrl: 'u'.repeat(2001) }, 'at most 2000'],
    ['a malformed email', { email: 'a@b', doubleOptIn: true, form: { id: 'f' } }, 'not an email address'],
  ])('refuses %s', async (_label, input, message) => {
    const { fetch, calls } = mockFetch(ok());
    const error = await rejection(client(fetch).signups.create(input as any));
    expect(error.message).toContain(message);
    expect(calls()).toBe(0);
  });
});

describe('ping', () => {
  it('gets who the key belongs to', async () => {
    const { fetch, sent } = mockFetch(
      ok({ shop: { userId: 'u_1', shopName: 'Fettle & Fade' }, integration: null, config: { siteKey: null } })
    );
    const result = await client(fetch).ping();
    expect(sent[0]).toMatchObject({ method: 'GET', url: 'https://api.agumail.com/api/v1/ping' });
    expect(result).toEqual({ shop: { userId: 'u_1', shopName: 'Fettle & Fade' } });
  });
});
