import type { AguMailError } from './errors';

export type AguMailWarningCode =
  | 'unknown_contacts'
  | 'over_capacity'
  | 'signups_limited'
  | 'history'
  | 'unknown_user_ids'
  | 'conflicts';

/** Records AguMail took without an error, but dropped or held back. */
export interface AguMailWarning {
  code: AguMailWarningCode;
  message: string;
  /** How many records it covers, added up over the call or flush. */
  count: number;
  /** On a `conflicts` warning: the contacts AguMail refused, and why. */
  conflicted?: ContactConflict[];
}

export interface AguMailOptions {
  /** Where the AguMail API lives. Defaults to https://api.agumail.com. */
  baseUrl?: string | undefined;
  /**
   * How long one attempt may take, in milliseconds. Defaults to 10 seconds, or
   * 60 for a request that carries more than one record.
   */
  timeoutMs?: number | undefined;
  /** Attempts after the first one, for errors worth retrying. Defaults to 3. */
  maxRetries?: number | undefined;
  /** Your own fetch. Defaults to the global one. */
  fetch?: typeof fetch | undefined;
  /**
   * Called with the errors nobody else sees: calls made with `throwOnError: false`,
   * records the queue refused, and failed flushes. It may be async.
   */
  onError?: ((error: AguMailError) => void | Promise<void>) | undefined;
  /**
   * Called when AguMail took a call without an error but dropped or held back
   * some of it: events for unknown contacts, a full plan, rate-limited signups,
   * events old enough to count as history, a userId nobody has, or an email
   * that belongs to someone else. It may be async.
   */
  onWarning?: ((warning: AguMailWarning) => void | Promise<void>) | undefined;
  /**
   * Send nothing. Calls still check their input, then resolve with empty
   * results, and no API key is needed. For tests and local development.
   */
  disabled?: boolean | undefined;
  /** The queue flushes once this many records are waiting: 1 to 500, default 500. */
  flushAt?: number | undefined;
  /**
   * The queue flushes this many milliseconds after the first record is queued.
   * Defaults to 5000; 0 turns the timer off.
   */
  flushIntervalMs?: number | undefined;
}

export interface CallOptions {
  /** Pass `false` to get `{ data, error }` back instead of a thrown error. */
  throwOnError?: boolean | undefined;
  /** Overrides the client's timeout for this call. */
  timeoutMs?: number | undefined;
  signal?: AbortSignal | undefined;
}

export interface BatchOptions extends CallOptions {
  /**
   * The records are your history (a first import), not something that just
   * happened: AguMail stores them and starts no flows from them.
   */
  backfill?: boolean | undefined;
}

export interface FlushOptions {
  /** Overrides the client's timeout for each request of this flush. */
  timeoutMs?: number | undefined;
  signal?: AbortSignal | undefined;
}

export interface FlushResult {
  /** What AguMail counted for the queued contacts it was sent. */
  contacts: ContactCounts;
  /** What AguMail counted for the queued events it was sent. */
  events: EventCounts;
  /** Why the flush stopped, or null. The records it could not send are dropped. */
  error: AguMailError | null;
}

export type Settled<T> = { data: T; error: null } | { data: null; error: AguMailError };

/**
 * What a call resolves to: the result, or `{ data, error }` with a literal
 * `throwOnError: false`. When throwOnError is a boolean known only at run time,
 * it is either, and TypeScript makes you check which.
 */
export type Outcome<T, O> = O extends { throwOnError: false }
  ? Settled<T>
  : 'throwOnError' extends keyof O
    ? O[keyof O & 'throwOnError'] extends true | undefined
      ? T
      : T | Settled<T>
    : T;

/** A contact property. Sent to AguMail as text. */
export type PropertyValue = string | number | boolean | Date | null | undefined;

export interface Contact {
  /** Needed unless you pass userId. With a userId, it is the address the contact should have. */
  email?: string | null | undefined;
  /**
   * Your app's own id for the person, up to 200 characters, sent exactly as you
   * give it (a whole number is sent as text). AguMail then knows them by it: when
   * they change their email in your app, identify moves the same contact to the
   * new address. A contact keeps the first id it is sent with.
   */
  userId?: string | number | null | undefined;
  firstName?: string | null | undefined;
  lastName?: string | null | undefined;
  phone?: string | null | undefined;
  /** IANA time zone, such as "Europe/Lisbon". */
  timezone?: string | null | undefined;
  tags?: readonly string[] | null | undefined;
  /** Your own fields. AguMail keeps them as text: numbers, booleans and dates are converted for you. */
  properties?: Record<string, PropertyValue> | null | undefined;
  /**
   * Defaults to true: the person agreed to marketing email. `false` adds them
   * without subscribing them, and never unsubscribes anyone already subscribed.
   */
  subscribed?: boolean | undefined;
  /** When they became your customer. Becomes their "Date added" when AguMail creates them. */
  customerSince?: string | Date | null | undefined;
}

export type ContactProfile = Omit<Contact, 'email' | 'userId' | 'subscribed'>;

export interface TrackEvent {
  /** Who did it. Needed unless you pass userId. */
  email?: string | null | undefined;
  /** Your app's own id for the person. With one, AguMail finds them by it alone, and reads no email. */
  userId?: string | number | null | undefined;
  /** Your name for what happened, such as "Created first campaign". */
  event: string;
  /** Any plain object, nested or typed by your own interface. Sent as JSON. */
  properties?: object | null | undefined;
  /** A number, such as what the event was worth. AguMail stores no currency with it. */
  value?: number | null | undefined;
  /** When it happened. Defaults to now. More than 72 hours ago counts as history. */
  occurredAt?: string | Date | null | undefined;
  /**
   * Your id for this occurrence. The same id is never recorded twice across
   * your whole account. One is generated when you leave it out.
   */
  uniqueId?: string | null | undefined;
  /**
   * Upserts the contact first, with these fields and the event's email and userId.
   * That upsert is an identify that never changes their subscription: with both
   * email and userId, it can move the contact to that email.
   */
  contact?: ContactProfile | null | undefined;
}

export interface Signup {
  email: string;
  /** Send a confirmation email before subscribing them. */
  doubleOptIn: boolean;
  /** The form on your site: `id` is yours, `name` is what AguMail shows. */
  form: { id: string; name?: string | null | undefined; builder?: string | null | undefined };
  firstName?: string | null | undefined;
  lastName?: string | null | undefined;
  phone?: string | null | undefined;
  tags?: readonly string[] | null | undefined;
  /** The page the form was on. */
  pageUrl?: string | null | undefined;
  /** The visitor's IP address, not your server's. */
  ip?: string | null | undefined;
  /** The consent wording the visitor saw. */
  consentText?: string | null | undefined;
  occurredAt?: string | Date | null | undefined;
}

export interface ContactCounts {
  created: number;
  updated: number;
  suppressedSkipped: number;
  overCapacity: number;
  /** Sent by AguMail servers that report confirmation emails. */
  confirmationsSent?: number;
  /**
   * Contacts sent with only a userId that no contact has, so they were skipped:
   * a new contact needs an email. Sent by AguMail servers that know user ids, as
   * are conflicts and conflicted.
   */
  unknownContacts?: number;
  /** Contacts refused because their email belongs to someone else. */
  conflicts?: number;
  /** Each contact refused, and why. AguMail never merges two contacts. */
  conflicted?: ContactConflict[];
}

/**
 * - `email_taken`: the userId's contact can't move to this email, because another contact has it.
 *   For a delete: the userId and the email belong to two different contacts.
 * - `user_id_mismatch`: the contact with this email already has a different userId.
 */
export type ContactConflictReason = 'email_taken' | 'user_id_mismatch';

export interface ContactConflict {
  /**
   * The record's place in the array you passed, from 0: the contact's for
   * identifyMany and contacts.deleteMany, the event's for trackMany. In a flush,
   * its place among the contacts that flush sent, in the order they were queued.
   */
  index: number;
  userId: string | null;
  email: string | null;
  reason: ContactConflictReason;
}

/**
 * Who to delete: your app's userId, the email, or both. With both, they must
 * belong to the same contact, or nothing is deleted and the record is listed in
 * `conflicted`.
 */
export type ContactRef =
  | { userId: string | number; email?: string | null | undefined }
  | { email: string; userId?: string | number | null | undefined };

export interface DeleteCounts {
  deleted: number;
  /**
   * Records that name nobody AguMail has, such as someone already deleted. Never
   * an error, so a delete is safe to send again.
   */
  notFound: number;
  /** Records whose userId and email belong to two different contacts, so neither was deleted. */
  conflicts: number;
  /** Each record refused, and why. */
  conflicted: ContactConflict[];
}

export interface EventCounts {
  created: number;
  duplicates: number;
  unknownContacts: number;
}

export interface TrackResult extends EventCounts {
  /** The uniqueId the event was sent with: yours, or the generated one. */
  uniqueId: string;
  contact?: ContactCounts;
}

export interface TrackManyResult extends EventCounts {
  /** The uniqueId each event was sent with, in the order you passed them. */
  uniqueIds: string[];
  contacts?: ContactCounts;
}

export type ContactStatusValue =
  | 'active'
  | 'nonsubscribed'
  | 'unconfirmed'
  | 'unsubscribed'
  | 'bounced'
  | 'complained'
  | 'cleaned';

export interface ContactStatus {
  /** The address asked about, or the contact's own when you asked by userId. null for an id nobody has. */
  email: string | null;
  /** The id asked about, or the contact's own when you asked by email. null when it has none, or nobody has the address. */
  userId: string | null;
  /** null when the address or id is not on your list. */
  status: ContactStatusValue | null;
  /** The one to act on: subscribed, and not unsubscribed or bounced since. */
  subscribed: boolean;
}

export interface Form {
  slug: string;
  name: string;
  doubleOptIn: boolean;
  publishedAt: string;
}

export interface FormList {
  /** The script that renders your forms on a page. */
  loaderUrl: string;
  forms: Form[];
}

export interface SignupCounts {
  received: number;
  overCapacity: number;
  /** Signups refused by the per-visitor limit. They are not stored. */
  limited: number;
}

export interface PingResult {
  /** `userId` is your AguMail account's id, not one of your app's user ids. */
  shop: { userId: string; shopName: string | null };
}
