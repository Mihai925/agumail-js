import { AguMailError, invalidInput, toAguMailError } from './errors';
import {
  BATCH_SIZE,
  MAX_REQUEST_BYTES,
  consentRecord,
  contactRecord,
  deleteRecord,
  eventRecord,
  isHistory,
  list,
  signupRecord,
  statusEmail,
  statusUserId,
  type CheckedEvent,
} from './records';
import { baseUrlProblem, normalizeBaseUrl, request, type Transport } from './request';
import { BROWSER_MESSAGE, MAX_DELAY_MS, envApiKey, isBrowser, unref, utf8Length } from './runtime';
import type {
  AguMailOptions,
  AguMailWarning,
  AguMailWarningCode,
  BatchOptions,
  CallOptions,
  Contact,
  ContactConflict,
  ContactConflictReason,
  ContactCounts,
  ContactRef,
  ContactStatus,
  ContactStatusValue,
  DeleteCounts,
  EventCounts,
  FlushOptions,
  FlushResult,
  FormList,
  Outcome,
  PingResult,
  Signup,
  SignupCounts,
  TrackEvent,
  TrackManyResult,
  TrackResult,
} from './types';

type Json = Record<string, unknown>;
type Tally = Record<AguMailWarningCode, number>;

/** One public call or flush: its options, and what it has to warn about so far. */
interface Call {
  options: FlushOptions | undefined;
  tally: Tally;
  /** The contacts AguMail refused, which the conflicts warning carries. */
  conflicted: ContactConflict[];
}

/** How to send one kind of record in batches, and add up what AguMail counts. */
interface Sender<C> {
  path: string;
  key: string;
  /** `indexOf` turns a record's place in the request into its place in the caller's array. */
  read: (body: Json, indexOf: (i: number) => number) => C;
  add: (a: C, b: C) => C;
  tally: (call: Call, counts: C) => void;
}

const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_FLUSH_INTERVAL_MS = 5_000;
const WARNING_CODES: AguMailWarningCode[] = [
  'unknown_contacts',
  'over_capacity',
  'signups_limited',
  'history',
  'unknown_user_ids',
  'conflicts',
];

/**
 * Call options for a call that never throws: it resolves to `{ data, error }`.
 *
 * @example
 * const { data, error } = await agumail.identify({ email }, noThrow);
 */
export const noThrow: { readonly throwOnError: false } = Object.freeze({ throwOnError: false } as const);

export interface ContactsApi {
  /**
   * Where one address stands. `subscribed` is the value to show on an email switch;
   * `status` is null for an address that isn't on your list.
   *
   * @example
   * const { subscribed } = await agumail.contacts.status('sam@example.com');
   */
  status<O extends CallOptions | undefined = undefined>(email: string, options?: O): Promise<Outcome<ContactStatus, O>>;
  /**
   * Where each address stands, in the order you asked, 500 to a request.
   *
   * @example
   * const answers = await agumail.contacts.status(['sam@example.com', 'alex@example.com']);
   */
  status<O extends CallOptions | undefined = undefined>(
    emails: readonly string[],
    options?: O
  ): Promise<Outcome<ContactStatus[], O>>;
  /**
   * Where the contact with your app's user id stands, as status answers for an address.
   * `email` is the address that contact has, and `status` is null for an id nobody has.
   *
   * @example
   * const { subscribed } = await agumail.contacts.statusByUserId(user.id);
   */
  statusByUserId<O extends CallOptions | undefined = undefined>(
    userId: string | number,
    options?: O
  ): Promise<Outcome<ContactStatus, O>>;
  /**
   * Where each user id stands, in the order you asked, 500 to a request.
   *
   * @example
   * const answers = await agumail.contacts.statusByUserId(users.map((u) => u.id));
   */
  statusByUserId<O extends CallOptions | undefined = undefined>(
    userIds: readonly (string | number)[],
    options?: O
  ): Promise<Outcome<ContactStatus[], O>>;
  /**
   * The person turned marketing email on, themselves, in your app's settings. Call it
   * only then: someone who left from an email gets one confirmation email instead.
   *
   * @example
   * await agumail.contacts.subscribe(user.email);
   */
  subscribe<O extends CallOptions | undefined = undefined>(
    emails: string | readonly string[],
    options?: O
  ): Promise<Outcome<ContactCounts, O>>;
  /**
   * The person turned marketing email off, themselves, in your app's settings.
   *
   * @example
   * await agumail.contacts.unsubscribe(user.email);
   */
  unsubscribe<O extends CallOptions | undefined = undefined>(
    emails: string | readonly string[],
    options?: O
  ): Promise<Outcome<ContactCounts, O>>;
  /**
   * Deletes a contact, for when the person deletes their account in your app. Name
   * them by your app's userId, the email, or both. Someone AguMail doesn't have counts
   * in `notFound`, never as an error, so a delete is safe to send again. Unsubscribes
   * are kept: someone who unsubscribed and is added again stays unsubscribed.
   *
   * @example
   * await agumail.contacts.delete({ userId: user.id });
   */
  delete<O extends CallOptions | undefined = undefined>(
    contact: ContactRef,
    options?: O
  ): Promise<Outcome<DeleteCounts, O>>;
  /**
   * contacts.delete for any number of contacts, 500 to a request. Every record is
   * checked first, and nothing is sent if one is wrong. Each entry of `conflicted`
   * gives its record's place in your array as `index`.
   *
   * @example
   * await agumail.contacts.deleteMany(closed.map((u) => ({ userId: u.id })));
   */
  deleteMany<O extends CallOptions | undefined = undefined>(
    contacts: readonly ContactRef[],
    options?: O
  ): Promise<Outcome<DeleteCounts, O>>;
}

export interface FormsApi {
  /** Your published AguMail signup forms, and the script that renders them. */
  list<O extends CallOptions | undefined = undefined>(options?: O): Promise<Outcome<FormList, O>>;
}

export interface SignupsApi {
  /**
   * Signups from a form on your own website. AguMail can send a double opt-in email
   * and keeps proof of consent. Pass the visitor's IP: the limit is 10 new addresses
   * per IP a minute.
   *
   * @example
   * await agumail.signups.create({ email, doubleOptIn: true, form: { id: 'footer' }, ip: visitorIp });
   */
  create<O extends CallOptions | undefined = undefined>(
    signups: Signup | readonly Signup[],
    options?: O
  ): Promise<Outcome<SignupCounts, O>>;
}

export interface QueueApi {
  /**
   * Queues a contact for the next flush, subscribed unless `subscribed: false`, as
   * with identify. Never throws: a bad record goes to onError and is not queued.
   * A contact AguMail refuses because its email belongs to someone else is a
   * `conflicts` warning, and is listed in the flush's result.
   *
   * @example
   * agumail.queue.identify({ email: user.email, firstName: user.firstName });
   */
  identify(contact: Contact): void;
  /**
   * Queues an event for the next flush, with its uniqueId fixed now. Its `contact`
   * goes out with the queued contacts, which are all sent before any event.
   * Never throws: a bad record goes to onError and is not queued.
   *
   * @example
   * agumail.queue.track({ email: user.email, event: 'Created project' });
   */
  track(event: TrackEvent): void;
}

export class AguMail {
  readonly contacts: ContactsApi;
  readonly forms: FormsApi;
  readonly signups: SignupsApi;
  /** Records sent later, in batches: by flush(), at flushAt records, or flushIntervalMs after the first. */
  readonly queue: QueueApi;
  readonly #core: Core;

  /**
   * Never throws for a missing key or bad options: the first call reports them.
   *
   * @param apiKey Your AguMail API key. Leave it out, or pass undefined or '', to read AGUMAIL_API_KEY.
   */
  constructor(apiKey?: string | undefined, options: AguMailOptions = {}) {
    if (isBrowser()) throw new Error(BROWSER_MESSAGE);
    const core = new Core(apiKey, options);
    this.#core = core;
    this.contacts = contactsApi(core);
    this.forms = {
      list: <O extends CallOptions | undefined = undefined>(options?: O) =>
        core.run<FormList, O>(options, async (call) => formList(await core.get('/api/v1/forms', call))),
    };
    this.signups = {
      create: <O extends CallOptions | undefined = undefined>(signups: Signup | readonly Signup[], options?: O) =>
        core.run<SignupCounts, O>(options, (call) => {
          const many = Array.isArray(signups);
          const records = (many ? (signups as readonly Signup[]) : [signups as Signup]).map((s, i) =>
            signupRecord(s, many ? `signups[${i}]` : 'signup')
          );
          return core.countBatches(SIGNUPS, records, {}, call);
        }),
    };
    this.queue = {
      identify: (contact: Contact) => core.queueContact(contact),
      track: (event: TrackEvent) => core.queueEvent(event),
    };
    // So `const { identify, track } = agumail` works like the calls on the client.
    this.identify = this.identify.bind(this);
    this.identifyMany = this.identifyMany.bind(this);
    this.track = this.track.bind(this);
    this.trackMany = this.trackMany.bind(this);
    this.ping = this.ping.bind(this);
    this.flush = this.flush.bind(this);
  }

  /**
   * Adds or updates a contact, and subscribes them unless you pass `subscribed: false`.
   * It never brings back someone who unsubscribed or bounced (`suppressedSkipped`).
   * Pass your app's `userId` and AguMail knows them by it, so a changed email moves
   * the same contact. A record that would mix two people up is refused without an
   * error, and listed in `conflicted`.
   *
   * @example
   * await agumail.identify({ email: 'sam@example.com', userId: user.id, firstName: 'Sam' });
   */
  identify<O extends CallOptions | undefined = undefined>(contact: Contact, options?: O): Promise<Outcome<ContactCounts, O>> {
    const core = this.#core;
    return core.run<ContactCounts, O>(options, (call) =>
      core.countBatches(CONTACTS, [contactRecord(contact, 'contact')], {}, call)
    );
  }

  /**
   * identify for any number of contacts, 500 to a request. Every record is checked
   * first, and nothing is sent if one is wrong. Pass `backfill: true` for an import.
   * Each entry of `conflicted` gives its contact's place in your array as `index`.
   *
   * @example
   * await agumail.identifyMany(users.map((u) => ({ email: u.email, subscribed: u.marketingOptIn })), { backfill: true });
   */
  identifyMany<O extends BatchOptions | undefined = undefined>(
    contacts: readonly Contact[],
    options?: O
  ): Promise<Outcome<ContactCounts, O>> {
    const core = this.#core;
    return core.run<ContactCounts, O>(options, (call) => {
      const records = list<Contact>(contacts, 'contacts').map((c, i) => contactRecord(c, `contacts[${i}]`));
      return core.countBatches(CONTACTS, records, backfillOf(options), call);
    });
  }

  /**
   * Records something a contact did, named by email or by your app's `userId`. AguMail
   * skips events for people it doesn't have, so identify them first, or pass `contact`
   * to upsert them (never subscribed) first.
   *
   * @example
   * await agumail.track({ email: 'sam@example.com', event: 'Created project', uniqueId: `project:${id}` });
   */
  track<O extends CallOptions | undefined = undefined>(event: TrackEvent, options?: O): Promise<Outcome<TrackResult, O>> {
    const core = this.#core;
    return core.run<TrackResult, O>(options, async (call) => {
      const checked = eventRecord(event, 'event');
      const sent = await core.sendEvents([checked], {}, call);
      return { ...sent.events, uniqueId: checked.uniqueId, ...(sent.contacts ? { contact: sent.contacts } : {}) };
    });
  }

  /**
   * track for any number of events, 500 to a request, each batch's contacts first.
   * On failure, `error.uniqueIds` holds the id each event was sent with. A conflict
   * in `contacts.conflicted` gives its event's place in your array as `index`.
   *
   * @example
   * const { uniqueIds } = await agumail.trackMany(rows.map((r) => ({ email: r.email, event: 'Imported' })));
   */
  trackMany<O extends BatchOptions | undefined = undefined>(
    events: readonly TrackEvent[],
    options?: O
  ): Promise<Outcome<TrackManyResult, O>> {
    const core = this.#core;
    return core.run<TrackManyResult, O>(options, async (call) => {
      const checked = list<TrackEvent>(events, 'events').map((e, i) => eventRecord(e, `events[${i}]`));
      const sent = await core.sendEvents(checked, backfillOf(options), call);
      return {
        ...sent.events,
        uniqueIds: checked.map((c) => c.uniqueId),
        ...(sent.contacts ? { contacts: sent.contacts } : {}),
      };
    });
  }

  /**
   * Who the key belongs to. A cheap way to check the key and the connection at startup.
   *
   * @example
   * const { shop } = await agumail.ping();
   */
  ping<O extends CallOptions | undefined = undefined>(options?: O): Promise<Outcome<PingResult, O>> {
    const core = this.#core;
    return core.run<PingResult, O>(options, async (call) => {
      const body = await core.get('/api/v1/ping', call);
      const shop = (body.shop ?? {}) as Json;
      return {
        shop: { userId: String(shop.userId ?? ''), shopName: typeof shop.shopName === 'string' ? shop.shopName : null },
      };
    });
  }

  /**
   * Sends everything queued now: contacts first, then events. Never rejects. A
   * failure is in `error` and goes to onError, and the records it held are dropped.
   *
   * @example
   * process.on('SIGTERM', async () => {
   *   await agumail.flush();
   *   process.exit(0);
   * });
   */
  flush(options?: FlushOptions): Promise<FlushResult> {
    return this.#core.flush(options);
  }
}

function contactsApi(core: Core): ContactsApi {
  // Asked 500 at a time, by emails or by userIds: one answer for one, an array for an array.
  const lookup =
    (by: 'email' | 'userId', check: (value: unknown, at: string) => string) =>
    (given: unknown, options?: CallOptions) =>
      core.run<ContactStatus | ContactStatus[], CallOptions | undefined>(options, async (call) => {
        const key = `${by}s`;
        const one = typeof given === 'string' || (by === 'userId' && typeof given === 'number');
        const asked = one ? [check(given, by)] : list<unknown>(given, key).map((v, i) => check(v, `${key}[${i}]`));
        const answers: ContactStatus[] = [];
        for (let i = 0; i < asked.length; i += BATCH_SIZE) {
          const batch = asked.slice(i, i + BATCH_SIZE);
          answers.push(...statuses(await core.post('/api/v1/contacts/status', { [key]: batch }, batch.length, call)));
        }
        if (!one) return answers;
        const first = asked[0]!;
        const unknown = { email: by === 'email' ? first : null, userId: by === 'userId' ? first : null };
        return answers[0] ?? { ...unknown, status: null, subscribed: false };
      });
  return {
    status: lookup('email', statusEmail) as ContactsApi['status'],
    statusByUserId: lookup('userId', statusUserId) as ContactsApi['statusByUserId'],
    subscribe: <O extends CallOptions | undefined = undefined>(emails: string | readonly string[], options?: O) =>
      core.run<ContactCounts, O>(options, (call) => core.consentChange(emails, 'subscribe', call)),
    unsubscribe: <O extends CallOptions | undefined = undefined>(emails: string | readonly string[], options?: O) =>
      core.run<ContactCounts, O>(options, (call) => core.consentChange(emails, 'unsubscribe', call)),
    delete: <O extends CallOptions | undefined = undefined>(contact: ContactRef, options?: O) =>
      core.run<DeleteCounts, O>(options, (call) =>
        core.countBatches(DELETES, [deleteRecord(contact, 'contact')], {}, call)
      ),
    deleteMany: <O extends CallOptions | undefined = undefined>(contacts: readonly ContactRef[], options?: O) =>
      core.run<DeleteCounts, O>(options, (call) => {
        const records = list<unknown>(contacts, 'contacts').map((c, i) => deleteRecord(c, `contacts[${i}]`));
        return core.countBatches(DELETES, records, {}, call);
      }),
  };
}

class Core {
  readonly #transport: Omit<Transport, 'apiKey' | 'keyFromEnv'>;
  readonly #givenKey: string;
  #envKey = '';
  readonly #disabled: boolean;
  readonly #onError: AguMailOptions['onError'];
  readonly #onWarning: AguMailOptions['onWarning'];
  // Bad settings are reported by the first call rather than thrown here: a
  // constructor that throws at import time takes the whole app down with it.
  readonly #configProblem: string | undefined;
  readonly #flushAt: number;
  readonly #flushIntervalMs: number;

  #queuedContacts: Json[] = [];
  #queuedEvents: CheckedEvent[] = [];
  #timer: ReturnType<typeof setTimeout> | undefined;
  // Each flush waits for the one before it, so a record is never sent twice
  // and a later flush's events never overtake an earlier flush's contacts.
  #flushes: Promise<unknown> = Promise.resolve();
  #autoFlushWaiting = false;

  constructor(apiKey: string | undefined, options: AguMailOptions | undefined) {
    const o = (options ?? {}) as AguMailOptions;
    this.#configProblem = configProblem(o);
    this.#disabled = o.disabled === true;
    this.#onError = typeof o.onError === 'function' ? o.onError : undefined;
    this.#onWarning = typeof o.onWarning === 'function' ? o.onWarning : undefined;
    this.#givenKey = typeof apiKey === 'string' ? apiKey.trim() : '';
    this.#flushAt = typeof o.flushAt === 'number' ? o.flushAt : BATCH_SIZE;
    this.#flushIntervalMs = typeof o.flushIntervalMs === 'number' ? o.flushIntervalMs : DEFAULT_FLUSH_INTERVAL_MS;
    this.#transport = {
      baseUrl: normalizeBaseUrl(typeof o.baseUrl === 'string' ? o.baseUrl : undefined),
      timeoutMs: typeof o.timeoutMs === 'number' ? o.timeoutMs : undefined,
      maxRetries: typeof o.maxRetries === 'number' ? o.maxRetries : DEFAULT_MAX_RETRIES,
      fetch: typeof o.fetch === 'function' ? o.fetch : undefined,
    };
  }

  /** Runs one public call: thrown errors by default, `{ data, error }` with `throwOnError: false`. */
  async run<T, O>(options: O | undefined, work: (call: Call) => Promise<T>): Promise<Outcome<T, O>> {
    const given = options as CallOptions | undefined;
    const quiet = given?.throwOnError === false;
    const call: Call = { options: given, tally: emptyTally(), conflicted: [] };
    try {
      if (this.#configProblem) throw invalidInput(this.#configProblem);
      const problem = callProblem(given);
      if (problem) throw invalidInput(problem);
      const data = await work(call);
      return (quiet ? { data, error: null } : data) as Outcome<T, O>;
    } catch (cause) {
      const error = toAguMailError(cause);
      if (!quiet) throw error;
      this.#report(error);
      return { data: null, error } as Outcome<T, O>;
    } finally {
      this.#warn(call);
    }
  }

  post(path: string, body: Json, records: number, call: Call): Promise<Json> {
    if (this.#disabled) return Promise.resolve(disabledAnswer(path, body));
    const { timeoutMs, signal } = call.options ?? {};
    return request(this.#transportNow(), { method: 'POST', path, body, records, timeoutMs, signal });
  }

  get(path: string, call: Call): Promise<Json> {
    if (this.#disabled) return Promise.resolve(disabledAnswer(path, undefined));
    const { timeoutMs, signal } = call.options ?? {};
    return request(this.#transportNow(), { method: 'GET', path, records: 0, timeoutMs, signal });
  }

  /**
   * Sends records in batches, one after another, adding up what each batch reports.
   * `indexOf` turns a record's place in `records` into its place in the caller's array.
   */
  async countBatches<C extends ContactCounts | EventCounts | SignupCounts | DeleteCounts>(
    sender: Sender<C>,
    records: Json[],
    extra: Json,
    call: Call,
    indexOf: (i: number) => number = (i) => i
  ): Promise<C> {
    let total: C | undefined;
    let sent = 0;
    for (const batch of batches(records, (r) => r)) {
      try {
        const offset = sent;
        const body = await this.post(sender.path, { [sender.key]: batch, ...extra }, batch.length, call);
        const counts = sender.read(body, (i) => indexOf(offset + i));
        sender.tally(call, counts);
        total = total ? sender.add(total, counts) : counts;
        sent += batch.length;
      } catch (err) {
        if (err instanceof AguMailError && total && sent > 0) err.partial = { sent, result: total };
        throw err;
      }
    }
    return total ?? sender.read({}, indexOf);
  }

  /** Sends events in batches, upserting the contacts a batch carries just before it. */
  async sendEvents(
    checked: CheckedEvent[],
    extra: Json,
    call: Call
  ): Promise<{ events: EventCounts; contacts?: ContactCounts }> {
    let events = eventCounts({});
    let contacts: ContactCounts | undefined;
    let sent = 0;
    try {
      for (const batch of batches(checked, (c) => c.record)) {
        const people = batch.flatMap((c) => (c.contact ? [c.contact] : []));
        // The place of the event each contact came with, which is what a conflict names.
        const owners = batch.flatMap((c, i) => (c.contact ? [sent + i] : []));
        if (people.length > 0) {
          const landed = await this.countBatches(CONTACTS, people, extra, call, (k) => owners[k] ?? k);
          contacts = contacts ? addContactCounts(contacts, landed) : landed;
        }
        // Judged before sending, but counted only for a batch that lands.
        const history = extra.backfill === true ? 0 : batch.filter((c) => isHistory(c.record)).length;
        const body = { events: batch.map((c) => c.record), ...extra };
        const counts = eventCounts(await this.post('/api/v1/events', body, batch.length, call));
        events = addEventCounts(events, counts);
        sent += batch.length;
        call.tally.unknown_contacts += counts.unknownContacts;
        call.tally.history += history;
      }
    } catch (cause) {
      const error = toAguMailError(cause);
      // About events only: a contact upsert that failed may have set its own.
      if (sent > 0) error.partial = { sent, result: events };
      else delete error.partial;
      error.uniqueIds = checked.map((c) => c.uniqueId);
      throw error;
    }
    return contacts ? { events, contacts } : { events };
  }

  consentChange(emails: string | readonly string[], change: 'subscribe' | 'unsubscribe', call: Call) {
    const one = typeof emails === 'string';
    const addresses = one ? [emails] : list<unknown>(emails, 'emails');
    const records = addresses.map((e, i) => consentRecord(e, one ? 'email' : `emails[${i}]`, change));
    return this.countBatches(CONTACTS, records, {}, call);
  }

  queueContact(input: Contact): void {
    this.#enqueue(() => {
      this.#queuedContacts.push(contactRecord(input, 'contact'));
    });
  }

  queueEvent(input: TrackEvent): void {
    this.#enqueue(() => {
      const { contact, ...event } = eventRecord(input, 'event');
      if (contact) this.#queuedContacts.push(contact);
      this.#queuedEvents.push(event);
    });
  }

  flush(options: FlushOptions | undefined): Promise<FlushResult> {
    const turn = this.#flushes.then(() => this.#flushQueued(options));
    this.#flushes = turn;
    return turn;
  }

  #enqueue(add: () => void): void {
    try {
      if (this.#configProblem) throw invalidInput(this.#configProblem);
      add();
    } catch (cause) {
      this.#report(toAguMailError(cause));
      return;
    }
    if (this.#queuedContacts.length + this.#queuedEvents.length >= this.#flushAt) {
      this.#autoFlush();
    } else if (this.#timer === undefined && this.#flushIntervalMs > 0) {
      this.#timer = setTimeout(() => {
        this.#timer = undefined;
        this.#autoFlush();
      }, this.#flushIntervalMs);
      unref(this.#timer);
    }
  }

  #autoFlush(): void {
    if (this.#autoFlushWaiting) return;
    this.#autoFlushWaiting = true;
    void this.flush(undefined);
  }

  async #flushQueued(options: FlushOptions | undefined): Promise<FlushResult> {
    const result: FlushResult = { contacts: contactCounts({}), events: eventCounts({}), error: null };
    const call: Call = { options, tally: emptyTally(), conflicted: [] };
    let events: CheckedEvent[] = [];
    let sending: 'contacts' | 'events' = 'contacts';
    try {
      // Checked before anything is taken, so bad options leave the queue as it was.
      const problem = callProblem(options);
      if (problem) throw invalidInput(problem);
      const contacts = this.#queuedContacts.splice(0);
      events = this.#queuedEvents.splice(0);
      this.#autoFlushWaiting = false;
      if (this.#timer !== undefined) clearTimeout(this.#timer);
      this.#timer = undefined;
      if (contacts.length > 0) result.contacts = await this.countBatches(CONTACTS, contacts, {}, call);
      sending = 'events';
      if (events.length > 0) result.events = (await this.sendEvents(events, {}, call)).events;
    } catch (cause) {
      const error = toAguMailError(cause);
      const landed = error.partial?.result;
      if (landed && sending === 'contacts') result.contacts = landed as ContactCounts;
      if (landed && sending === 'events') result.events = landed as EventCounts;
      if (events.length > 0) error.uniqueIds = events.map((e) => e.uniqueId);
      result.error = error;
      this.#report(error);
    }
    this.#warn(call);
    return result;
  }

  #transportNow(): Transport {
    if (this.#givenKey) return { ...this.#transport, apiKey: this.#givenKey, keyFromEnv: false };
    // Read when first needed rather than in the constructor, so a .env file
    // loaded after the client was made still counts.
    if (!this.#envKey) this.#envKey = envApiKey();
    return { ...this.#transport, apiKey: this.#envKey, keyFromEnv: true };
  }

  #report(error: AguMailError): void {
    callQuietly(this.#onError, error);
  }

  #warn(call: Call): void {
    if (this.#disabled || !this.#onWarning) return;
    for (const code of WARNING_CODES) {
      const count = call.tally[code];
      if (count <= 0) continue;
      const warning: AguMailWarning = { code, message: warningMessage(code, count), count };
      if (code === 'conflicts') warning.conflicted = call.conflicted;
      callQuietly<AguMailWarning>(this.#onWarning, warning);
    }
  }
}

/** Calls onError or onWarning. Neither a throw nor a rejection from it may reach the caller. */
function callQuietly<A>(listener: ((arg: A) => void | Promise<void>) | undefined, arg: A): void {
  if (!listener) return;
  try {
    const result: unknown = listener(arg);
    if (result && typeof (result as Promise<void>).catch === 'function') (result as Promise<void>).catch(() => {});
  } catch {
    // A failing logger must not turn a quiet call into a thrown one.
  }
}

function warningMessage(code: AguMailWarningCode, n: number): string {
  const many = n !== 1;
  const them = many ? 'them' : 'it';
  switch (code) {
    case 'unknown_contacts':
      return (
        `AguMail skipped ${n} ${many ? 'events' : 'event'} for people it doesn't have. ` +
        'Call identify for them first, or pass contact with the event.'
      );
    case 'over_capacity':
      return `AguMail did not add ${n} new ${many ? 'contacts' : 'contact'}: your plan has no room for more contacts.`;
    case 'signups_limited':
      return (
        `AguMail dropped ${n} ${many ? 'signups' : 'signup'} over its limit of 10 new addresses per visitor IP a minute. ` +
        "Pass the visitor's IP address as ip, not your server's."
      );
    case 'history':
      return (
        `${n} ${many ? 'events' : 'event'} happened more than 72 hours ago, so AguMail stores ${them} as history ` +
        `and starts no flows from ${them}. Send events as they happen, or pass backfill: true for an import.`
      );
    case 'unknown_user_ids':
      return (
        `AguMail skipped ${n} ${many ? 'contacts' : 'contact'} sent with only a userId that no contact has. ` +
        `Send the email with the userId, so AguMail can add ${them}.`
      );
    case 'conflicts':
      return (
        `AguMail refused ${n} ${many ? 'contacts' : 'contact'} whose email belongs to someone else, so that two ` +
        `people are never mixed up: AguMail never merges contacts. warning.conflicted lists ${them}, and why.`
      );
  }
}

function emptyTally(): Tally {
  return { unknown_contacts: 0, over_capacity: 0, signups_limited: 0, history: 0, unknown_user_ids: 0, conflicts: 0 };
}

/** What a disabled client answers in place of AguMail: every count zero, every address and id unknown. */
function disabledAnswer(path: string, body: Json | undefined): Json {
  if (path !== '/api/v1/contacts/status') return {};
  const emails = (body?.emails ?? []) as string[];
  const userIds = (body?.userIds ?? []) as string[];
  return {
    contacts: [
      ...emails.map((email) => ({ email, userId: null, status: null, subscribed: false })),
      ...userIds.map((userId) => ({ email: null, userId, status: null, subscribed: false })),
    ],
  };
}

/** Splits items into batches the server takes: at most 500 records, and under its 5 MB body limit. */
function batches<T>(items: T[], recordOf: (item: T) => Json): T[][] {
  const out: T[][] = [];
  let current: T[] = [];
  let bytes = 0;
  for (const item of items) {
    const size = utf8Length(JSON.stringify(recordOf(item))) + 1;
    if (current.length > 0 && (current.length >= BATCH_SIZE || bytes + size > MAX_REQUEST_BYTES)) {
      out.push(current);
      current = [];
      bytes = 0;
    }
    current.push(item);
    bytes += size;
  }
  if (current.length > 0) out.push(current);
  return out;
}

function configProblem(o: AguMailOptions): string | undefined {
  if (o.baseUrl !== undefined && typeof o.baseUrl !== 'string') return 'options.baseUrl must be a string.';
  if (typeof o.baseUrl === 'string') {
    const problem = baseUrlProblem(normalizeBaseUrl(o.baseUrl));
    if (problem) return problem;
  }
  const timeout = timeoutProblem(o.timeoutMs);
  if (timeout) return timeout;
  if (o.maxRetries !== undefined && !(Number.isInteger(o.maxRetries) && o.maxRetries >= 0)) {
    return 'options.maxRetries must be a whole number, 0 or more.';
  }
  if (o.fetch !== undefined && typeof o.fetch !== 'function') return 'options.fetch must be a function.';
  if (o.onError !== undefined && typeof o.onError !== 'function') return 'options.onError must be a function.';
  if (o.onWarning !== undefined && typeof o.onWarning !== 'function') return 'options.onWarning must be a function.';
  if (o.disabled !== undefined && typeof o.disabled !== 'boolean') return 'options.disabled must be true or false.';
  if (o.flushAt !== undefined && !(Number.isInteger(o.flushAt) && o.flushAt >= 1 && o.flushAt <= BATCH_SIZE)) {
    return `options.flushAt must be a whole number from 1 to ${BATCH_SIZE}.`;
  }
  const interval = o.flushIntervalMs;
  if (interval !== undefined && !(typeof interval === 'number' && interval >= 0 && interval <= MAX_DELAY_MS)) {
    return `options.flushIntervalMs must be a number of milliseconds from 0 (no timer) to ${MAX_DELAY_MS}.`;
  }
  return undefined;
}

function callProblem(call: CallOptions | FlushOptions | undefined): string | undefined {
  if (call === undefined || call === null) return undefined;
  if (typeof call !== 'object') return 'options must be an object.';
  const { throwOnError, backfill } = call as BatchOptions;
  if (throwOnError !== undefined && typeof throwOnError !== 'boolean') return 'options.throwOnError must be true or false.';
  const timeout = timeoutProblem(call.timeoutMs);
  if (timeout) return timeout;
  if (backfill !== undefined && typeof backfill !== 'boolean') return 'options.backfill must be true or false.';
  return undefined;
}

function timeoutProblem(value: unknown): string | undefined {
  if (value === undefined || (typeof value === 'number' && value > 0 && value <= MAX_DELAY_MS)) return undefined;
  return `options.timeoutMs must be a positive number of milliseconds, at most ${MAX_DELAY_MS}.`;
}

function backfillOf(options: BatchOptions | undefined): Json {
  return options?.backfill === true ? { backfill: true } : {};
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

// Counts that only newer AguMail servers send, so they are left out when the server leaves them out.
const LATER_CONTACT_COUNTS = ['confirmationsSent', 'unknownContacts', 'conflicts'] as const;

function contactCounts(body: Json, indexOf: (i: number) => number = (i) => i): ContactCounts {
  const counts: ContactCounts = {
    created: count(body.created),
    updated: count(body.updated),
    suppressedSkipped: count(body.suppressedSkipped),
    overCapacity: count(body.overCapacity),
  };
  for (const key of LATER_CONTACT_COUNTS) {
    const value = body[key];
    if (typeof value === 'number') counts[key] = value;
  }
  if (Array.isArray(body.conflicted)) counts.conflicted = (body.conflicted as Json[]).map((row) => conflict(row, indexOf));
  return counts;
}

function addContactCounts(a: ContactCounts, b: ContactCounts): ContactCounts {
  const sum: ContactCounts = {
    created: a.created + b.created,
    updated: a.updated + b.updated,
    suppressedSkipped: a.suppressedSkipped + b.suppressedSkipped,
    overCapacity: a.overCapacity + b.overCapacity,
  };
  for (const key of LATER_CONTACT_COUNTS) {
    if (a[key] !== undefined || b[key] !== undefined) sum[key] = (a[key] ?? 0) + (b[key] ?? 0);
  }
  if (a.conflicted || b.conflicted) sum.conflicted = [...(a.conflicted ?? []), ...(b.conflicted ?? [])];
  return sum;
}

/** One refused contact, numbered by its place in the caller's array rather than in its request. */
function conflict(row: Json, indexOf: (i: number) => number): ContactConflict {
  return {
    index: indexOf(count(row.index)),
    userId: typeof row.userId === 'string' ? row.userId : null,
    email: typeof row.email === 'string' ? row.email : null,
    reason: String(row.reason) as ContactConflictReason,
  };
}

function eventCounts(body: Json): EventCounts {
  return { created: count(body.created), duplicates: count(body.duplicates), unknownContacts: count(body.unknownContacts) };
}

function addEventCounts(a: EventCounts, b: EventCounts): EventCounts {
  return {
    created: a.created + b.created,
    duplicates: a.duplicates + b.duplicates,
    unknownContacts: a.unknownContacts + b.unknownContacts,
  };
}

function signupCounts(body: Json): SignupCounts {
  return { received: count(body.received), overCapacity: count(body.overCapacity), limited: count(body.limited) };
}

function addSignupCounts(a: SignupCounts, b: SignupCounts): SignupCounts {
  return { received: a.received + b.received, overCapacity: a.overCapacity + b.overCapacity, limited: a.limited + b.limited };
}

const CONTACTS: Sender<ContactCounts> = {
  path: '/api/v1/contacts',
  key: 'contacts',
  read: contactCounts,
  add: addContactCounts,
  tally: (call, counts) => {
    call.tally.over_capacity += counts.overCapacity;
    call.tally.unknown_user_ids += counts.unknownContacts ?? 0;
    call.tally.conflicts += counts.conflicts ?? 0;
    if (counts.conflicted) call.conflicted.push(...counts.conflicted);
  },
};

function deleteCounts(body: Json, indexOf: (i: number) => number = (i) => i): DeleteCounts {
  const rows = Array.isArray(body.conflicted) ? (body.conflicted as Json[]) : [];
  return {
    deleted: count(body.deleted),
    notFound: count(body.notFound),
    conflicts: count(body.conflicts),
    conflicted: rows.map((row) => conflict(row, indexOf)),
  };
}

function addDeleteCounts(a: DeleteCounts, b: DeleteCounts): DeleteCounts {
  return {
    deleted: a.deleted + b.deleted,
    notFound: a.notFound + b.notFound,
    conflicts: a.conflicts + b.conflicts,
    conflicted: [...a.conflicted, ...b.conflicted],
  };
}

// The endpoint is idempotent (someone already deleted is notFound), so a batch
// the transport retries after a lost answer counts the same people once.
const DELETES: Sender<DeleteCounts> = {
  path: '/api/v1/contacts/delete',
  key: 'contacts',
  read: deleteCounts,
  add: addDeleteCounts,
  tally: (call, counts) => {
    call.tally.conflicts += counts.conflicts;
    call.conflicted.push(...counts.conflicted);
  },
};

const SIGNUPS: Sender<SignupCounts> = {
  path: '/api/v1/signups',
  key: 'signups',
  read: signupCounts,
  add: addSignupCounts,
  tally: (call, counts) => {
    call.tally.over_capacity += counts.overCapacity;
    call.tally.signups_limited += counts.limited;
  },
};

function statuses(body: Json): ContactStatus[] {
  const rows = Array.isArray(body.contacts) ? (body.contacts as Json[]) : [];
  return rows.map((row) => ({
    email: typeof row.email === 'string' ? row.email : null,
    userId: typeof row.userId === 'string' ? row.userId : null,
    status: typeof row.status === 'string' ? (row.status as ContactStatusValue) : null,
    subscribed: row.subscribed === true,
  }));
}

function formList(body: Json): FormList {
  const rows = Array.isArray(body.forms) ? (body.forms as Json[]) : [];
  return {
    loaderUrl: typeof body.loaderUrl === 'string' ? body.loaderUrl : '',
    forms: rows.map((row) => ({
      slug: String(row.slug ?? ''),
      name: String(row.name ?? ''),
      doubleOptIn: row.doubleOptIn === true,
      publishedAt: String(row.publishedAt ?? ''),
    })),
  };
}
