/**
 * Retry with exponential backoff.
 *
 * The indexer depends on an external RPC and a database, both of which can fail
 * transiently. Retries are bounded so a scheduled run cannot hang until the
 * platform kills it, and the checkpoint is unaffected by a failed attempt —
 * a partially processed range is simply retried on the next run.
 */

export type RetryOptions = {
  attempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  /** Returns true when the error is worth retrying. Defaults to always retry. */
  isRetryable?: (error: unknown) => boolean;
  /** Injected for tests; defaults to a real sleep. */
  sleep?: (ms: number) => Promise<void>;
};

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Determines whether an RPC or Database error is transient and worth retrying.
 *
 * Retries:
 * - Network errors (fetch failures, connection resets/refused, timeouts).
 * - HTTP 408 (Request Timeout) and 429 (Too Many Requests).
 * - HTTP 5xx server errors.
 * - Transient database transport / connection errors.
 *
 * Does NOT retry:
 * - HTTP 4xx client errors (400, 401, 403, 404, 422).
 * - Deterministic JSON-RPC validation errors (e.g. -32600 invalid ledger range).
 * - Postgres constraint violations (Class 23: not-null, unique, foreign key, check).
 * - Deterministic schema/syntax errors.
 */
export function isRetryableError(error: unknown): boolean {
  if (error === null || error === undefined) return false;

  const err = error as {
    status?: number;
    code?: number | string;
    name?: string;
    message?: string;
  };

  const message = typeof err.message === 'string' ? err.message : String(error);
  const lowerMsg = message.toLowerCase();

  // Postgres constraint violations (Class 23: 23502, 23503, 23505, 23514)
  if (typeof err.code === 'string') {
    if (err.code.startsWith('23') || err.code.startsWith('22') || err.code.startsWith('42')) {
      return false;
    }
  }

  if (
    lowerMsg.includes('violates not-null') ||
    lowerMsg.includes('violates foreign key') ||
    lowerMsg.includes('violates unique') ||
    lowerMsg.includes('violates check') ||
    lowerMsg.includes('constraint violation') ||
    lowerMsg.includes('duplicate key value') ||
    lowerMsg.includes('null value in column')
  ) {
    return false;
  }

  // JSON-RPC deterministic error codes: -32600 (invalid request / out of bounds), -32601, -32602, -32700
  if (typeof err.code === 'number' && [-32600, -32601, -32602, -32700].includes(err.code)) {
    return false;
  }
  if (
    lowerMsg.includes('-32600') ||
    lowerMsg.includes('-32601') ||
    lowerMsg.includes('-32602') ||
    lowerMsg.includes('-32700') ||
    lowerMsg.includes('startledger must be within')
  ) {
    return false;
  }

  // HTTP status codes
  if (typeof err.status === 'number') {
    if (err.status === 408 || err.status === 429) return true;
    if (err.status >= 500 && err.status <= 599) return true;
    if (err.status >= 400 && err.status < 500) return false;
  }

  const statusMatch = message.match(/failed with status (\d{3})/i);
  if (statusMatch) {
    const status = Number.parseInt(statusMatch[1] ?? '0', 10);
    if (status === 408 || status === 429) return true;
    if (status >= 500 && status <= 599) return true;
    if (status >= 400 && status < 500) return false;
  }

  // Transient network, timeout, or server transport errors
  if (
    err.name === 'AbortError' ||
    err.name === 'TimeoutError' ||
    lowerMsg.includes('network') ||
    lowerMsg.includes('fetch failed') ||
    lowerMsg.includes('timeout') ||
    lowerMsg.includes('econnreset') ||
    lowerMsg.includes('econnrefused') ||
    lowerMsg.includes('etimedout') ||
    lowerMsg.includes('connection refused') ||
    lowerMsg.includes('connection reset') ||
    lowerMsg.includes('rpc request failed') ||
    lowerMsg.includes('rpc returned no result')
  ) {
    return true;
  }

  return true;
}

/** Standard bounded retry policy for RPC and DB operations. */
export const DEFAULT_RETRY_POLICY = {
  attempts: 4,
  baseDelayMs: 250,
  maxDelayMs: 4_000,
  isRetryable: isRetryableError,
} as const;

/** Computes the backoff delay for a given attempt (1-based), capped at maxDelayMs. */
export function backoffDelay(attempt: number, baseDelayMs: number, maxDelayMs: number): number {
  const exponential = baseDelayMs * 2 ** Math.max(0, attempt - 1);
  return Math.min(exponential, maxDelayMs);
}

/**
 * Runs `operation`, retrying with exponential backoff until it succeeds or the
 * attempt budget is exhausted. The last error is rethrown.
 */
export async function withRetry<T>(
  operation: (attempt: number) => Promise<T>,
  options: RetryOptions,
): Promise<T> {
  const { attempts, baseDelayMs, maxDelayMs, isRetryable, sleep = defaultSleep } = options;

  if (!Number.isInteger(attempts) || attempts < 1) {
    throw new Error('withRetry requires attempts >= 1');
  }

  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await operation(attempt);
    } catch (error) {
      lastError = error;

      const retryable = isRetryable === undefined ? true : isRetryable(error);
      if (!retryable || attempt === attempts) {
        throw error;
      }

      await sleep(backoffDelay(attempt, baseDelayMs, maxDelayMs));
    }
  }

  // Unreachable: the loop either returns or throws.
  throw lastError;
}
