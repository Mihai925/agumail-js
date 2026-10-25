import { describe, expectTypeOf, it } from 'vitest';
import {
  noThrow,
  type AguMail,
  type AguMailError,
  type AguMailOptions,
  type AguMailWarning,
  type CallOptions,
  type Contact,
  type ContactCounts,
  type ContactStatus,
  type FlushResult,
  type Outcome,
  type PingResult,
  type Settled,
  type Signup,
  type TrackEvent,
  type TrackManyResult,
  type TrackResult,
} from '../src/index';

// Checked by `npm run typecheck` (with exactOptionalPropertyTypes on); at run
// time these only make sure the file loads.
const agumail = null as unknown as AguMail;
const contact = { email: 'a@b.co' };
declare const flag: boolean;

describe('return types', () => {
  it('resolve to the result by default, and to Settled with throwOnError: false', () => {
    if (agumail) {
      expectTypeOf(agumail.identify(contact)).resolves.toEqualTypeOf<ContactCounts>();
      expectTypeOf(agumail.identify(contact, undefined)).resolves.toEqualTypeOf<ContactCounts>();
      expectTypeOf(agumail.identify(contact, { timeoutMs: 5 })).resolves.toEqualTypeOf<ContactCounts>();
      expectTypeOf(agumail.identify(contact, { throwOnError: true })).resolves.toEqualTypeOf<ContactCounts>();
      expectTypeOf(agumail.identify(contact, { throwOnError: false })).resolves.toEqualTypeOf<Settled<ContactCounts>>();
      expectTypeOf(agumail.track({ email: 'a@b.co', event: 'x' }, { throwOnError: false })).resolves.toEqualTypeOf<
        Settled<TrackResult>
      >();
      expectTypeOf(agumail.contacts.status(['a@b.co'])).resolves.toEqualTypeOf<ContactStatus[]>();
      expectTypeOf(agumail.identifyMany([], { backfill: true, throwOnError: false })).resolves.toEqualTypeOf<
        Settled<ContactCounts>
      >();
      expectTypeOf(agumail.trackMany([])).resolves.toEqualTypeOf<TrackManyResult>();
    }
  });

  it('give either when throwOnError is a boolean known only at run time', () => {
    if (agumail) {
      const typed: CallOptions = { throwOnError: false };
      expectTypeOf(agumail.identify(contact, typed)).resolves.toEqualTypeOf<ContactCounts | Settled<ContactCounts>>();
      const widened = { throwOnError: false };
      expectTypeOf(agumail.identify(contact, widened)).resolves.toEqualTypeOf<ContactCounts | Settled<ContactCounts>>();
      expectTypeOf(agumail.identify(contact, { throwOnError: flag })).resolves.toEqualTypeOf<
        ContactCounts | Settled<ContactCounts>
      >();
      const maybe = undefined as CallOptions | undefined;
      expectTypeOf(agumail.ping(maybe)).resolves.toEqualTypeOf<PingResult | Settled<PingResult>>();
    }
  });

  it('work out Outcome on its own', () => {
    expectTypeOf<Outcome<number, { throwOnError: false }>>().toEqualTypeOf<Settled<number>>();
    expectTypeOf<Outcome<number, { readonly throwOnError: false }>>().toEqualTypeOf<Settled<number>>();
    expectTypeOf<Outcome<number, { throwOnError: true }>>().toEqualTypeOf<number>();
    expectTypeOf<Outcome<number, { throwOnError: true | undefined }>>().toEqualTypeOf<number>();
    expectTypeOf<Outcome<number, { timeoutMs: number }>>().toEqualTypeOf<number>();
    expectTypeOf<Outcome<number, undefined>>().toEqualTypeOf<number>();
    expectTypeOf<Outcome<number, { throwOnError: boolean }>>().toEqualTypeOf<number | Settled<number>>();
    expectTypeOf<Outcome<number, { throwOnError: false | undefined }>>().toEqualTypeOf<number | Settled<number>>();
    expectTypeOf<Outcome<number, CallOptions>>().toEqualTypeOf<number | Settled<number>>();
  });

  it('give Settled for noThrow', () => {
    expectTypeOf(noThrow).toEqualTypeOf<{ readonly throwOnError: false }>();
    if (agumail) {
      expectTypeOf(agumail.identify(contact, noThrow)).resolves.toEqualTypeOf<Settled<ContactCounts>>();
      expectTypeOf(agumail.contacts.status('a@b.co', noThrow)).resolves.toEqualTypeOf<Settled<ContactStatus>>();
    }
  });

  it('answer one address with one status and an array with an array', () => {
    if (agumail) {
      expectTypeOf(agumail.contacts.status('a@b.co')).resolves.toEqualTypeOf<ContactStatus>();
      expectTypeOf(agumail.contacts.status(['a@b.co'])).resolves.toEqualTypeOf<ContactStatus[]>();
      expectTypeOf(agumail.contacts.status(['a@b.co'], { throwOnError: false })).resolves.toEqualTypeOf<
        Settled<ContactStatus[]>
      >();
    }
  });

  it('keep their types when detached from the client', () => {
    if (agumail) {
      const { identify, track, flush } = agumail;
      expectTypeOf(identify(contact)).resolves.toEqualTypeOf<ContactCounts>();
      expectTypeOf(track({ email: 'a@b.co', event: 'x' }, noThrow)).resolves.toEqualTypeOf<Settled<TrackResult>>();
      expectTypeOf(flush()).resolves.toEqualTypeOf<FlushResult>();
    }
  });
});

describe('input types', () => {
  it('take readonly arrays everywhere', () => {
    const contacts: readonly Contact[] = [contact];
    const events: readonly TrackEvent[] = [{ email: 'a@b.co', event: 'x' }];
    const emails: readonly string[] = ['a@b.co'];
    const signups: readonly Signup[] = [{ email: 'a@b.co', doubleOptIn: false, form: { id: 'f' } }];
    const tags = ['Trial'] as const;
    if (agumail) {
      expectTypeOf(agumail.identifyMany(contacts)).resolves.toEqualTypeOf<ContactCounts>();
      expectTypeOf(agumail.trackMany(events)).resolves.toEqualTypeOf<TrackManyResult>();
      expectTypeOf(agumail.contacts.status(emails)).resolves.toEqualTypeOf<ContactStatus[]>();
      void agumail.contacts.subscribe(emails);
      void agumail.contacts.unsubscribe(emails);
      void agumail.signups.create(signups);
      void agumail.identify({ email: 'a@b.co', tags });
      void agumail.signups.create({ email: 'a@b.co', doubleOptIn: true, form: { id: 'f' }, tags });
    }
  });

  it('take an explicit undefined in every optional field', () => {
    const maybe = undefined as string | undefined;
    if (agumail) {
      void agumail.identify({
        email: 'a@b.co',
        firstName: maybe,
        lastName: maybe,
        phone: maybe,
        timezone: maybe,
        tags: undefined,
        properties: undefined,
        subscribed: undefined,
        customerSince: maybe,
      });
      void agumail.track({
        email: 'a@b.co',
        event: 'x',
        properties: undefined,
        value: undefined,
        occurredAt: maybe,
        uniqueId: maybe,
        contact: { firstName: maybe },
      });
      void agumail.signups.create({
        email: 'a@b.co',
        doubleOptIn: true,
        form: { id: 'f', name: maybe, builder: maybe },
        pageUrl: maybe,
        ip: maybe,
        consentText: maybe,
        occurredAt: maybe,
      });
      void agumail.identifyMany([], { throwOnError: undefined, timeoutMs: undefined, signal: undefined, backfill: undefined });
      void agumail.flush({ timeoutMs: undefined, signal: undefined });
    }
    const options: AguMailOptions = {
      baseUrl: maybe,
      timeoutMs: undefined,
      maxRetries: undefined,
      fetch: undefined,
      onError: undefined,
      onWarning: undefined,
      disabled: undefined,
      flushAt: undefined,
      flushIntervalMs: undefined,
    };
    expectTypeOf(options).toEqualTypeOf<AguMailOptions>();
  });

  it('take event properties typed by an interface, but keep contact properties flat', () => {
    interface UpgradeProps {
      plan: string;
      seats: number;
      addons: { name: string }[];
    }
    const props: UpgradeProps = { plan: 'pro', seats: 5, addons: [] };
    if (agumail) {
      void agumail.track({ email: 'a@b.co', event: 'Upgraded', properties: props });
      // @ts-expect-error contact properties are text, numbers, booleans or dates, never objects
      void agumail.identify({ email: 'a@b.co', properties: { address: { city: 'Porto' } } });
    }
  });

  it('take async onError and onWarning, and a key that is left out', () => {
    expectTypeOf<NonNullable<AguMailOptions['onError']>>().toEqualTypeOf<(error: AguMailError) => void | Promise<void>>();
    expectTypeOf<NonNullable<AguMailOptions['onWarning']>>().toEqualTypeOf<
      (warning: AguMailWarning) => void | Promise<void>
    >();
    expectTypeOf<ConstructorParameters<typeof AguMail>>().toEqualTypeOf<
      [apiKey?: string | undefined, options?: AguMailOptions]
    >();
  });

  it('give the queue methods no result', () => {
    if (agumail) {
      expectTypeOf(agumail.queue.identify(contact)).toBeVoid();
      expectTypeOf(agumail.queue.track({ email: 'a@b.co', event: 'x' })).toBeVoid();
    }
  });
});
