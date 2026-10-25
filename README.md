# agumail-js

Add your users to [AguMail](https://agumail.com) and record what they do, so your AguMail flows (onboarding, trial ending, win-back) can start from it. Built for the server side of a SaaS app.

- No dependencies. Works on Node 18+, Bun, Deno, Cloudflare Workers and Vercel Edge.
- ESM and CommonJS, with TypeScript types included.
- Retries rate limits, server errors, network errors and timeouts for you, without recording an event twice.

This package is for marketing email. AguMail does not send transactional email, so there is no "send this email" call.

## Install

```sh
npm install agumail-js
```

## Quickstart

```ts
import { AguMail } from 'agumail-js';
const agumail = new AguMail(); // reads AGUMAIL_API_KEY
await agumail.identify({ email: 'sam@example.com', firstName: 'Sam' });
```

Then record what Sam does:

```ts
await agumail.track({ email: 'sam@example.com', event: 'Created first project' });
```

Get a key in AguMail under **Settings > Store & API > API keys > Create key**, and choose **Other store or your own code**. The key is secret: keep it in an environment variable on your server. With no key passed, the client reads `AGUMAIL_API_KEY`. You can also pass it yourself: `new AguMail(process.env.MY_KEY)`.

The API is on every AguMail plan, the free one included.

Both calls resolve with what AguMail counted:

```ts
const added = await agumail.identify({ email: 'sam@example.com', firstName: 'Sam' });
// { created: 1, updated: 0, suppressedSkipped: 0, overCapacity: 0, confirmationsSent: 0,
//   unknownContacts: 0, conflicts: 0, conflicted: [] }

const recorded = await agumail.track({ email: 'sam@example.com', event: 'Created first project' });
// { created: 1, duplicates: 0, unknownContacts: 0, uniqueId: '0b6f9d3e-...' }
```

- `created` and `updated`: a new contact or event, or a contact AguMail already had.
- `suppressedSkipped`: they unsubscribed, marked an email as spam or bounced, so their subscription was left alone (see [Who gets email](#who-gets-email)).
- `overCapacity`: your plan has no room for another contact, so they weren't added.
- `confirmationsSent`: confirmation emails AguMail sent, for someone coming back after unsubscribing (see [Email settings in your app](#email-settings-in-your-app)).
- `duplicates`: an event with this `uniqueId` was already recorded, so this one wasn't.
- `unknownContacts`: AguMail doesn't have this person, so the event was skipped. For a contact, it counts those sent with only a `userId` that nobody has.
- `conflicts` and `conflicted`: contacts refused because their email belongs to someone else (see [Identify by your app's user id](#identify-by-your-apps-user-id)).
- `uniqueId`: the id the event was sent with: yours, or one the package made up.

## Never break a signup

By default every call throws an `AguMailError` when it fails. On a signup path you usually want the opposite: AguMail being slow or down should never stop someone from creating an account. Pass `noThrow` and the call never throws or rejects. It resolves to `{ data, error }`:

```ts
import { AguMail, noThrow } from 'agumail-js';

const { data, error } = await agumail.identify({ email }, noThrow);
if (error) console.warn('AguMail:', error.message);
```

`noThrow` is `{ throwOnError: false }`. If you write that object yourself, write it in the call, so TypeScript knows the call returns `{ data, error }`. When `throwOnError` is only known at run time (a `boolean`, or a `CallOptions` variable), the result could be either, and TypeScript makes you check.

Even better, don't wait for it at all. How depends on where your code runs:

```ts
// Long-running servers (Express, Fastify, Wasp): start it and move on.
void agumail.identify({ email }, noThrow);

// Next.js 15.1+: run it after the response is sent.
import { after } from 'next/server';
after(() => agumail.identify({ email }, noThrow));

// Vercel functions outside Next.js: keep the function alive until it finishes.
import { waitUntil } from '@vercel/functions';
waitUntil(agumail.identify({ email }, noThrow));

// Cloudflare Workers: ctx is the third argument of your fetch handler.
ctx.waitUntil(agumail.identify({ email }, noThrow));
```

To add someone and then record an event without waiting, keep both calls in one chain, so the event can't arrive before the contact ([Express](#express) shows how), or use [the queue](#batching-with-the-queue).

When nobody reads the result, errors would go unnoticed, so give the client an `onError`. Give it an `onWarning` too: it tells you when AguMail took a call without an error but dropped or held back some of it.

```ts
const agumail = new AguMail(process.env.AGUMAIL_API_KEY, {
  onError: (error) => console.error('AguMail:', error.code, error.message),
  onWarning: (warning) => console.warn('AguMail:', warning.code, warning.message),
});
```

`onError` gets the error of every call made with `throwOnError: false`, every record the queue refused, and every flush that failed. Errors you get yourself, from calls that throw, don't go to it.

| `warning.code` | What happened |
|---|---|
| `unknown_contacts` | Events for people AguMail doesn't have were skipped. Identify them first, or pass `contact`. |
| `over_capacity` | Contacts or signups weren't added because your plan has no room for more contacts. |
| `signups_limited` | Signups over the limit of 10 new addresses per visitor IP a minute were dropped. |
| `history` | Events dated more than 72 hours ago, sent without `backfill: true`, were stored but start no flows. |
| `unknown_user_ids` | Contacts sent with only a `userId` that nobody has were skipped. Send the email too, so AguMail can add them. |
| `conflicts` | Contacts whose email belongs to someone else were refused. `warning.conflicted` lists them. |

Each warning fires at most once per call (or flush), and `warning.count` adds up the records it covers. Warnings fire for calls that throw and calls that don't. Duplicates and `suppressedSkipped` are normal, so they never warn. Both callbacks may be async, and neither can make a call fail.

A missing API key does not throw when the client is created either, so it can't take your app down at startup. The first call reports it. Use `await agumail.ping()` if you want to check the key when your server starts.

## Who gets email

**`identify` subscribes people by default.** It tells AguMail the person agreed to marketing email, so your campaigns and flows can email them.

To add someone without subscribing them, pass `subscribed: false`. They are on your list as **Never subscribed**, and campaigns and flows do not email them. If your signup form has a "send me product news" box, pass its value:

```ts
await agumail.identify({ email: user.email, subscribed: user.wantsMarketingEmail });
```

Rules to know:

1. **`subscribed: false` never unsubscribes anyone.** It means "add them, but don't subscribe them". Someone who is already subscribed stays subscribed. To stop email for someone, use [`contacts.unsubscribe`](#email-settings-in-your-app).
2. **`identify` never brings back someone who left.** People who unsubscribed, marked an email as spam or bounced stay that way, however often you send them. They are counted in `suppressedSkipped`, and their name, properties and tags are still updated.
3. **`identify` skips double opt-in.** Someone who signed up through a double opt-in form and hasn't clicked the confirmation email yet becomes Subscribed, without the click, when you identify them. If you use double opt-in, identify those people only after they confirm (`contacts.status` shows `unconfirmed` until then).
4. **`track` never changes anyone's subscription.**

## Record what people do

```ts
await agumail.track({
  email: user.email,
  event: 'Upgraded plan',
  properties: { plan: 'pro', seats: 5 },
  value: 49,
  uniqueId: `upgrade:${invoice.id}`,
});
```

- `event` is your own name for what happened. Spelling and capitals do not matter: "Upgraded plan" and "upgraded_plan" are one event.
- `uniqueId` is your id for this occurrence. AguMail never records the same id twice, across your whole account and every event name, so prefix it with the event (`upgrade:in_123`, not `in_123`). See [Sending an event again](#sending-an-event-again).
- `occurredAt` is when it happened, as a `Date` or an ISO string. It defaults to now. **Anything more than 72 hours old counts as history**: AguMail stores it but starts no flows from it.
- `properties` can nest, and your emails can print them (`{{event.plan}}`).
- `value` is a number, such as what the event was worth. AguMail stores no currency with it, so send every amount in the same currency.

**AguMail skips events for people it doesn't have** (counted in `unknownContacts`), because an event is not permission to email someone. Call `identify` when someone signs up, then `track` from then on. Or pass `contact` and the package upserts them first:

```ts
await agumail.track({ email: user.email, event: 'Logged in', contact: { firstName: user.firstName } });
```

A contact that `track` creates this way is **Never subscribed**, because `track` never changes subscriptions. **Flows started by an event only email Subscribed people**, so make sure your signup calls `identify`.

### Sending an event again

Leave `uniqueId` out and the package makes one up and reuses it on every retry, so its own retries never record an event twice. That id is new on every call, though. A webhook delivered twice, or a job that runs again, records the event twice unless you pass your own id, such as the webhook's event id.

When `track` or `trackMany` fails, `error.uniqueIds` holds the id each event was sent with, in the order you passed them. Send them again with those ids, and the ones that already landed count as duplicates instead of being recorded twice:

```ts
const result = await agumail.trackMany(events, noThrow);
if (result.error?.uniqueIds) {
  const ids = result.error.uniqueIds;
  // Now or later: the same ids, so nothing is recorded twice.
  await agumail.trackMany(events.map((event, i) => ({ ...event, uniqueId: ids[i] })));
}
```

## Identify by your app's user id

If your app gives each user an id, send it as `userId` beside the email. AguMail then knows the person by that id: when they change their email in your app, your next `identify` moves the same contact to the new address. Their status, tags, history and flows stay with them, and they are not counted twice.

```ts
await agumail.identify({ userId: user.id, email: user.email, firstName: user.firstName });
```

- `userId` is your own id for the person: text up to 200 characters, sent exactly as you give it, or a whole number, which is sent as text. A contact keeps the first id it is sent with.
- A contact AguMail already has by email takes the id the first time you send both.
- With a `userId`, the email is optional: `identify({ userId: user.id, ... })` updates that contact. If nobody has that id, the record is skipped and counted in `unknownContacts`, because a new contact needs an email.
- `track` takes `userId` in place of `email`, or beside it. With a `userId`, AguMail finds the person by the id alone, and an event never changes anyone's email or id.
- The `contact` you pass to `track` goes with the event's `userId` and `email`. That upsert works like `identify` (without touching their subscription), so with both it can move the contact to that email.
- A new address that is on your suppression list stays blocked: the contact keeps its status, and nothing is sent to that address.

AguMail never merges two contacts. A record that would mix two people up is refused without an error, and the rest of the call still lands:

- `email_taken`: the new email already belongs to another contact.
- `user_id_mismatch`: the contact with that email already has a different `userId`.

`conflicts` counts them and `conflicted` lists each one. `index` is its place in the array you passed, from 0, and for `trackMany`, the place of the event that carried the `contact`:

```ts
const result = await agumail.identifyMany(users.map((u) => ({ userId: u.id, email: u.email })));
// { ..., conflicts: 1, conflicted: [{ index: 1, userId: 'user_77', email: 'alex@example.com', reason: 'email_taken' }] }
```

`onWarning` gets a `conflicts` warning with the same list in `warning.conflicted`, and an `unknown_user_ids` warning for ids nobody has. For [the queue](#batching-with-the-queue), these warnings are how you hear about them, since nobody reads the result of a flush the queue starts itself. In a flush, `index` is the place among the contacts that flush sent, in the order you queued them.

To ask where someone stands by their id, use `contacts.statusByUserId`. It takes one id or an array, like `contacts.status`:

```ts
const sam = await agumail.contacts.statusByUserId(user.id);
// { email: 'sam@example.com', userId: 'user_8412', status: 'active', subscribed: true }
```

For an id nobody has, `email` and `status` are `null`.

`ping()` returns a `shop.userId` too. That one is your AguMail account's id, not one of your users' ids.

## Contact properties

`properties` become the contact's custom fields in AguMail. AguMail keeps them as text, so the package converts for you:

| You pass | AguMail stores |
|---|---|
| `'pro'` | `pro` |
| `3`, `9.5` | `3`, `9.5` |
| `true` | `true` |
| `new Date(...)` | an ISO date, `2026-11-01T00:00:00.000Z` |
| `null` | an empty value (this is how to clear a field) |
| `undefined` | nothing: the field is left as it was |

Arrays and objects are refused: use tags for a list, or `JSON.stringify` it yourself. Properties are merged into what AguMail already has, so sending one field never deletes the others. Changing a property can start a flow that waits for that field.

## Email settings in your app

If your app has a "marketing email" switch in its settings, tell AguMail when the person changes it:

```ts
await agumail.contacts.unsubscribe(user.email); // they switched it off
await agumail.contacts.subscribe(user.email);   // they switched it on
```

Call these only when the signed-in person changes the setting themselves, never from a sync. They take email addresses, not user ids, so a switch-off holds even for someone AguMail doesn't have yet. When they switch it back on:

- If they switched it off in your app, they are subscribed again straight away.
- If they clicked unsubscribe in one of your emails, or marked one as spam, AguMail sends them one confirmation email (at most one a day), and they are back when they click it. `confirmationsSent` in the result counts these, so you can tell them to check their inbox.
- If their address bounced, they can't be subscribed again.

`contacts.subscribe` also subscribes someone new, or someone Never subscribed, straight away.

To show the switch in the right position, ask AguMail. `subscribed` is the value to use:

```ts
const sam = await agumail.contacts.status('sam@example.com');
// { email: 'sam@example.com', userId: 'user_8412', status: 'active', subscribed: true }
```

`status` is `null` for an address that isn't on your list, and `userId` is `null` when the contact has none. Pass an array to ask about as many addresses as you like: the package asks 500 at a time and keeps your order. To ask by your app's user ids, use [`contacts.statusByUserId`](#identify-by-your-apps-user-id).

## Examples

### Next.js route handler

```ts
// app/api/signup/route.ts
import { after } from 'next/server';
import { AguMail, noThrow } from 'agumail-js';
import { createUser } from '@/lib/users';

const agumail = new AguMail(process.env.AGUMAIL_API_KEY, {
  onError: (error) => console.error('AguMail:', error.message),
});

export async function POST(request: Request) {
  const { email, name, newsletter } = await request.json();
  const user = await createUser({ email, name });

  // Runs after the response is sent, and Next.js keeps the function alive for it.
  after(async () => {
    await agumail.identify(
      { email: user.email, firstName: user.name, subscribed: newsletter === true, properties: { plan: 'trial' } },
      noThrow
    );
    // After identify, so AguMail already has them.
    await agumail.track({ email: user.email, event: 'Signed up' }, noThrow);
  });

  return Response.json({ id: user.id }, { status: 201 });
}
```

`after` comes with Next.js 15.1 and later. Outside Next.js on Vercel, `waitUntil` from `@vercel/functions` does the same job, and on Cloudflare Workers, `ctx.waitUntil` does.

### Express

```ts
import express from 'express';
import { AguMail, noThrow } from 'agumail-js';
import { createUser, createProject } from './db';

const agumail = new AguMail(process.env.AGUMAIL_API_KEY, {
  onError: (error) => console.error('AguMail:', error.message),
});

const app = express();
app.use(express.json());

app.post('/signup', async (req, res) => {
  const user = await createUser(req.body);
  // One chain, started and not awaited: the event goes only once the contact is in.
  void (async () => {
    await agumail.identify({ email: user.email, firstName: user.firstName }, noThrow);
    await agumail.track({ email: user.email, event: 'Signed up' }, noThrow);
  })();
  res.status(201).json({ id: user.id });
});

app.post('/projects', async (req, res) => {
  const project = await createProject(req.user, req.body);
  void agumail.track(
    {
      email: req.user.email,
      event: 'Created project',
      properties: { projectId: project.id, template: project.template },
      uniqueId: `project_created:${project.id}`,
    },
    noThrow
  );
  res.status(201).json(project);
});
```

Calls made with `noThrow` never reject, so the chain never does either.

### Wasp

One client for the whole server:

```ts
// src/server/agumail.ts
import { AguMail } from 'agumail-js';

export const agumail = new AguMail(process.env.AGUMAIL_API_KEY, {
  onError: (error) => console.error('[agumail]', error.code, error.message),
});
```

Add every new user from Wasp's `onAfterSignup` hook:

```ts
// src/auth/agumail.ts
import type { OnAfterSignupHook } from 'wasp/server/auth';
import { noThrow } from 'agumail-js';
import { agumail } from '../server/agumail';

export const addToAguMail: OnAfterSignupHook = async ({ user }) => {
  if (!user.email) return;
  // Not awaited, and never throws: AguMail can't hold up or fail a signup.
  void agumail.identify(
    {
      userId: user.id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      properties: { plan: user.isFreeTrial ? 'trial' : 'paid', trialEndsAt: user.freeTrialExpiresAt },
    },
    noThrow
  );
};
```

```ts
// main.wasp.ts
import { addToAguMail } from './src/auth/agumail' with { type: 'ref' };

// in app({ ... auth: { ... } }):
onAfterSignup: addToAguMail,
```

Then record what they do from your actions. AguMail knows them by their Wasp user id, so that is all an event needs:

```ts
// src/campaigns/operations.ts
import type { CreateCampaign } from 'wasp/server/operations';
import { noThrow } from 'agumail-js';
import { agumail } from '../server/agumail';

export const createCampaign: CreateCampaign<{ name: string }, { id: string }> = async ({ name }, context) => {
  const user = context.user!;
  const campaign = await context.entities.Campaign.create({ data: { name, userId: user.id } });
  void agumail.track(
    {
      userId: user.id,
      event: 'Created campaign',
      properties: { campaignId: campaign.id },
      uniqueId: `campaign_created:${campaign.id}`,
    },
    noThrow
  );
  return campaign;
};
```

## Batching with the queue

Every `identify` and `track` is its own request, and AguMail takes about 120 a minute per key. If your app records more than about two things a second, or you want a contact and its events to go together, queue them instead:

```ts
agumail.queue.identify({ email: user.email, firstName: user.firstName });
agumail.queue.track({ email: user.email, event: 'Signed up' });
```

- Queueing returns nothing and never throws. Each record is checked when you queue it, and a bad one goes to `onError` instead of the queue.
- The queue sends itself (a flush) once 500 records are waiting, or 5 seconds after the first one was queued. `flushAt` and `flushIntervalMs` change both.
- A flush sends every queued contact first, 500 to a request, then every event, so an event never arrives before its contact. The `contact` you pass to `queue.track` goes out with the contacts.
- A flush that still fails after its retries goes to `onError`, and its records are dropped, not queued again.
- A queued contact AguMail refuses because its email belongs to someone else is a `conflicts` warning, and a `userId` nobody has is an `unknown_user_ids` warning (see [Identify by your app's user id](#identify-by-your-apps-user-id)).
- The queue lives in memory, and its timer never keeps a Node process running. Records still queued when the process stops are lost, so flush first.

`flush()` sends everything queued now, and resolves when that's done. It never rejects:

```ts
const { contacts, events, error } = await agumail.flush();
```

On serverless, a function can be frozen as soon as it responds, before the timer fires. Flush with `after()` in Next.js, or `waitUntil` on Vercel and Cloudflare:

```ts
after(() => agumail.flush());
```

On a long-running server, flush when it shuts down:

```ts
process.on('SIGTERM', async () => {
  await agumail.flush();
  process.exit(0);
});
```

## Loading your existing users

`identifyMany` and `trackMany` take any number of records and send them 500 at a time. Mark history with `backfill: true`, so nobody gets a welcome email or an event-triggered email for something that happened before AguMail knew about it:

```ts
await agumail.identifyMany(
  users.map((u) => ({
    email: u.email,
    firstName: u.firstName,
    customerSince: u.createdAt,
    subscribed: u.marketingOptIn,
  })),
  { backfill: true }
);
```

Pass `subscribed` from what each user agreed to. It defaults to true, so leaving it out would subscribe every user you import, including those who never agreed to marketing email.

`customerSince` becomes the contact's **Date added** when AguMail creates them, so flows timed from Date added don't treat old users as new.

Every record is checked before anything is sent. If one is wrong, the call throws and names it (`contacts[700].email`), and nothing is sent. If a batch fails partway through, the error's `partial` says how many records landed (`error.partial.sent`) and what AguMail counted for them, so you can send the rest with `records.slice(error.partial.sent)`.

## Newsletter forms on your website

For a newsletter form on your marketing site, use `signups.create` rather than `identify`. AguMail treats it like a signup on its own forms: it can send a double opt-in email, it keeps proof of the signup (page, IP address, the wording they agreed to), and someone who unsubscribed earlier can come back this way after confirming by email.

```ts
await agumail.signups.create({
  email: form.email,
  doubleOptIn: true,
  form: { id: 'footer', name: 'Footer newsletter' },
  pageUrl: request.headers.get('referer') ?? undefined,
  ip: visitorIp, // the visitor's IP address, not your server's
  consentText: 'Send me product news. Unsubscribe any time.',
  tags: ['Newsletter'],
});
```

- `form.id` is your own name for the form, and `form.name` is what AguMail shows. Add `form.builder` (such as `'webflow'`) if a site builder made the form.
- AguMail takes at most 10 new addresses per visitor IP address a minute. Pass the visitor's IP address, or every signup shares your server's limit. Signups over the limit are not stored, and are counted in `limited`.

Prefer forms designed in AguMail? `forms.list()` returns your published forms and the script that shows them:

```ts
const { loaderUrl, forms } = await agumail.forms.list();
```

```html
<script type="text/plain" data-agumail-form="FORM_SLUG" data-mode="inline"></script>
<script src="LOADER_URL" async></script>
```

`data-mode` is `inline` or `popup`.

## My flow didn't start

Check these in order:

1. **Is the person Subscribed?** Flows started by an event only email Subscribed people. Add them with `identify`, which subscribes them, not with `subscribed: false` and not only through `track`'s `contact`. `agumail.contacts.status(email)` tells you where they stand.
2. **Did AguMail have them before the event?** An event for someone AguMail doesn't have is skipped and counted in `unknownContacts`, and `onWarning` gets `unknown_contacts`. Identify them first and wait for it, or pass `contact`, or use the queue. An event sent by `userId` needs a contact with that id, so identify them with both their `userId` and their email.
3. **Did it happen in the last 72 hours?** An `occurredAt` older than that counts as history: stored, but no flow starts. `onWarning` gets `history`.
4. **Was the uniqueId new?** An id AguMail has seen before, for any event, counts in `duplicates` and starts nothing.
5. **Does the flow's trigger name the same event?** "Upgraded plan" and "upgraded_plan" match, but "Upgraded" doesn't.

## Limits

| | Limit |
|---|---|
| Requests | About 120 a minute per API key. The package waits and retries when AguMail says to slow down. |
| Records per request | 500, split for you |
| Tags | 20 per contact, 60 characters each |
| Properties (contact) | 30 per contact, names up to 60 characters, values up to 500 |
| Properties (event) | 30 keys, up to 8,000 characters as JSON |
| Names | first and last name up to 100 characters, phone up to 40 |
| Event name | up to 60 characters |
| `uniqueId` | up to 120 characters |
| `userId` | up to 200 characters |

Every `identify` or `track` is one request (`track` with `contact` is two), so an app sending more than about 2 a second will be slowed down. Use `identifyMany` and `trackMany` for bulk work, and [the queue](#batching-with-the-queue) for a busy app.

## Errors

Failed calls throw an `AguMailError` (or return it, with `throwOnError: false`):

```ts
import { AguMailError } from 'agumail-js';

try {
  await agumail.identify({ email });
} catch (error) {
  if (error instanceof AguMailError) {
    error.status;     // the HTTP status, or null when there was no answer
    error.code;       // see below
    error.message;    // what went wrong, in words
    error.retryAfter; // on a 429, the seconds AguMail asked you to wait
    error.partial;    // identifyMany, trackMany, flush: what landed before it failed
    error.uniqueIds;  // track, trackMany, flush: the id each event was sent with
  }
}
```

| `code` | Meaning | Retried |
|---|---|---|
| `invalid_input` | A record or option is wrong. Nothing was sent. | No |
| `missing_api_key` | No key, or not an AguMail key (`agm_` and 40 characters). Nothing was sent. | No |
| `bad_request` | 400: AguMail refused the request. | No |
| `unauthorized` | 401: the key is wrong or revoked. | No |
| `payment_required` | 402. No call in this package returns it today: it belongs to AguMail's store API. | No |
| `forbidden` | 403: for signups, the account isn't taking signups right now. | No |
| `not_found` | 404 | No |
| `rate_limited` | 429: too many requests. | Yes, after `Retry-After` |
| `server_error` | 5xx | Yes |
| `timeout` | No answer in time (10 seconds, or 60 for a batch). | Yes |
| `network_error` | AguMail couldn't be reached. | Yes |
| `aborted` | Your `signal` aborted the call. | No |
| `unexpected` | A bug, here or in a custom `fetch`. Please report it. | No |

Retried errors are tried 3 more times, with growing waits. If AguMail asks for a wait longer than a minute, the call stops and reports `retryAfter` instead.

## Testing

The package refuses to run in a browser, and that includes test setups that fake one, such as jsdom. Run tests that use it in a Node environment, or mock the package.

For tests and local development, `disabled: true` sends nothing and needs no key. Calls still check their input and options, so a bad record still fails. They resolve with empty results: zero counts, a generated `uniqueId`, and `status: null` for every address and user id. No warnings fire.

```ts
const agumail = new AguMail(process.env.AGUMAIL_API_KEY, {
  disabled: process.env.NODE_ENV === 'test',
});
```

To see what would be sent, pass your own `fetch`:

```ts
const sent: unknown[] = [];
const agumail = new AguMail(`agm_${'0'.repeat(40)}`, {
  fetch: async (url, init) => {
    if (init?.body) sent.push(JSON.parse(String(init.body)));
    const counts = { created: 1, updated: 0, suppressedSkipped: 0, overCapacity: 0, duplicates: 0, unknownContacts: 0 };
    return new Response(JSON.stringify({ ok: true, ...counts }));
  },
});
```

## Options

```ts
new AguMail(apiKey, {
  baseUrl: 'https://api.agumail.com', // the default
  timeoutMs: 20_000,                  // per attempt, for every request; leave it out for 10 seconds, or 60 for a batch
  maxRetries: 3,                      // the default
  fetch: customFetch,                 // defaults to the global fetch
  onError: (error) => {},             // errors nobody else sees (see Never break a signup)
  onWarning: (warning) => {},         // records AguMail dropped or held back
  disabled: false,                    // true sends nothing (see Testing)
  flushAt: 500,                       // the queue flushes at this many records, 1 to 500
  flushIntervalMs: 5_000,             // or this long after the first one; 0 turns the timer off
});
```

Leave `apiKey` out, or pass `undefined` or `''`, and the client reads `AGUMAIL_API_KEY` from the environment (`process.env`, or `Deno.env` on Deno) when it first needs it. A key you pass always wins.

Every call also takes `{ throwOnError, timeoutMs, signal }`, and `identifyMany` and `trackMany` take `backfill`. `flush` takes `{ timeoutMs, signal }`. A `timeoutMs` can be at most 2147483647 (about 24 days), the longest a timer can wait.

## API

```ts
agumail.identify(contact, options?)                 // Promise<ContactCounts>
agumail.identifyMany(contacts, options?)            // Promise<ContactCounts>
agumail.track(event, options?)                      // Promise<TrackResult>
agumail.trackMany(events, options?)                 // Promise<TrackManyResult>
agumail.contacts.status(email, options?)            // Promise<ContactStatus>
agumail.contacts.status(emails, options?)           // Promise<ContactStatus[]>
agumail.contacts.statusByUserId(userId, options?)   // Promise<ContactStatus>
agumail.contacts.statusByUserId(userIds, options?)  // Promise<ContactStatus[]>
agumail.contacts.subscribe(emails, options?)        // Promise<ContactCounts>
agumail.contacts.unsubscribe(emails, options?)      // Promise<ContactCounts>
agumail.forms.list(options?)                        // Promise<FormList>
agumail.signups.create(signups, options?)           // Promise<SignupCounts>
agumail.ping(options?)                              // Promise<PingResult>
agumail.queue.identify(contact)                     // void
agumail.queue.track(event)                          // void
agumail.flush(options?)                             // Promise<FlushResult>
```

With `throwOnError: false` (or `noThrow`), a call that resolves to `T` resolves to `{ data: T, error: null } | { data: null, error: AguMailError }` instead. The methods work taken off the client too: `const { identify, track } = agumail`.

```ts
ContactCounts   // { created, updated, suppressedSkipped, overCapacity, confirmationsSent?,
                //   unknownContacts?, conflicts?, conflicted?: ContactConflict[] }
ContactConflict // { index, userId, email, reason: 'email_taken' | 'user_id_mismatch' }
TrackResult     // { created, duplicates, unknownContacts, uniqueId, contact?: ContactCounts }
TrackManyResult // { created, duplicates, unknownContacts, uniqueIds, contacts?: ContactCounts }
ContactStatus   // { email, userId, status, subscribed }
FormList        // { loaderUrl, forms: { slug, name, doubleOptIn, publishedAt }[] }
SignupCounts    // { received, overCapacity, limited }
PingResult      // { shop: { userId, shopName } }: userId is your AguMail account's id
FlushResult     // { contacts: ContactCounts, events: EventCounts, error: AguMailError | null }
```

These types, and `Contact`, `TrackEvent`, `Signup` and the rest, are exported, and your editor shows what each field does.

## Coming

- Deleting a contact.
- Verifying AguMail's webhooks, for unsubscribes and bounces.
- Syncing customers from Stripe and users from auth providers.

## License

MIT
