/**
 * Webhook delivery confirmation and reconciliation tests (PGlite).
 *
 * Verifies that:
 * 1. Webhook post sets notify_request_id and leaves notified_at null while in flight.
 * 2. Non-2xx/failed/timed-out webhook responses leave notified_at null and clear notify_request_id for retry.
 * 3. 2xx webhook responses set notified_at and clear notify_request_id.
 * 4. Subsequent passes do not re-dispatch already notified alerts.
 */
import { PGlite } from 'npm:@electric-sql/pglite@0.3.4';
import { assertEquals } from '@std/assert';

const MIGRATIONS = [
  'supabase/migrations/20260808000000_indexer_core.sql',
  'supabase/migrations/20260816000000_chain_derived.sql',
  'supabase/migrations/20260914000000_indexer_alerts.sql',
  'supabase/migrations/20261009000001_ledger_lag_alert.sql',
  'supabase/migrations/20261020000000_confirm_webhook_delivery.sql',
];

async function setupTestDb(): Promise<PGlite> {
  const db = new PGlite();
  for (const m of MIGRATIONS) {
    const sql = await Deno.readTextFile(m);
    await db.exec(sql);
  }

  // Setup mock vault and net schemas
  await db.exec(`
    create schema if not exists net;
    create table if not exists net._http_response (
      id bigint primary key,
      status_code integer,
      content text,
      headers jsonb,
      error_msg text,
      timed_out boolean default false
    );

    create or replace function net.http_post(
      url text,
      body jsonb default '{}'::jsonb,
      headers jsonb default '{}'::jsonb,
      timeout_milliseconds integer default 10000
    ) returns bigint
    language plpgsql
    as $$
    begin
      return 101;
    end;
    $$;

    create schema if not exists vault;
    create table if not exists vault.decrypted_secrets (
      name text unique,
      decrypted_secret text
    );
    insert into vault.decrypted_secrets (name, decrypted_secret)
    values ('indexer_alert_webhook', 'https://example.com/webhook');
  `);

  return db;
}

Deno.test('in-flight webhook sets notify_request_id and leaves notified_at null', async () => {
  const db = await setupTestDb();
  try {
    // Stale checkpoint trigger
    await db.exec(
      `insert into public.indexer_checkpoints (id, last_processed_ledger, start_ledger, updated_at)
       values ('default', 1000000, 1, now() - interval '2 hours')`,
    );

    const r = await db.query('select * from public.check_indexer_health();');
    const result = (r.rows as { opened: number; notified: number }[])[0]!;
    assertEquals(result.opened, 1);
    assertEquals(result.notified, 0); // Not confirmed yet

    const alerts = (await db.query('select notify_request_id, notified_at from public.indexer_alerts;')).rows as {
      notify_request_id: number;
      notified_at: string | null;
    }[];
    assertEquals(alerts.length, 1);
    assertEquals(Number(alerts[0]!.notify_request_id), 101);
    assertEquals(alerts[0]!.notified_at, null);
  } finally {
    await db.close();
  }
});

Deno.test('failed webhook response (non-2xx) leaves notified_at null and clears request_id for retry', async () => {
  const db = await setupTestDb();
  try {
    await db.exec(
      `insert into public.indexer_checkpoints (id, last_processed_ledger, start_ledger, updated_at)
       values ('default', 1000000, 1, now() - interval '2 hours')`,
    );

    // Initial pass: dispatches request 101
    await db.exec('select * from public.check_indexer_health();');

    // Simulate 500 error in net._http_response
    await db.exec(
      `insert into net._http_response (id, status_code, error_msg)
       values (101, 500, 'Internal Server Error');`,
    );

    // Update net.http_post to return a new id for retry
    await db.exec(`
      create or replace function net.http_post(
        url text,
        body jsonb default '{}'::jsonb,
        headers jsonb default '{}'::jsonb,
        timeout_milliseconds integer default 10000
      ) returns bigint
      language plpgsql
      as $$
      begin
        return 102;
      end;
      $$;
    `);

    // Second pass: reconciles 500 failure, leaves notified_at null, retries with 102
    const r = await db.query('select * from public.check_indexer_health();');
    const result = (r.rows as { notified: number }[])[0]!;
    assertEquals(result.notified, 0);

    const alerts = (await db.query('select notify_request_id, notified_at from public.indexer_alerts;')).rows as {
      notify_request_id: number;
      notified_at: string | null;
    }[];
    assertEquals(alerts.length, 1);
    assertEquals(Number(alerts[0]!.notify_request_id), 102); // Retried with new request ID
    assertEquals(alerts[0]!.notified_at, null);
  } finally {
    await db.close();
  }
});

Deno.test('successful webhook response (2xx) sets notified_at and clears request_id', async () => {
  const db = await setupTestDb();
  try {
    await db.exec(
      `insert into public.indexer_checkpoints (id, last_processed_ledger, start_ledger, updated_at)
       values ('default', 1000000, 1, now() - interval '2 hours')`,
    );

    // Initial pass: dispatches request 101
    await db.exec('select * from public.check_indexer_health();');

    // Simulate 200 OK in net._http_response
    await db.exec(
      `insert into net._http_response (id, status_code)
       values (101, 200);`,
    );

    // Second pass: reconciles 200, marks notified_at
    const r = await db.query('select * from public.check_indexer_health();');
    const result = (r.rows as { notified: number }[])[0]!;
    assertEquals(result.notified, 1);

    const alerts = (await db.query('select notify_request_id, notified_at from public.indexer_alerts;')).rows as {
      notify_request_id: number | null;
      notified_at: string | null;
    }[];
    assertEquals(alerts.length, 1);
    assertEquals(alerts[0]!.notify_request_id, null);
    assertEquals(alerts[0]!.notified_at !== null, true);

    // Third pass: already notified, does not notify again
    const r3 = await db.query('select * from public.check_indexer_health();');
    const result3 = (r3.rows as { notified: number }[])[0]!;
    assertEquals(result3.notified, 0);
  } finally {
    await db.close();
  }
});
