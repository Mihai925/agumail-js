import { afterEach, describe, expect, it, vi } from 'vitest';
import { AguMail, AguMailError, type AguMailOptions } from '../src/index';
import { client, contactsOk, fail, KEY, mockFetch, rejection } from './helpers';

const contact = { email: 'sam@example.com' };

describe('throwOnError: false', () => {
  it('returns { data, error: null } on success', async () => {
    const { fetch } = mockFetch(contactsOk());
    const result = await client(fetch).identify(contact, { throwOnError: false });
    expect(result).toEqual({ data: { created: 1, updated: 0, suppressedSkipped: 0, overCapacity: 0 }, error: null });
  });

  it('returns { data: null, error } instead of throwing', async () => {
    const { fetch } = mockFetch(fail(401, 'Invalid or revoked API key.'));
    const result = await client(fetch).identify(contact, { throwOnError: false });
    expect(result.data).toBeNull();
    expect(result.error).toBeInstanceOf(AguMailError);
    expect(result.error).toMatchObject({ status: 401, code: 'unauthorized' });
  });

  it('never rejects, even for bad input, a missing key or bad settings', async () => {
    const { fetch, calls } = mockFetch(contactsOk());
    const results = await Promise.all([
      client(fetch).identify({ email: 'nope' }, { throwOnError: false }),
      new AguMail(undefined, { fetch }).track({ email: 'sam@example.com', event: 'x' }, { throwOnError: false }),
      new AguMail(KEY, { fetch, maxRetries: -1 }).ping({ throwOnError: false }),
      client(fetch).identifyMany('nope' as any, { throwOnError: false }),
    ]);
    expect(results.map((r) => r.error?.code)).toEqual(['invalid_input', 'missing_api_key', 'invalid_input', 'invalid_input']);
    expect(calls()).toBe(0);
  });

  it('hands every error to onError, and only for calls that do not throw', async () => {
    const onError = vi.fn();
    const { fetch } = mockFetch(fail(400, 'bad'));
    const agumail = client(fetch, { onError });
    await agumail.identify(contact, { throwOnError: false });
    await rejection(agumail.identify(contact));
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]![0]).toMatchObject({ status: 400, message: 'bad' });
  });

  it('still returns the error when onError itself throws', async () => {
    const { fetch } = mockFetch(fail(400));
    const agumail = client(fetch, {
      onError: () => {
        throw new Error('logger down');
      },
    });
    const result = await agumail.identify(contact, { throwOnError: false });
    expect(result.error?.status).toBe(400);
  });

  it('swallows a rejection from an async onError', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      const { fetch } = mockFetch(fail(400));
      const agumail = client(fetch, {
        onError: async () => {
          throw new Error('logger down');
        },
      });
      const result = await agumail.identify(contact, { throwOnError: false });
      expect(result.error?.status).toBe(400);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  it('wraps a custom fetch that throws something odd', async () => {
    const result = await client((() => {
      throw 'boom';
    }) as any).ping({ throwOnError: false, timeoutMs: 1000 });
    expect(result.error).toBeInstanceOf(AguMailError);
  });
});

describe('the API key', () => {
  it('is checked on the first call, never in the constructor', async () => {
    const { fetch, calls } = mockFetch(contactsOk());
    const agumail = new AguMail(process.env.AGUMAIL_KEY_THAT_IS_NOT_SET, { fetch });
    const error = await rejection(agumail.identify(contact));
    expect(error).toMatchObject({ code: 'missing_api_key', status: null });
    expect(error.message).toContain('AGUMAIL_API_KEY');
    expect(calls()).toBe(0);
  });

  it('refuses something that is not an agm_ key without sending it or echoing it', async () => {
    const { fetch, calls } = mockFetch(contactsOk());
    const error = await rejection(new AguMail('sk_live_secret123', { fetch }).identify(contact));
    expect(error.code).toBe('missing_api_key');
    expect(error.message).not.toContain('sk_live_secret123');
    expect(calls()).toBe(0);
  });

  it('trims whitespace around the key', async () => {
    const { fetch, sent } = mockFetch(contactsOk());
    await new AguMail(`  ${KEY}\n`, { fetch }).identify(contact);
    expect(sent[0]!.headers.Authorization).toBe(`Bearer ${KEY}`);
  });
});

describe('the API key from the environment', () => {
  const OTHER = `agm_${'f'.repeat(40)}`;

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('is read from AGUMAIL_API_KEY when no key, undefined or an empty key is passed', async () => {
    vi.stubEnv('AGUMAIL_API_KEY', KEY);
    const { fetch, sent } = mockFetch(contactsOk());
    vi.stubGlobal('fetch', fetch);
    await new AguMail().identify(contact);
    await new AguMail(undefined, { fetch }).identify(contact);
    await new AguMail('', { fetch }).identify(contact);
    await new AguMail('  ', { fetch }).identify(contact);
    expect(sent.map((r) => r.headers.Authorization)).toEqual(Array(4).fill(`Bearer ${KEY}`));
  });

  it('is read when first needed, so a key set after the client was made still counts', async () => {
    const { fetch, sent } = mockFetch(contactsOk());
    const agumail = new AguMail(undefined, { fetch });
    vi.stubEnv('AGUMAIL_API_KEY', KEY);
    await agumail.identify(contact);
    expect(sent[0]!.headers.Authorization).toBe(`Bearer ${KEY}`);
  });

  it('never wins over a key passed in, even one that is wrong', async () => {
    vi.stubEnv('AGUMAIL_API_KEY', OTHER);
    const { fetch, sent } = mockFetch(contactsOk());
    await new AguMail(KEY, { fetch }).identify(contact);
    expect(sent[0]!.headers.Authorization).toBe(`Bearer ${KEY}`);
    const error = await rejection(new AguMail('sk_live_secret123', { fetch }).identify(contact));
    expect(error.code).toBe('missing_api_key');
    expect(sent).toHaveLength(1);
  });

  it('is named when it holds something else, without echoing it', async () => {
    vi.stubEnv('AGUMAIL_API_KEY', 'sk_live_secret123');
    const { fetch, calls } = mockFetch(contactsOk());
    const error = await rejection(new AguMail(undefined, { fetch }).identify(contact));
    expect(error.code).toBe('missing_api_key');
    expect(error.message).toContain('AGUMAIL_API_KEY does not hold an AguMail API key');
    expect(error.message).not.toContain('sk_live_secret123');
    expect(calls()).toBe(0);
  });

  it('is read from Deno.env on Deno', async () => {
    vi.stubGlobal('Deno', { env: { get: (name: string) => (name === 'AGUMAIL_API_KEY' ? KEY : undefined) } });
    const { fetch, sent } = mockFetch(contactsOk());
    await new AguMail(undefined, { fetch }).identify(contact);
    expect(sent[0]!.headers.Authorization).toBe(`Bearer ${KEY}`);
  });

  it('is reported missing, not thrown, when Deno refuses to read the environment', async () => {
    vi.stubGlobal('Deno', {
      env: {
        get: () => {
          throw new Error('Requires env access to "AGUMAIL_API_KEY", run again with the --allow-env flag');
        },
      },
    });
    const { fetch, calls } = mockFetch(contactsOk());
    const agumail = new AguMail(undefined, { fetch });
    const result = await agumail.identify(contact, { throwOnError: false });
    expect(result.error?.code).toBe('missing_api_key');
    expect(calls()).toBe(0);
  });
});

describe('settings', () => {
  it.each([
    [{ maxRetries: -1 }, 'maxRetries'],
    [{ maxRetries: 1.5 }, 'maxRetries'],
    [{ timeoutMs: 0 }, 'timeoutMs'],
    [{ timeoutMs: 2_147_483_648 }, 'at most 2147483647'],
    [{ baseUrl: 'api.agumail.com' }, 'baseUrl'],
    [{ onWarning: 'log' }, 'onWarning'],
    [{ disabled: 'yes' }, 'disabled'],
    [{ flushAt: 0 }, 'flushAt'],
    [{ flushAt: 501 }, 'flushAt'],
    [{ flushAt: 2.5 }, 'flushAt'],
    [{ flushIntervalMs: -1 }, 'flushIntervalMs'],
    [{ flushIntervalMs: 2_147_483_648 }, 'flushIntervalMs'],
  ])('reports %o on the first call', async (options, message) => {
    const { fetch, calls } = mockFetch(contactsOk());
    const agumail = new AguMail(KEY, { fetch, ...(options as AguMailOptions) });
    const error = await rejection(agumail.identify(contact));
    expect(error.code).toBe('invalid_input');
    expect(error.message).toContain(message);
    expect(calls()).toBe(0);
  });

  it.each([
    [{ throwOnError: 'no' }, 'throwOnError'],
    [{ timeoutMs: -5 }, 'timeoutMs'],
    [{ timeoutMs: 2_147_483_648 }, 'at most 2147483647'],
    [{ timeoutMs: Number.POSITIVE_INFINITY }, 'timeoutMs'],
    [{ backfill: 'yes' }, 'backfill'],
  ])('refuses call options %o', async (options, message) => {
    const { fetch, calls } = mockFetch(contactsOk());
    const error = await rejection(client(fetch).identifyMany([contact], options as any));
    expect(error.code).toBe('invalid_input');
    expect(error.message).toContain(message);
    expect(calls()).toBe(0);
  });

  it('takes a timeoutMs of 2147483647, the longest a timer can wait', async () => {
    const { fetch, calls } = mockFetch(contactsOk());
    await new AguMail(KEY, { fetch, timeoutMs: 2_147_483_647 }).identify(contact, { timeoutMs: 2_147_483_647 });
    expect(calls()).toBe(1);
  });
});

describe('browsers', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('refuses to run in a browser', () => {
    vi.stubGlobal('window', {});
    vi.stubGlobal('document', {});
    expect(() => new AguMail(KEY)).toThrow(/server only.*secret/s);
  });

  it('runs where there is a window but no document, as in Deno 1.x', () => {
    vi.stubGlobal('window', {});
    expect(() => new AguMail(KEY)).not.toThrow();
  });
});
