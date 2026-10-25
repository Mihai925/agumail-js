// Runs against a real AguMail server, such as local dev:
//   AGUMAIL_TEST_URL=http://localhost:3011 AGUMAIL_TEST_KEY=agm_... npm run test:live
// It writes contacts and events to that account, all under @example.com.

import { describe, expect, it } from 'vitest';
import { AguMail, AguMailError } from '../src/index';

const url = process.env.AGUMAIL_TEST_URL;
const key = process.env.AGUMAIL_TEST_KEY;

describe.skipIf(!url || !key)('live AguMail server', { timeout: 30_000 }, () => {
  const agumail = new AguMail(key, { baseUrl: url });
  const run = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const address = (name: string) => `agumail-js+${run}-${name}@example.com`;
  const statusOf = async (email: string) => (await agumail.contacts.status([email]))[0]!;

  it('pings', async () => {
    const result = await agumail.ping();
    expect(result.shop.userId).not.toBe('');
  });

  it('refuses a key it does not know, without retrying', async () => {
    const stranger = new AguMail(`agm_${'0'.repeat(40)}`, { baseUrl: url });
    const error = await stranger.ping().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AguMailError);
    expect(error).toMatchObject({ status: 401, code: 'unauthorized' });
  });

  it('subscribes on identify by default', async () => {
    const email = address('subscribed');
    const result = await agumail.identify({ email, firstName: 'Sam', properties: { plan: 'trial', seats: 3, beta: true } });
    expect(result.created).toBe(1);
    expect(await statusOf(email)).toMatchObject({ status: 'active', subscribed: true });
  });

  it('adds without subscribing on subscribed: false', async () => {
    const email = address('not-subscribed');
    await agumail.identify({ email, subscribed: false });
    expect(await statusOf(email)).toMatchObject({ status: 'nonsubscribed', subscribed: false });
  });

  it('records an event once, however often it is sent', async () => {
    const email = address('events');
    await agumail.identify({ email });
    const first = await agumail.track({ email, event: 'Created first campaign', properties: { blocks: 3 } });
    expect(first).toMatchObject({ created: 1, duplicates: 0, unknownContacts: 0 });
    const again = await agumail.track({ email, event: 'Created first campaign', uniqueId: first.uniqueId });
    expect(again).toMatchObject({ created: 0, duplicates: 1 });
  });

  it('skips events for people it does not hold', async () => {
    const result = await agumail.track({ email: address('stranger'), event: 'Logged in' });
    expect(result.unknownContacts).toBe(1);
  });

  it('upserts the contact first when track has contact fields, without subscribing them', async () => {
    const email = address('track-contact');
    const result = await agumail.track({ email, event: 'Logged in', contact: { firstName: 'Alex' } });
    expect(result.contact?.created).toBe(1);
    expect(result.created).toBe(1);
    expect((await statusOf(email)).subscribed).toBe(false);
  });

  it('sends batches with identifyMany and trackMany', async () => {
    const emails = ['a', 'b', 'c'].map((n) => address(`many-${n}`));
    expect((await agumail.identifyMany(emails.map((email) => ({ email })))).created).toBe(3);
    const events = await agumail.trackMany(
      emails.map((email) => ({ email, event: 'Imported', occurredAt: '2025-01-01T00:00:00Z' })),
      { backfill: true }
    );
    expect(events.created).toBe(3);
  });

  it('unsubscribes, and lets the account settings switch turn email back on', async (ctx) => {
    const email = address('switch');
    await agumail.identify({ email });
    await agumail.contacts.unsubscribe(email);
    expect(await statusOf(email)).toMatchObject({ status: 'unsubscribed', subscribed: false });

    await agumail.contacts.subscribe(email);
    const after = await statusOf(email);
    if (!after.subscribed) ctx.skip('this server still asks for a confirmation email (server change 2 not deployed)');
    expect(after).toMatchObject({ status: 'active', subscribed: true });
  });

  it('answers one address with one status', async () => {
    const email = address('one-status');
    await agumail.identify({ email });
    expect(await agumail.contacts.status(email)).toMatchObject({ email, status: 'active', subscribed: true });
  });

  it('flushes queued contacts before their events', async () => {
    const queued = new AguMail(key, { baseUrl: url, flushIntervalMs: 0 });
    queued.queue.track({ email: address('queued'), event: 'Signed up', contact: { firstName: 'Q' } });
    queued.queue.identify({ email: address('queued-2') });
    const result = await queued.flush();
    expect(result.error).toBeNull();
    expect(result.contacts.created).toBe(2);
    expect(result.events).toMatchObject({ created: 1, unknownContacts: 0 });
  });

  it('lists forms', async () => {
    const result = await agumail.forms.list();
    expect(result.loaderUrl).toMatch(/^https?:\/\//);
    expect(Array.isArray(result.forms)).toBe(true);
  });

  it('takes a signup from a form on your own site', async (ctx) => {
    const result = await agumail.signups
      .create({ email: address('signup'), doubleOptIn: false, form: { id: 'footer', name: 'Footer newsletter' } })
      .catch((error: unknown) => {
        if (error instanceof AguMailError && error.status === 400 && /builder/.test(error.message)) {
          ctx.skip('this server still requires a WordPress form builder (server change 1 not deployed)');
        }
        throw error;
      });
    expect(result.received).toBe(1);
  });
});
