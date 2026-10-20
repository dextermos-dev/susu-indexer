/**
 * `bulk_update_group_state`: single-statement replacement for N+1 group reconciliation updates.
 *
 * Tests the migration SQL and IndexerDb.upsertGroupState against real Postgres (PGlite).
 */

import { assertEquals, assertRejects } from '@std/assert';
import type { SupabaseClient } from '@supabase/supabase-js';
import { PGlite } from 'npm:@electric-sql/pglite@0.5.8';
import { IndexerDb } from '../supabase/functions/_shared/db.ts';
import type { GroupState } from '../supabase/functions/_shared/state.ts';

const MIGRATION_URL = new URL(
  '../supabase/migrations/20261020000001_bulk_update_group_state.sql',
  import.meta.url,
);

const SCHEMA = `
create table public.groups (
  contract_id text primary key,
  factory_contract_id text not null,
  group_id bigint not null check (group_id > 0),
  creator text not null,
  token text not null,
  contribution_amount numeric(39,0) not null check (contribution_amount > 0),
  member_capacity integer not null check (member_capacity > 0),
  created_ledger bigint not null check (created_ledger >= 0),
  status text not null default 'open' check (status in ('open', 'active', 'completed')),
  member_count integer not null default 0 check (member_count >= 0),
  current_round integer not null default 0 check (current_round >= 0),
  completed_rounds integer not null default 0 check (completed_rounds >= 0),
  contributed_total numeric(39,0) not null default 0 check (contributed_total >= 0),
  paid_out_total numeric(39,0) not null default 0 check (paid_out_total >= 0),
  fee_total numeric(39,0) not null default 0 check (fee_total >= 0),
  last_event_ledger bigint not null default 0 check (last_event_ledger >= 0),
  discovered_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
`;

const HUGE = '999999999999999999999999999999999999999';

async function freshDb(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(SCHEMA);
  await db.exec('create role service_role nologin;');
  await db.exec(await Deno.readTextFile(MIGRATION_URL));
  return db;
}

function dbOverRpc(pglite: PGlite): IndexerDb {
  const rpc = async (fn: string, args: Record<string, unknown>) => {
    if (fn === 'bulk_update_group_state') {
      const payload = JSON.stringify(args['p_states']);
      const result = await pglite.query('select contract_id from public.bulk_update_group_state($1)', [
        payload,
      ]);
      return { data: result.rows, error: null };
    }
    throw new Error(`unexpected rpc ${fn}`);
  };
  return new IndexerDb('http://localhost', 'test-key', { rpc } as unknown as SupabaseClient);
}

async function insertGroup(db: PGlite, contractId: string, groupId: number): Promise<void> {
  await db.query(
    `insert into public.groups
       (contract_id, factory_contract_id, group_id, creator, token, contribution_amount, member_capacity, created_ledger)
     values ($1, 'factory-1', $2, 'creator-1', 'token-1', 1000, 10, 100)`,
    [contractId, groupId],
  );
}

Deno.test('bulk_update_group_state updates multiple groups with wide amounts in one call', async () => {
  const pglite = await freshDb();
  await insertGroup(pglite, 'group-1', 1);
  await insertGroup(pglite, 'group-2', 2);

  const db = dbOverRpc(pglite);

  const states: GroupState[] = [
    {
      contract_id: 'group-1',
      status: 'active',
      member_count: 5,
      current_round: 2,
      completed_rounds: 1,
      contributed_total: HUGE,
      paid_out_total: '5000000',
      fee_total: '50000',
      last_event_ledger: 500,
    },
    {
      contract_id: 'group-2',
      status: 'completed',
      member_count: 10,
      current_round: 3,
      completed_rounds: 3,
      contributed_total: '30000000',
      paid_out_total: '29000000',
      fee_total: '1000000',
      last_event_ledger: 600,
    },
  ];

  await db.upsertGroupState(states);

  const res1 = await pglite.query('select * from public.groups where contract_id = $1', ['group-1']);
  const g1 = res1.rows[0] as Record<string, unknown>;
  assertEquals(g1['status'], 'active');
  assertEquals(g1['member_count'], 5);
  assertEquals(g1['current_round'], 2);
  assertEquals(g1['completed_rounds'], 1);
  assertEquals(String(g1['contributed_total']), HUGE);
  assertEquals(String(g1['paid_out_total']), '5000000');
  assertEquals(String(g1['fee_total']), '50000');
  assertEquals(Number(g1['last_event_ledger']), 500);

  const res2 = await pglite.query('select * from public.groups where contract_id = $1', ['group-2']);
  const g2 = res2.rows[0] as Record<string, unknown>;
  assertEquals(g2['status'], 'completed');
  assertEquals(g2['member_count'], 10);
  assertEquals(g2['current_round'], 3);
  assertEquals(g2['completed_rounds'], 3);
  assertEquals(String(g2['contributed_total']), '30000000');
  assertEquals(String(g2['paid_out_total']), '29000000');
  assertEquals(String(g2['fee_total']), '1000000');
  assertEquals(Number(g2['last_event_ledger']), 600);
});

Deno.test('bulk_update_group_state fails loudly if any group has no row', async () => {
  const pglite = await freshDb();
  await insertGroup(pglite, 'group-1', 1);

  const db = dbOverRpc(pglite);

  await assertRejects(
    () =>
      db.upsertGroupState([
        {
          contract_id: 'group-1',
          status: 'active',
          member_count: 1,
          current_round: 1,
          completed_rounds: 0,
          contributed_total: '100',
          paid_out_total: '0',
          fee_total: '0',
          last_event_ledger: 100,
        },
        {
          contract_id: 'group-missing',
          status: 'open',
          member_count: 0,
          current_round: 0,
          completed_rounds: 0,
          contributed_total: '0',
          paid_out_total: '0',
          fee_total: '0',
          last_event_ledger: 0,
        },
      ]),
    Error,
    'no groups row for group-missing',
  );
});

Deno.test('bulk_update_group_state on empty array is a clean no-op', async () => {
  const pglite = await freshDb();
  const db = dbOverRpc(pglite);
  await db.upsertGroupState([]);
});
