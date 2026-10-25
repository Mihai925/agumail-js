import type { ContactCounts, EventCounts, SignupCounts } from './types';

export type AguMailErrorCode =
  | 'invalid_input'
  | 'missing_api_key'
  | 'bad_request'
  | 'unauthorized'
  | 'payment_required'
  | 'forbidden'
  | 'not_found'
  | 'rate_limited'
  | 'server_error'
  | 'timeout'
  | 'network_error'
  | 'aborted'
  | 'unexpected';

export interface AguMailErrorPartial {
  /** Records AguMail accepted before the failure, counted from the start of your array. */
  sent: number;
  result: ContactCounts | EventCounts | SignupCounts;
}

export class AguMailError extends Error {
  override readonly name = 'AguMailError';
  /** The HTTP status, or null when there was no answer (bad input, network, timeout). */
  readonly status: number | null;
  readonly code: AguMailErrorCode;
  /** Seconds AguMail asked you to wait, on a 429. */
  readonly retryAfter: number | null;
  /** Set by the batch methods and flush when some batches landed before the failure. */
  partial?: AguMailErrorPartial;
  /**
   * Set by track, trackMany and flush: the uniqueId each event was sent with,
   * in order. Send the events again with these ids and none is recorded twice.
   */
  uniqueIds?: string[];

  constructor(
    message: string,
    init: { code: AguMailErrorCode; status?: number | null; retryAfter?: number | null; cause?: unknown }
  ) {
    super(message, init.cause === undefined ? undefined : { cause: init.cause });
    this.code = init.code;
    this.status = init.status ?? null;
    this.retryAfter = init.retryAfter ?? null;
  }
}

export function invalidInput(message: string): AguMailError {
  return new AguMailError(message, { code: 'invalid_input' });
}

export function toAguMailError(cause: unknown): AguMailError {
  if (cause instanceof AguMailError) return cause;
  return new AguMailError(`Unexpected error in agumail-js: ${cause instanceof Error ? cause.message : String(cause)}`, {
    code: 'unexpected',
    cause,
  });
}
