/**
 * In-flight pg_cron runs exclusion test (PGlite).
 *
 * Verifies that:
 * 1. An in-flight job (status = 'running') does NOT trip a failed_schedule alert.
 * 2. A job with status = 'succeeded' does NOT trip a failed_schedule alert.
 * 3. A job with status = 'failed' DOES open a failed_schedule alert with its error message.
 */
import { PGlite } from 'npm:@electric-sql/pglite@0.3.4';
import { assertEquals } from '@std/assert';

const MIGRATIONS = [
  'supabase/migrations/20260808000000_indexer_core.sql',
  'supabase/migrations/20260816000000_chain_derived.sql',
  'supabase/migrations/20260914000000_indexer_alerts.sql',
  'supabase/migrations/20261009000001_ledger_lag_alert.sql',
  'supabase/migrations/20261020000000_inflight_cron_runs_not_failed.sql',
];

async function setupTestDb(): Promise<PGlite> {
  const db = new PGlite();
  for (const m of MIGRATIONS) {
    const sql = await Deno.readTextFile(m);
    await db.exec(sql);
  }

  // Setup mock cron schema and tables
  await db.exec(`
    create schema if not exists cron;
    create table if not exists cron.job (
      jobid bigint primary key,
      jobname text not null
    );

    create table if not exists cron.job_run_details (
      runid bigserial primary key,
      jobid bigint not null references cron.job(jobid),
      status text not null,
      return_message text,
      start_time timestamptz not null default now(),
      end_time timestamptz
    );

    insert into cron.job (jobid, jobname) values (1, 'indexer-task');
  `);

  return db;
}

Deno.test('an in-flight job (status = running) does not produce a failed_schedule alert', async () => {
  const db = await setupTestDb();
  try {
    // Normal non-stale checkpoint so stale_checkpoint doesn't fire
    await db.exec(
      `insert into public.indexer_checkpoints (id, last_processed_ledger, start_ledger, updated_at)
       values ('default', 1000000, 1, now())`,
    );

    // In-flight job running right now
    await db.exec(
      `insert into cron.job_run_details (jobid, status, return_message, start_time, end_time)
       values (1, 'running', null, now() - interval '5 minutes', null);`,
    );

    const r = await db.query("select * from public.check_indexer_health('30 minutes', '1 hour', false);");
    const result = (r.rows as { opened: number; open_now: number }[])[0]!;
    assertEquals(result.opened, 0);
    assertEquals(result.open_now, 0);

    const alerts = (await db.query("select * from public.indexer_alerts where kind = 'failed_schedule';")).rows;
    assertEquals(alerts.length, 0);
  } finally {
    await db.close();
  }
});

Deno.test('a succeeded job (status = succeeded) does not produce a failed_schedule alert', async () => {
  const db = await setupTestDb();
  try {
    await db.exec(
      `insert into public.indexer_checkpoints (id, last_processed_ledger, start_ledger, updated_at)
       values ('default', 1000000, 1, now())`,
    );

    await db.exec(
      `insert into cron.job_run_details (jobid, status, return_message, start_time, end_time)
       values (1, 'succeeded', 'completed successfully', now() - interval '10 minutes', now() - interval '9 minutes');`,
    );

    const r = await db.query("select * from public.check_indexer_health('30 minutes', '1 hour', false);");
    const result = (r.rows as { opened: number; open_now: number }[])[0]!;
    assertEquals(result.opened, 0);
    assertEquals(result.open_now, 0);
  } finally {
    await db.close();
  }
});

Deno.test('a terminal failure (status = failed) opens a failed_schedule alert with message', async () => {
  const db = await setupTestDb();
  try {
    await db.exec(
      `insert into public.indexer_checkpoints (id, last_processed_ledger, start_ledger, updated_at)
       values ('default', 1000000, 1, now())`,
    );

    await db.exec(
      `insert into cron.job_run_details (jobid, status, return_message, start_time, end_time)
       values (1, 'failed', 'connection timeout to node', now() - interval '15 minutes', now() - interval '14 minutes');`,
    );

    const r = await db.query("select * from public.check_indexer_health('30 minutes', '1 hour', false);");
    const result = (r.rows as { opened: number; open_now: number }[])[0]!;
    assertEquals(result.opened, 1);
    assertEquals(result.open_now, 1);

    const alerts = (await db.query("select kind, subject, detail from public.indexer_alerts where kind = 'failed_schedule';")).rows as {
      kind: string;
      subject: string;
      detail: { failures: number; newestMessage: string };
    }[];
    assertEquals(alerts.length, 1);
    assertEquals(alerts[0]!.kind, 'failed_schedule');
    assertEquals(alerts[0]!.subject, 'indexer-task');
    assertEquals(alerts[0]!.detail.failures, 1);
    assertEquals(alerts[0]!.detail.newestMessage, 'connection timeout to node');
  } finally {
    await db.close();
  }
});
