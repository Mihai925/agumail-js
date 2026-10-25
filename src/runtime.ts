declare const __VERSION__: string;

export const VERSION: string = __VERSION__;

export const BROWSER_MESSAGE =
  'agumail-js runs on your server only. Your AguMail API key is secret, and code in a browser hands it to every ' +
  'visitor. Call AguMail from an API route, a server action or your backend instead.';

export const API_KEY_ENV = 'AGUMAIL_API_KEY';

/** The longest delay setTimeout honours. Node runs a longer one after 1 ms. */
export const MAX_DELAY_MS = 2_147_483_647;

/** A page in a browser. Deno 1.x has a `window` but no `document`, so it is not one. */
export function isBrowser(): boolean {
  const g = globalThis as { window?: unknown; document?: unknown };
  return typeof g.window !== 'undefined' && typeof g.document !== 'undefined';
}

/** AGUMAIL_API_KEY from the environment, or '' when there is none or it can't be read. */
export function envApiKey(): string {
  const g = globalThis as {
    process?: { env?: Record<string, string | undefined> };
    Deno?: { env?: { get?: (name: string) => string | undefined } };
  };
  // Both throw on Deno without --allow-env (Deno 2 has a process too).
  try {
    const value = g.process?.env?.[API_KEY_ENV];
    if (typeof value === 'string' && value.trim()) return value.trim();
  } catch {
    // Not readable here.
  }
  try {
    const value = g.Deno?.env?.get?.(API_KEY_ENV);
    if (typeof value === 'string') return value.trim();
  } catch {
    // Not readable here.
  }
  return '';
}

/** Lets the process exit while the timer is pending, where the runtime supports it. */
export function unref(timer: unknown): void {
  const t = timer as { unref?: () => void } | null;
  if (t && typeof t === 'object' && typeof t.unref === 'function') {
    t.unref();
    return;
  }
  // Deno's setTimeout returns a number, and Deno.unrefTimer takes it.
  const deno = (globalThis as { Deno?: { unrefTimer?: (id: number) => void } }).Deno;
  if (typeof timer === 'number' && typeof deno?.unrefTimer === 'function') deno.unrefTimer(timer);
}

export function randomId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  // Node 18 has no global crypto. The id only has to be unique (AguMail dedupes
  // on it), never secret, so Math.random is enough here.
  const bytes = Array.from({ length: 16 }, () => Math.floor(Math.random() * 256));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const encoder = new TextEncoder();

export function utf8Length(text: string): number {
  return encoder.encode(text).length;
}
