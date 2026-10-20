import { assertEquals, assertRejects } from '@std/assert';
import {
  backoffDelay,
  DEFAULT_RETRY_POLICY,
  isRetryableError,
  withRetry,
} from '../supabase/functions/_shared/retry.ts';
import { RpcError } from '../supabase/functions/_shared/stellar.ts';

/** Records delays instead of actually sleeping, so tests run instantly. */
function recordingSleep(): { delays: number[]; sleep: (ms: number) => Promise<void> } {
  const delays: number[] = [];
  return {
    delays,
    sleep: (ms: number) => {
      delays.push(ms);
      return Promise.resolve();
    },
  };
}

Deno.test('backoffDelay grows exponentially', () => {
  assertEquals(backoffDelay(1, 100, 10_000), 100);
  assertEquals(backoffDelay(2, 100, 10_000), 200);
  assertEquals(backoffDelay(3, 100, 10_000), 400);
  assertEquals(backoffDelay(4, 100, 10_000), 800);
});

Deno.test('backoffDelay is capped at maxDelayMs', () => {
  assertEquals(backoffDelay(10, 100, 5_000), 5_000);
});

Deno.test('withRetry returns immediately on success', async () => {
  const { delays, sleep } = recordingSleep();
  let calls = 0;

  const result = await withRetry(
    () => {
      calls++;
      return Promise.resolve('ok');
    },
    { attempts: 3, baseDelayMs: 10, maxDelayMs: 100, sleep },
  );

  assertEquals(result, 'ok');
  assertEquals(calls, 1);
  assertEquals(delays.length, 0);
});

Deno.test('withRetry retries a transient failure then succeeds', async () => {
  const { delays, sleep } = recordingSleep();
  let calls = 0;

  const result = await withRetry(
    () => {
      calls++;
      if (calls < 3) return Promise.reject(new Error('transient'));
      return Promise.resolve('recovered');
    },
    { attempts: 5, baseDelayMs: 10, maxDelayMs: 100, sleep },
  );

  assertEquals(result, 'recovered');
  assertEquals(calls, 3);
  assertEquals(delays, [10, 20]);
});

Deno.test('withRetry rethrows after exhausting attempts', async () => {
  const { sleep } = recordingSleep();
  let calls = 0;

  await assertRejects(
    () =>
      withRetry(
        () => {
          calls++;
          return Promise.reject(new Error('persistent'));
        },
        { attempts: 3, baseDelayMs: 10, maxDelayMs: 100, sleep },
      ),
    Error,
    'persistent',
  );

  assertEquals(calls, 3);
});

Deno.test('withRetry stops immediately for non-retryable errors', async () => {
  const { delays, sleep } = recordingSleep();
  let calls = 0;

  await assertRejects(
    () =>
      withRetry(
        () => {
          calls++;
          return Promise.reject(new Error('fatal'));
        },
        {
          attempts: 5,
          baseDelayMs: 10,
          maxDelayMs: 100,
          sleep,
          isRetryable: () => false,
        },
      ),
    Error,
    'fatal',
  );

  assertEquals(calls, 1);
  assertEquals(delays.length, 0);
});

Deno.test('withRetry rejects an invalid attempt budget', async () => {
  await assertRejects(
    () => withRetry(() => Promise.resolve('ok'), { attempts: 0, baseDelayMs: 1, maxDelayMs: 1 }),
    Error,
    'attempts >= 1',
  );
});

Deno.test('isRetryableError classifies 4xx and JSON-RPC validation errors as non-retryable', () => {
  assertEquals(isRetryableError(new RpcError('Bad request', 400)), false);
  assertEquals(isRetryableError(new RpcError('Unauthorized', 401)), false);
  assertEquals(isRetryableError(new RpcError('Forbidden', 403)), false);
  assertEquals(isRetryableError(new RpcError('Not found', 404)), false);
  assertEquals(isRetryableError(new RpcError('Unprocessable', 422)), false);
  assertEquals(
    isRetryableError(new RpcError('RPC error -32600: startLedger must be within the ledger range', undefined, -32600)),
    false,
  );
  assertEquals(
    isRetryableError(new RpcError('RPC error -32601: Method not found', undefined, -32601)),
    false,
  );
  assertEquals(
    isRetryableError(new RpcError('RPC error -32602: Invalid params', undefined, -32602)),
    false,
  );
  assertEquals(
    isRetryableError(new Error('RPC error -32600: startLedger must be within the ledger range')),
    false,
  );
});

Deno.test('isRetryableError classifies 5xx, 408/429, and network errors as retryable', () => {
  assertEquals(isRetryableError(new RpcError('Request timeout', 408)), true);
  assertEquals(isRetryableError(new RpcError('Too many requests', 429)), true);
  assertEquals(isRetryableError(new RpcError('Internal server error', 500)), true);
  assertEquals(isRetryableError(new RpcError('Bad gateway', 502)), true);
  assertEquals(isRetryableError(new RpcError('Service unavailable', 503)), true);
  assertEquals(isRetryableError(new RpcError('Gateway timeout', 504)), true);
  assertEquals(isRetryableError(new RpcError('RPC request failed: TypeError: fetch failed')), true);
  assertEquals(isRetryableError(new RpcError('RPC returned no result')), true);
  assertEquals(isRetryableError(new TypeError('fetch failed')), true);
});

Deno.test('isRetryableError classifies Postgres constraint violations as non-retryable', () => {
  assertEquals(
    isRetryableError(new Error('null value in column "factory_contract_id" violates not-null constraint')),
    false,
  );
  assertEquals(
    isRetryableError(new Error('duplicate key value violates unique constraint "contributions_pkey"')),
    false,
  );
  assertEquals(
    isRetryableError(new Error('insert or update on table violates foreign key constraint')),
    false,
  );
  assertEquals(
    isRetryableError(new Error('new row for relation violates check constraint "groups_member_capacity_check"')),
    false,
  );
  assertEquals(isRetryableError({ message: 'unique violation', code: '23505' }), false);
  assertEquals(isRetryableError({ message: 'foreign key violation', code: '23503' }), false);
});

Deno.test('isRetryableError classifies transient DB transport errors as retryable', () => {
  assertEquals(isRetryableError(new Error('Failed to read groups: fetch failed')), true);
  assertEquals(isRetryableError(new Error('connection timeout: statement exceeded deadline')), true);
  assertEquals(isRetryableError({ message: 'connection reset by peer', code: 'ECONNRESET' }), true);
});

Deno.test('withRetry attempts a 4xx/validation RpcError exactly once', async () => {
  const { delays, sleep } = recordingSleep();
  let calls = 0;

  await assertRejects(
    () =>
      withRetry(
        () => {
          calls++;
          return Promise.reject(new RpcError('RPC request failed with status 400', 400));
        },
        { ...DEFAULT_RETRY_POLICY, sleep },
      ),
    RpcError,
    'status 400',
  );

  assertEquals(calls, 1);
  assertEquals(delays.length, 0);

  // -32600 validation error
  calls = 0;
  await assertRejects(
    () =>
      withRetry(
        () => {
          calls++;
          return Promise.reject(
            new RpcError('RPC error -32600: startLedger must be within the ledger range', undefined, -32600),
          );
        },
        { ...DEFAULT_RETRY_POLICY, sleep },
      ),
    RpcError,
    '-32600',
  );

  assertEquals(calls, 1);
  assertEquals(delays.length, 0);
});

Deno.test('withRetry attempts a Postgres constraint violation exactly once', async () => {
  const { delays, sleep } = recordingSleep();
  let calls = 0;

  await assertRejects(
    () =>
      withRetry(
        () => {
          calls++;
          return Promise.reject(
            new Error('Failed to upsert indexed events: null value in column "factory_contract_id" violates not-null constraint'),
          );
        },
        { ...DEFAULT_RETRY_POLICY, sleep },
      ),
    Error,
    'violates not-null constraint',
  );

  assertEquals(calls, 1);
  assertEquals(delays.length, 0);
});

Deno.test('withRetry retries 5xx and network errors up to the attempt budget', async () => {
  const { delays, sleep } = recordingSleep();
  let calls = 0;

  await assertRejects(
    () =>
      withRetry(
        () => {
          calls++;
          return Promise.reject(new RpcError('RPC request failed with status 503', 503));
        },
        { ...DEFAULT_RETRY_POLICY, sleep },
      ),
    RpcError,
    'status 503',
  );

  assertEquals(calls, 4);
  assertEquals(delays.length, 3);
});

