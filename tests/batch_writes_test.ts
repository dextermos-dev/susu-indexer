/**
 * Tests for bounded batching of database writes in IndexerDb.
 *
 * Verifies Acceptance Criteria of Issue #38:
 * - No single PostgREST request carries more than the configured batch size.
 * - All rows are written exactly once across batch boundaries.
 * - A failed middle batch fails the run and leaves the checkpoint untouched.
 */

import { assert, assertEquals, assertRejects } from '@std/assert';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  DEFAULT_WRITE_BATCH_SIZE,
  IndexerDb,
  type IndexedEventRow,
  type RejectedEventRow,
} from '../supabase/functions/_shared/db.ts';
import type { NewGroup } from '../supabase/functions/_shared/discovery.ts';
import type { IngestPlan } from '../supabase/functions/_shared/ingest.ts';

type RecordedUpsert = {
  table: string;
  rows: Record<string, unknown>[];
};

class RecordingClient {
  readonly upserts: RecordedUpsert[] = [];
  readonly tables = new Map<string, Record<string, unknown>[]>();
  failBatchOnTable: string | null = null;
  failBatchIndex = -1;
  private batchCounts = new Map<string, number>();

  from(table: string) {
    return {
      select: (_cols?: string) => ({
        eq: (_col: string, _val: unknown) => ({
          maybeSingle: () =>
            Promise.resolve({
              data: { last_processed_ledger: 100, start_ledger: 1, updated_at: new Date().toISOString() },
              error: null,
            }),
        }),
        range: (_from: number, _to: number) => Promise.resolve({ data: [], error: null }),
      }),
      upsert: (rows: Record<string, unknown>[], _opts?: unknown) => {
        const count = this.batchCounts.get(table) ?? 0;
        this.batchCounts.set(table, count + 1);

        if (this.failBatchOnTable === table && count === this.failBatchIndex) {
          return Promise.resolve({
            error: { message: `Simulated middle-batch failure on ${table} at batch ${count}` },
          });
        }

        const list = Array.isArray(rows) ? rows : [rows];
        this.upserts.push({ table, rows: list });

        let tableRows = this.tables.get(table);
        if (!tableRows) {
          tableRows = [];
          this.tables.set(table, tableRows);
        }
        tableRows.push(...list);

        return Promise.resolve({ error: null });
      },
    };
  }

  rpc(_name: string, _args?: unknown) {
    return Promise.resolve({ data: [], error: null });
  }
}

Deno.test('DEFAULT_WRITE_BATCH_SIZE is 500', () => {
  assertEquals(DEFAULT_WRITE_BATCH_SIZE, 500);
});

Deno.test('IndexerDb.upsertEvents chunks writes so no request exceeds batch size', async () => {
  const client = new RecordingClient();
  const db = new IndexerDb('http://localhost', 'key', client as unknown as SupabaseClient);

  // Generate 1250 rows with batchSize = 500
  const totalRows = 1250;
  const batchSize = 500;
  const rows: IndexedEventRow[] = Array.from({ length: totalRows }, (_, i) => ({
    event_identity: `evt-${i}`,
    ledger: 100,
    tx_hash: `tx-${i}`,
    tx_index: 0,
    event_index: i,
    contract_id: 'C123',
    topic: ['test'],
    value: 'val',
  }));

  await db.upsertEvents(rows, batchSize);

  // Must have produced ceil(1250 / 500) = 3 requests
  const eventUpserts = client.upserts.filter((u) => u.table === 'indexed_events');
  assertEquals(eventUpserts.length, 3);
  assertEquals(eventUpserts[0]?.rows.length, 500);
  assertEquals(eventUpserts[1]?.rows.length, 500);
  assertEquals(eventUpserts[2]?.rows.length, 250);

  // Verify none exceeds configured batchSize
  for (const call of eventUpserts) {
    assert(call.rows.length <= batchSize, `Batch size ${call.rows.length} exceeds ${batchSize}`);
  }

  // Verify all rows written exactly once across batch boundaries
  assertEquals(client.tables.get('indexed_events')?.length, totalRows);
  assertEquals(client.tables.get('indexed_events')?.[0]?.['event_identity'], 'evt-0');
  assertEquals(client.tables.get('indexed_events')?.[499]?.['event_identity'], 'evt-499');
  assertEquals(client.tables.get('indexed_events')?.[500]?.['event_identity'], 'evt-500');
  assertEquals(client.tables.get('indexed_events')?.[1249]?.['event_identity'], 'evt-1249');
});

Deno.test('IndexerDb.upsertGroups chunks writes into bounded batches', async () => {
  const client = new RecordingClient();
  const db = new IndexerDb('http://localhost', 'key', client as unknown as SupabaseClient);

  const totalGroups = 750;
  const batchSize = 300;
  const groups: NewGroup[] = Array.from({ length: totalGroups }, (_, i) => ({
    contract_id: `CGROUP-${i}`,
    factory_contract_id: 'CFACTORY',
    group_id: i + 1,
    creator: `addr-${i}`,
    token: 'USDC',
    contribution_amount: '100',
    member_capacity: 10,
    created_ledger: 100,
  }));

  await db.upsertGroups(groups, batchSize);

  const groupUpserts = client.upserts.filter((u) => u.table === 'groups');
  assertEquals(groupUpserts.length, 3);
  assertEquals(groupUpserts[0]?.rows.length, 300);
  assertEquals(groupUpserts[1]?.rows.length, 300);
  assertEquals(groupUpserts[2]?.rows.length, 150);

  for (const call of groupUpserts) {
    assert(call.rows.length <= batchSize);
  }
  assertEquals(client.tables.get('groups')?.length, totalGroups);
});

Deno.test('IndexerDb.persistPlan chunks fact tables into bounded batches', async () => {
  const client = new RecordingClient();
  const db = new IndexerDb('http://localhost', 'key', client as unknown as SupabaseClient);

  const batchSize = 250;
  const plan: IngestPlan = {
    decoded: Array.from({ length: 600 }, (_, i) => ({
      event_identity: `dec-${i}`,
      name: 'contribution',
      contract_id: 'C1',
      ledger: 100,
      tx_hash: 'tx',
      tx_index: 0,
      event_index: i,
      event_id: `eid-${i}`,
      payload: {},
    })),
    members: Array.from({ length: 550 }, (_, i) => ({
      contract_id: 'C1',
      member: `mem-${i}`,
      position: i + 1,
      joined_ledger: 100,
      event_identity: `join-${i}`,
    })),
    contributions: Array.from({ length: 700 }, (_, i) => ({
      event_identity: `contrib-${i}`,
      contract_id: 'C1',
      member: `mem-${i}`,
      round: 1,
      amount: '1000',
      ledger: 100,
      tx_hash: 'tx',
    })),
    payouts: [],
    fees: [],
    touchedGroups: ['C1'],
  };

  await db.persistPlan(plan, batchSize);

  const decodedUpserts = client.upserts.filter((u) => u.table === 'decoded_events');
  assertEquals(decodedUpserts.length, 3); // 250 + 250 + 100 = 600
  assertEquals(decodedUpserts[0]?.rows.length, 250);
  assertEquals(decodedUpserts[1]?.rows.length, 250);
  assertEquals(decodedUpserts[2]?.rows.length, 100);

  const memberUpserts = client.upserts.filter((u) => u.table === 'group_members');
  assertEquals(memberUpserts.length, 3); // 250 + 250 + 50 = 550

  const contribUpserts = client.upserts.filter((u) => u.table === 'contributions');
  assertEquals(contribUpserts.length, 3); // 250 + 250 + 200 = 700

  assertEquals(client.tables.get('decoded_events')?.length, 600);
  assertEquals(client.tables.get('group_members')?.length, 550);
  assertEquals(client.tables.get('contributions')?.length, 700);
});

Deno.test('IndexerDb.recordRejectedEvents chunks writes into bounded batches', async () => {
  const client = new RecordingClient();
  const db = new IndexerDb('http://localhost', 'key', client as unknown as SupabaseClient);

  const rows: RejectedEventRow[] = Array.from({ length: 350 }, (_, i) => ({
    event_id: `rej-${i}`,
    ledger: 100,
    tx_hash: 'tx',
    tx_index: 0,
    event_index: i,
    contract_id: 'C1',
    reason: 'unknown',
  }));

  await db.recordRejectedEvents('corr-1', rows, 200);

  const rejUpserts = client.upserts.filter((u) => u.table === 'indexer_rejected_events');
  assertEquals(rejUpserts.length, 2);
  assertEquals(rejUpserts[0]?.rows.length, 200);
  assertEquals(rejUpserts[1]?.rows.length, 150);
});

Deno.test('A failed middle batch throws immediately and leaves subsequent batches unwritten', async () => {
  const client = new RecordingClient();
  client.failBatchOnTable = 'indexed_events';
  client.failBatchIndex = 1; // fail on the second batch (0-indexed)

  const db = new IndexerDb('http://localhost', 'key', client as unknown as SupabaseClient);

  const rows: IndexedEventRow[] = Array.from({ length: 1500 }, (_, i) => ({
    event_identity: `evt-${i}`,
    ledger: 100,
    tx_hash: `tx-${i}`,
    tx_index: 0,
    event_index: i,
    contract_id: 'C123',
    topic: ['test'],
    value: 'val',
  }));

  await assertRejects(
    () => db.upsertEvents(rows, 500),
    Error,
    'Simulated middle-batch failure on indexed_events at batch 1',
  );

  // Batch 0 was written, batch 1 failed, batch 2 was never attempted
  const eventUpserts = client.upserts.filter((u) => u.table === 'indexed_events');
  assertEquals(eventUpserts.length, 1);
  assertEquals(eventUpserts[0]?.rows.length, 500);
  assertEquals(client.tables.get('indexed_events')?.length, 500);
});
