import { describe, expect, it, vi } from 'vitest';
import type { AguMailWarning } from '../src/index';
import { client, contactsOk, eventsOk, fail, mockFetch, ok, rejection } from './helpers';

const HOUR = 60 * 60 * 1000;
const hoursAgo = (n: number) => new Date(Date.now() - n * HOUR);

function watched(...replies: Parameters<typeof mockFetch>) {
  const warnings: AguMailWarning[] = [];
  const { fetch, sent } = mockFetch(...replies);
  const agumail = client(fetch, { onWarning: (w) => void warnings.push(w), maxRetries: 0 });
  return { agumail, warnings, sent };
}

describe('onWarning', () => {
  it('reports events for people AguMail does not have', async () => {
    const { agumail, warnings } = watched(ok({ created: 0, duplicates: 0, unknownContacts: 1 }));
    await agumail.track({ email: 'nobody@example.com', event: 'Logged in' });
    expect(warnings).toEqual([{ code: 'unknown_contacts', count: 1, message: expect.stringContaining('identify') }]);
    expect(warnings[0]!.message).toContain('contact');
  });

  it('fires once per call, with the count added up over every batch', async () => {
    const { agumail, warnings, sent } = watched(ok({ created: 0, duplicates: 0, unknownContacts: 2 }));
    await agumail.trackMany(Array.from({ length: 1001 }, (_, i) => ({ email: `p${i}@example.com`, event: 'Logged in' })));
    expect(sent).toHaveLength(3);
    expect(warnings).toEqual([expect.objectContaining({ code: 'unknown_contacts', count: 6 })]);
  });

  it('reports contacts refused because the plan is full', async () => {
    const { agumail, warnings } = watched((request) =>
      ok({ created: request.body.contacts.length - 1, updated: 0, suppressedSkipped: 0, overCapacity: 1 })
    );
    await agumail.identifyMany(Array.from({ length: 600 }, (_, i) => ({ email: `p${i}@example.com` })));
    expect(warnings).toEqual([{ code: 'over_capacity', count: 2, message: expect.stringContaining('plan') }]);
  });

  it('reports a contact that track could not add', async () => {
    const { agumail, warnings } = watched(
      ok({ created: 0, updated: 0, suppressedSkipped: 0, overCapacity: 1 }),
      ok({ created: 0, duplicates: 0, unknownContacts: 1 })
    );
    await agumail.track({ email: 'sam@example.com', event: 'Signed up', contact: { firstName: 'Sam' } });
    expect(warnings.map((w) => [w.code, w.count])).toEqual([
      ['unknown_contacts', 1],
      ['over_capacity', 1],
    ]);
  });

  it('reports signups refused by a full plan or the per-visitor limit', async () => {
    const { agumail, warnings } = watched(ok({ received: 3, overCapacity: 1, limited: 2 }));
    await agumail.signups.create([
      { email: 'a@example.com', doubleOptIn: false, form: { id: 'f' } },
      { email: 'b@example.com', doubleOptIn: false, form: { id: 'f' } },
      { email: 'c@example.com', doubleOptIn: false, form: { id: 'f' } },
    ]);
    expect(warnings.map((w) => [w.code, w.count])).toEqual([
      ['over_capacity', 1],
      ['signups_limited', 2],
    ]);
    expect(warnings[1]!.message).toContain('visitor');
  });

  it('reports events older than 72 hours sent without backfill', async () => {
    const { agumail, warnings } = watched(eventsOk(4));
    await agumail.trackMany([
      { email: 'a@example.com', event: 'Paid', occurredAt: hoursAgo(73) },
      { email: 'b@example.com', event: 'Paid', occurredAt: hoursAgo(24 * 30).toISOString() },
      { email: 'c@example.com', event: 'Paid', occurredAt: hoursAgo(71) },
      { email: 'd@example.com', event: 'Paid' },
    ]);
    expect(warnings).toEqual([{ code: 'history', count: 2, message: expect.stringContaining('72 hours') }]);
    expect(warnings[0]!.message).toContain('backfill: true');
  });

  it('says nothing about old events sent with backfill: true', async () => {
    const { agumail, warnings } = watched(eventsOk());
    await agumail.trackMany([{ email: 'a@example.com', event: 'Paid', occurredAt: hoursAgo(100) }], { backfill: true });
    expect(warnings).toEqual([]);
  });

  it('says nothing about duplicates or suppressed contacts, which are normal', async () => {
    const { agumail, warnings } = watched((request) =>
      request.url.endsWith('/events')
        ? ok({ created: 0, duplicates: 1, unknownContacts: 0 })
        : ok({ created: 0, updated: 0, suppressedSkipped: 1, overCapacity: 0 })
    );
    await agumail.identify({ email: 'gone@example.com' });
    await agumail.track({ email: 'gone@example.com', event: 'x', uniqueId: 'x:1' });
    expect(warnings).toEqual([]);
  });

  it('fires for throwing and quiet calls alike, for the batches that landed before a failure', async () => {
    const replies = () => [ok({ created: 499, duplicates: 0, unknownContacts: 1 }), fail(400, 'bad')] as const;
    const events = Array.from({ length: 600 }, (_, i) => ({ email: `p${i}@example.com`, event: 'Logged in' }));

    const loud = watched(...replies());
    await rejection(loud.agumail.trackMany(events));
    expect(loud.warnings).toEqual([expect.objectContaining({ code: 'unknown_contacts', count: 1 })]);

    const quiet = watched(...replies());
    const result = await quiet.agumail.trackMany(events, { throwOnError: false });
    expect(result.error?.code).toBe('bad_request');
    expect(quiet.warnings).toEqual([expect.objectContaining({ code: 'unknown_contacts', count: 1 })]);
  });

  it('counts no history for events that never landed', async () => {
    const { agumail, warnings } = watched(fail(503));
    await rejection(agumail.track({ email: 'a@example.com', event: 'Paid', occurredAt: hoursAgo(100) }));
    expect(warnings).toEqual([]);
  });

  it('cannot break a call by throwing or rejecting', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      const { fetch } = mockFetch(ok({ created: 0, duplicates: 0, unknownContacts: 1 }));
      const throwing = client(fetch, {
        onWarning: () => {
          throw new Error('logger down');
        },
      });
      const rejecting = client(fetch, {
        onWarning: async () => {
          throw new Error('logger down');
        },
      });
      expect((await throwing.track({ email: 'a@example.com', event: 'x' })).unknownContacts).toBe(1);
      expect((await rejecting.track({ email: 'a@example.com', event: 'x' })).unknownContacts).toBe(1);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  it('is optional', async () => {
    const { fetch } = mockFetch(contactsOk());
    const result = await client(fetch).identify({ email: 'sam@example.com' });
    expect(result.created).toBe(1);
  });
});
