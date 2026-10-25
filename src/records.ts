// Every record is checked here against the rules the AguMail server applies
// (src/integrations/ingest.ts and src/forms/siteSignup.ts in AguMail), before
// anything is sent. The server refuses a whole batch for one bad record, and
// quietly replaces an unreadable date or time zone; both are worse than an
// error that names the field.

import { invalidInput } from './errors';
import { randomId } from './runtime';
import type { Contact, ContactProfile, Signup, TrackEvent } from './types';

type Json = Record<string, unknown>;

export const BATCH_SIZE = 500;
/** The server reads at most 5 MB of JSON a request. */
export const MAX_REQUEST_BYTES = 4_500_000;

const NAME_MAX = 100;
const PHONE_MAX = 40;
const TIMEZONE_MAX = 64;
const TAGS_MAX = 20;
const TAG_MAX = 60;
const CUSTOM_FIELDS_MAX = 30;
const CUSTOM_FIELD_KEY_MAX = 60;
const CUSTOM_FIELD_VALUE_MAX = 500;
const METRIC_MAX = 60;
const UNIQUE_ID_MAX = 120;
const EVENT_PROPERTIES_MAX = 30;
const EVENT_PROPERTIES_CHARS = 8000;
const STATUS_EMAIL_MAX = 320;
const USER_ID_MAX = 200;
const SIGNUP_EMAIL_MAX = 254;
const FORM_ID_MAX = 100;
const FORM_NAME_MAX = 200;
const PAGE_URL_MAX = 2000;
const IP_MAX = 64;
const CONSENT_TEXT_MAX = 1000;

// zod 4.6.5's email check, which /api/v1/contacts and /api/v1/events run.
const EMAIL = /^(?:[A-Za-z0-9_'+\-]+\.)*[A-Za-z0-9_'+\-]*[A-Za-z0-9_+-]@(?:[A-Za-z0-9][A-Za-z0-9\-]*\.)+[A-Za-z]{2,}$/;
// The hosted form's looser check, which /api/v1/signups runs.
const SIGNUP_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const BUILDER = /^[a-z0-9][a-z0-9_-]{0,39}$/;

const PROFILE_FIELDS = ['firstName', 'lastName', 'phone', 'timezone', 'tags', 'properties', 'customerSince'];
const CONTACT_FIELDS = ['email', 'userId', 'subscribed', ...PROFILE_FIELDS];
const EVENT_FIELDS = ['email', 'userId', 'event', 'properties', 'value', 'occurredAt', 'uniqueId', 'contact'];
const SIGNUP_FIELDS = [
  'email',
  'doubleOptIn',
  'form',
  'firstName',
  'lastName',
  'phone',
  'tags',
  'pageUrl',
  'ip',
  'consentText',
  'occurredAt',
];
const FORM_FIELDS = ['id', 'name', 'builder'];

const CONTACT_HINTS: Record<string, string> = {
  name: 'Use firstName and lastName.',
  customFields: 'Use properties.',
};
// The contact track upserts is named by the event's own email and userId.
const PROFILE_HINTS: Record<string, string> = {
  ...CONTACT_HINTS,
  email: 'Put it on the event itself.',
  userId: 'Put it on the event itself.',
};
const EVENT_HINTS: Record<string, string> = {
  metric: 'Use event.',
  name: 'Use event.',
  eventName: 'Use event.',
  event_name: 'Use event.',
};

// The server's own line (src/audience/history.ts): an event dated earlier than
// this is stored as history, and starts no flows, even without backfill.
const HISTORY_AGE_MS = 72 * 60 * 60 * 1000;

// ── Contacts ─────────────────────────────────────────────────────────────────

/** The record identify sends: subscribed unless `subscribed: false`. */
export function contactRecord(input: Contact, at: string): Json {
  const c = object(input, at);
  knownKeys(c, CONTACT_FIELDS, at, CONTACT_HINTS, 'Put your own fields in properties.');
  if (c.subscribed !== undefined && typeof c.subscribed !== 'boolean') {
    throw invalidInput(`${at}.subscribed must be true or false.`);
  }
  return {
    ...identity(c, at),
    ...profileFields(c, at),
    consent: { optedIn: c.subscribed !== false, source: 'api' },
  };
}

/** The record track sends before its event: who the event names and the profile, with nothing about consent. */
export function profileRecord(who: Json, input: ContactProfile, at: string): Json {
  const c = object(input, at);
  knownKeys(c, PROFILE_FIELDS, at, PROFILE_HINTS, 'Put your own fields in properties.');
  return { ...who, ...profileFields(c, at) };
}

export function consentRecord(address: unknown, at: string, change: 'subscribe' | 'unsubscribe'): Json {
  const checked = email(address, at);
  // `my_account` is the person's own switch in their account settings: the one
  // source AguMail lets ask somebody back (src/audience/rejoin.ts).
  return change === 'subscribe'
    ? { email: checked, consent: { optedIn: true, source: 'my_account' } }
    : { email: checked, unsubscribed: true, consentSource: 'my_account' };
}

/**
 * Who a contact or event is about: an email, your app's userId, or both. With a
 * userId the server finds the person by it, and a contact record may move them
 * to the email beside it (src/audience/contactIdentity.ts in AguMail).
 */
function identity(r: Json, at: string): Json {
  const out: Json = {};
  if (r.email !== undefined && r.email !== null) out.email = email(r.email, `${at}.email`);
  set(out, 'userId', userId(r.userId, `${at}.userId`));
  if (out.email === undefined && out.userId === undefined) throw invalidInput(`${at}.email is required when there is no userId.`);
  return out;
}

function profileFields(c: Json, at: string): Json {
  const out: Json = {};
  set(out, 'firstName', text(c.firstName, `${at}.firstName`, NAME_MAX));
  set(out, 'lastName', text(c.lastName, `${at}.lastName`, NAME_MAX));
  set(out, 'phone', text(c.phone, `${at}.phone`, PHONE_MAX));
  set(out, 'timezone', timezone(c.timezone, `${at}.timezone`));
  set(out, 'tags', tags(c.tags, `${at}.tags`));
  set(out, 'customFields', customFields(c.properties, `${at}.properties`));
  set(out, 'customerSince', date(c.customerSince, `${at}.customerSince`));
  return out;
}

/**
 * Contact properties as the server keeps them: a flat map of text. A null
 * blanks the field, because the server merges what it is sent into what it
 * has and has no other way to clear a key.
 */
function customFields(value: unknown, at: string): Record<string, string> | undefined {
  if (value === undefined || value === null) return undefined;
  const props = object(value, at);
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(props)) {
    const field = path(at, key);
    if (key.length > CUSTOM_FIELD_KEY_MAX) {
      throw invalidInput(`${field}: property names can be at most ${CUSTOM_FIELD_KEY_MAX} characters (this one has ${key.length}).`);
    }
    const converted = fieldText(raw, field);
    if (converted === undefined) continue;
    if (converted.length > CUSTOM_FIELD_VALUE_MAX) {
      throw invalidInput(
        `${field}: property values can be at most ${CUSTOM_FIELD_VALUE_MAX} characters (this one has ${converted.length}).`
      );
    }
    out[key] = converted;
  }
  const count = Object.keys(out).length;
  if (count > CUSTOM_FIELDS_MAX) {
    throw invalidInput(`${at}: a contact can have at most ${CUSTOM_FIELDS_MAX} properties (this one has ${count}).`);
  }
  return count > 0 ? out : undefined;
}

function fieldText(value: unknown, at: string): string | undefined {
  if (value === undefined) return undefined;
  if (value === null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw invalidInput(`${at} must be a finite number (got ${value}).`);
    return String(value);
  }
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw invalidInput(`${at} is an invalid Date.`);
    return value.toISOString();
  }
  throw invalidInput(
    `${at} must be text, a number, a boolean or a Date (got ${describe(value)}). ` +
      'AguMail keeps contact properties as text: use JSON.stringify for a structure, or tags for a list.'
  );
}

// ── Events ───────────────────────────────────────────────────────────────────

export interface CheckedEvent {
  record: Json;
  uniqueId: string;
  /** The contact upsert that goes first, when the event names one. */
  contact?: Json;
}

export function eventRecord(input: TrackEvent, at: string): CheckedEvent {
  const e = object(input, at);
  knownKeys(e, EVENT_FIELDS, at, EVENT_HINTS);
  const who = identity(e, at);
  const metric = requiredText(e.event, `${at}.event`, METRIC_MAX).trim();
  if (!/[A-Za-z0-9]/.test(metric)) {
    throw invalidInput(
      `${at}.event needs at least one letter or digit. AguMail files "Booked appointment" as booked_appointment.`
    );
  }
  // Made once, here, so every retry of this event carries the same id.
  const uniqueId =
    e.uniqueId === undefined || e.uniqueId === null ? randomId() : requiredText(e.uniqueId, `${at}.uniqueId`, UNIQUE_ID_MAX);

  const record: Json = { ...who, metric, uniqueId };
  set(record, 'occurredAt', date(e.occurredAt, `${at}.occurredAt`));
  if (e.value !== undefined && e.value !== null) {
    if (typeof e.value !== 'number' || !Number.isFinite(e.value)) {
      throw invalidInput(`${at}.value must be a finite number (got ${describe(e.value)}).`);
    }
    record.value = e.value;
  }
  set(record, 'properties', eventProperties(e.properties, `${at}.properties`));

  const checked: CheckedEvent = { record, uniqueId };
  if (e.contact !== undefined && e.contact !== null) {
    checked.contact = profileRecord(who, e.contact as ContactProfile, `${at}.contact`);
  }
  return checked;
}

/** Will AguMail count this event as history? Worked out from its occurredAt, as the server does. */
export function isHistory(record: Json, now: number = Date.now()): boolean {
  if (typeof record.occurredAt !== 'string') return false;
  return now - Date.parse(record.occurredAt) > HISTORY_AGE_MS;
}

/** Event properties may nest. They are sent exactly as JSON carries them, so what is measured is what is sent. */
function eventProperties(value: unknown, at: string): Json | undefined {
  if (value === undefined || value === null) return undefined;
  object(value, at);
  let json: string;
  try {
    json = JSON.stringify(value);
  } catch (cause) {
    throw invalidInput(`${at} cannot be sent as JSON: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
  const parsed = JSON.parse(json) as Json;
  const count = Object.keys(parsed).length;
  if (count > EVENT_PROPERTIES_MAX) {
    throw invalidInput(`${at}: an event can have at most ${EVENT_PROPERTIES_MAX} properties (this one has ${count}).`);
  }
  if (json.length > EVENT_PROPERTIES_CHARS) {
    throw invalidInput(
      `${at}: event properties can be at most ${EVENT_PROPERTIES_CHARS} characters as JSON (these are ${json.length}).`
    );
  }
  return count > 0 ? parsed : undefined;
}

// ── Signups ──────────────────────────────────────────────────────────────────

export function signupRecord(input: Signup, at: string): Json {
  const s = object(input, at);
  knownKeys(s, SIGNUP_FIELDS, at, {});
  if (typeof s.doubleOptIn !== 'boolean') {
    throw invalidInput(`${at}.doubleOptIn must be true or false: say whether AguMail sends a confirmation email first.`);
  }
  const form = object(s.form, `${at}.form`);
  knownKeys(form, FORM_FIELDS, `${at}.form`, {});
  const id = requiredText(form.id, `${at}.form.id`, FORM_ID_MAX);
  const builder = text(form.builder, `${at}.form.builder`, 40);
  if (builder !== undefined && !BUILDER.test(builder)) {
    throw invalidInput(
      `${at}.form.builder must be a short lowercase name such as "webflow" (letters, digits, - and _, up to 40).`
    );
  }
  const record: Json = {
    email: signupEmail(s.email, `${at}.email`),
    doubleOptIn: s.doubleOptIn,
    // The server falls back to the id for a form without a name; sending it
    // keeps today's server, which still asks for one, happy too.
    form: { id, name: text(form.name, `${at}.form.name`, FORM_NAME_MAX) || id, ...(builder ? { builder } : {}) },
  };
  set(record, 'firstName', text(s.firstName, `${at}.firstName`, NAME_MAX));
  set(record, 'lastName', text(s.lastName, `${at}.lastName`, NAME_MAX));
  set(record, 'phone', text(s.phone, `${at}.phone`, PHONE_MAX));
  set(record, 'tags', tags(s.tags, `${at}.tags`));
  set(record, 'pageUrl', text(s.pageUrl, `${at}.pageUrl`, PAGE_URL_MAX));
  set(record, 'ip', text(s.ip, `${at}.ip`, IP_MAX));
  set(record, 'consentText', text(s.consentText, `${at}.consentText`, CONSENT_TEXT_MAX));
  set(record, 'occurredAt', date(s.occurredAt, `${at}.occurredAt`));
  return record;
}

// ── Status ───────────────────────────────────────────────────────────────────

/** The status endpoint answers null for anything that is not a contact, so only the type and length are checked. */
export function statusEmail(value: unknown, at: string): string {
  if (typeof value !== 'string') throw invalidInput(`${at} must be an email address (got ${describe(value)}).`);
  if (value.length > STATUS_EMAIL_MAX) {
    throw invalidInput(`${at} can be at most ${STATUS_EMAIL_MAX} characters (this one has ${value.length}).`);
  }
  return value;
}

/** As loose as statusEmail: an id nobody has simply answers null. */
export function statusUserId(value: unknown, at: string): string {
  const id = idText(value, at);
  if (id.length > USER_ID_MAX) throw invalidInput(`${at} can be at most ${USER_ID_MAX} characters (this one has ${id.length}).`);
  return id;
}

// ── Shared checks ────────────────────────────────────────────────────────────

export function list<T>(value: unknown, at: string): T[] {
  if (!Array.isArray(value)) throw invalidInput(`${at} must be an array (got ${describe(value)}).`);
  return value as T[];
}

function email(value: unknown, at: string): string {
  if (typeof value !== 'string') throw invalidInput(`${at} must be an email address (got ${describe(value)}).`);
  const trimmed = value.trim();
  if (!EMAIL.test(trimmed)) throw invalidInput(`${at} is not an email address AguMail accepts: "${value}".`);
  return trimmed;
}

/** Your app's id for a person, as the server keeps it: never trimmed or cased. */
function userId(value: unknown, at: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  const id = idText(value, at);
  if (id.trim() === '') throw invalidInput(`${at} cannot be blank.`);
  if (id.length > USER_ID_MAX) throw invalidInput(`${at} can be at most ${USER_ID_MAX} characters (this one has ${id.length}).`);
  return id;
}

/** An id as the server takes it, which is always text: a whole number is sent as its digits. */
function idText(value: unknown, at: string): string {
  if (typeof value === 'string') return value;
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw invalidInput(`${at} must be text or a whole number (got ${describe(value)}).`);
  }
  if (!Number.isSafeInteger(value)) throw invalidInput(`${at} is too big to be exact as a number (got ${value}): send it as text.`);
  return String(value);
}

function signupEmail(value: unknown, at: string): string {
  if (typeof value !== 'string') throw invalidInput(`${at} must be an email address (got ${describe(value)}).`);
  const trimmed = value.trim();
  if (trimmed.length > SIGNUP_EMAIL_MAX || !SIGNUP_EMAIL.test(trimmed)) {
    throw invalidInput(`${at} is not an email address AguMail accepts: "${value}".`);
  }
  return trimmed;
}

function text(value: unknown, at: string, max: number): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw invalidInput(`${at} must be text (got ${describe(value)}).`);
  if (value.length > max) throw invalidInput(`${at} can be at most ${max} characters (this one has ${value.length}).`);
  return value;
}

function requiredText(value: unknown, at: string, max: number): string {
  const checked = text(value, at, max);
  if (checked === undefined || checked.trim() === '') throw invalidInput(`${at} is required.`);
  return checked;
}

function tags(value: unknown, at: string): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  const names = list<unknown>(value, at);
  if (names.length > TAGS_MAX) throw invalidInput(`${at}: at most ${TAGS_MAX} tags (got ${names.length}).`);
  return names.map((name, i) => {
    const tag = text(name, `${at}[${i}]`, TAG_MAX);
    if (tag === undefined || tag.trim() === '') throw invalidInput(`${at}[${i}] must be a tag name.`);
    return tag;
  });
}

/** A date the server will read the same way: always sent as ISO 8601. */
function date(value: unknown, at: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw invalidInput(`${at} is an invalid Date.`);
    return value.toISOString();
  }
  if (typeof value !== 'string') throw invalidInput(`${at} must be a Date or an ISO 8601 string (got ${describe(value)}).`);
  const parsed = Date.parse(value.trim());
  if (Number.isNaN(parsed)) {
    throw invalidInput(`${at} is not a date AguMail can read: "${value}". Use a Date or a string like 2026-10-24T09:00:00Z.`);
  }
  return new Date(parsed).toISOString();
}

function timezone(value: unknown, at: string): string | undefined {
  const zone = text(value, at, TIMEZONE_MAX)?.trim();
  if (!zone) return undefined;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
  } catch {
    throw invalidInput(`${at} is not a time zone AguMail knows: "${zone}". Use an IANA name such as "Europe/Lisbon".`);
  }
  return zone;
}

function object(value: unknown, at: string): Json {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || value instanceof Date) {
    throw invalidInput(`${at} must be an object (got ${describe(value)}).`);
  }
  return value as Json;
}

function knownKeys(value: Json, allowed: string[], at: string, hints: Record<string, string>, fallback = ''): void {
  for (const key of Object.keys(value)) {
    if (allowed.includes(key)) continue;
    const hint = hints[key] ?? fallback;
    throw invalidInput(`${path(at, key)} is not a field AguMail knows.${hint ? ` ${hint}` : ''}`);
  }
}

function set(target: Json, key: string, value: unknown): void {
  if (value !== undefined) target[key] = value;
}

function path(at: string, key: string): string {
  return /^[A-Za-z_$][\w$]*$/.test(key) ? `${at}.${key}` : `${at}[${JSON.stringify(key)}]`;
}

function describe(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  if (value instanceof Date) return 'a Date';
  if (typeof value === 'object') return 'an object';
  if (typeof value === 'string') return `"${value}"`;
  return `${typeof value} ${String(value)}`;
}
