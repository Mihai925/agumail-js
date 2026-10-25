import { vi } from 'vitest';
import { AguMail, type AguMailOptions } from '../src/index';

export const KEY = `agm_${'0123456789abcdef'.repeat(2)}01234567`;

export interface SentRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: any;
}

export type Reply =
  | { status?: number; body?: unknown; text?: string; headers?: Record<string, string> }
  | Error
  | 'hang'
  | ((request: SentRequest) => Reply);

/** A fetch that answers with `replies` in order, repeating the last one. */
export function mockFetch(...replies: Reply[]) {
  const sent: SentRequest[] = [];
  const queue = replies.length > 0 ? [...replies] : [{ body: { ok: true } }];
  const fetch = vi.fn(async (url: string, init: RequestInit = {}): Promise<Response> => {
    const request: SentRequest = {
      url,
      method: init.method ?? 'GET',
      headers: { ...(init.headers as Record<string, string>) },
      body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
    };
    sent.push(request);
    let reply = (queue.length > 1 ? queue.shift() : queue[0]) as Reply;
    while (typeof reply === 'function') reply = reply(request);
    if (reply === 'hang') return new Promise<Response>(() => {});
    if (reply instanceof Error) throw reply;
    const text = reply.text ?? JSON.stringify(reply.body ?? { ok: true });
    return new Response(text, {
      status: reply.status ?? 200,
      headers: { 'content-type': 'application/json', ...reply.headers },
    });
  });
  return { fetch: fetch as unknown as typeof globalThis.fetch, sent, calls: () => sent.length };
}

export function ok(body: Record<string, unknown> = {}): Reply {
  return { status: 200, body: { ok: true, ...body } };
}

export function fail(status: number, error = `failed with ${status}`, headers: Record<string, string> = {}): Reply {
  return { status, body: { ok: false, error }, headers };
}

export function client(fetch: typeof globalThis.fetch, options: AguMailOptions = {}): AguMail {
  return new AguMail(KEY, { fetch, ...options });
}

export const contactsOk = (n = 1) => ok({ created: n, updated: 0, suppressedSkipped: 0, overCapacity: 0 });
export const eventsOk = (n = 1) => ok({ created: n, duplicates: 0, unknownContacts: 0 });

/** Runs a call to completion under fake timers, firing every backoff and timeout on the way. */
export async function settle<T>(promise: Promise<T>): Promise<T> {
  let done = false;
  const tracked = promise.finally(() => {
    done = true;
  });
  tracked.catch(() => {});
  for (let i = 0; i < 200 && !done; i++) await vi.advanceTimersByTimeAsync(1000);
  return tracked;
}

export async function rejection(promise: Promise<unknown>): Promise<any> {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error('expected the call to fail');
}
