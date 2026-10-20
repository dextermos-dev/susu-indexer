/**
 * Orchestration tests: the request handler and the database layer.
 *
 * `tests/` previously covered pure modules only — there was no reference to
 * `db.ts`, `index.ts`, `handleRequest`, `IndexerDb`, `toIndexedRow` or
 * `advanceCheckpoint`. These tests drive the full two-pass flow
 * (range -> decode -> discover -> second pass -> persist -> reconcile ->
 * advance) against a stubbed Supabase client and a scripted RPC source built
 * from the captured Testnet fixtures, plus the failure path that must not
 * advance the checkpoint.
 */

import { assert, assertEquals, assertRejects } from '@std/assert';
import type { SupabaseClient } from '@supabase/supabase-js';
import { IndexerDb } from '../supabase/functions/_shared/db.ts';
import {
  handleRequest,
  type RpcSource,
  toIndexedRow,
} from '../supabase/functions/indexer/index.ts';
import type {
  EventPageStart,
  GetEventsResult,
  RpcEvent,
} from '../supabase/functions/_shared/stellar.ts';
import { FACTORY_ID, factoryEvent, GROUP_ID, groupEvents } from './fixture.ts';

type Row = Record<string, unknown>;

/**
 * Column defaults the migrations give the groups table. A stub that dropped
 * them would hand `readGroupState` rows no real database could produce
 * (and `compareGroupState` would choke on the missing money fields).
 */
const GROUPS_DEFAULTS: Row = {
  status: 'open',
  member_count: 0,
  current_round: 0,
  completed_rounds: 0,
  contributed_total: 0,
  paid_out_total: 0,
  fee_total: 0,
  last_event_ledger: 0,
};

type StubCall = {
  table: string;
  op: 'select' | 'upsert' | 'insert' | 'update';
};

/**
 * A Supabase client stub with in-memory tables.
 *
 * Implements exactly the PostgREST chains `IndexerDb` uses — select with
 * eq/in/maybeSingle, upsert with onConflict/ignoreDuplicates, insert, and
 * update with an exact count — and records every executed operation so tests
 * can assert on what the handler did, not just what it returned. Anything
 * else the real client can do is out of scope; the cast at the injection
 * site is the honest marker of that boundary.
 */
class StubSupabaseClient {
  readonly tables = new Map<string, Row[]>();
  readonly calls: StubCall[] = [];
  /** When set, this operation throws instead of executing. */
  failOn: StubCall | null = null;
  /** When set, this operation returns `{ error }` instead of executing. */
  errorOn: StubCall | null = null;

  from(table: string): StubBuilder {
    return new StubBuilder(this, table);
  }

  rpc(_name: string, _args?: unknown): Promise<{ data: unknown[]; error: null }> {
    return Promise.resolve({ data: [], error: null });
  }

  rows(table: string): Row[] {
    let rows = this.tables.get(table);
    if (!rows) {
      rows = [];
      this.tables.set(table, rows);
    }
    return rows;
  }

  callsTo(table: string, op: StubCall['op']): StubCall[] {
    return this.calls.filter((c) => c.table === table && c.op === op);
  }
}

type Filter = { column: string; op: 'eq' | 'in' | 'lt'; value: unknown };

class StubBuilder {
  #client: StubSupabaseClient;
  #table: string;
  #mode: StubCall['op'] | null = null;
  #filters: Filter[] = [];
  #maybeSingle = false;
  #upsertRows: Row[] = [];
  #upsertOnConflict: string[] = [];
  #upsertIgnoreDuplicates = false;
  #insertRow: Row | null = null;
  #updateValues: Row | null = null;
  #range: { from: number; to: number } | null = null;

  constructor(client: StubSupabaseClient, table: string) {
    this.#client = client;
    this.#table = table;
  }

  select(_columns: string): this {
    if (this.#mode !== 'update') {
      this.#mode = 'select';
    }
    return this;
  }

  order(_col: string, _opts?: { ascending: boolean }): this {
    return this;
  }

  range(from: number, to: number): this {
    this.#range = { from, to };
    return this;
  }

  lt(column: string, value: unknown): this {
    this.#filters.push({ column, op: 'lt', value });
    return this;
  }

  eq(column: string, value: unknown): this {
    this.#filters.push({ column, op: 'eq', value });
    return this;
  }

  in(column: string, values: readonly unknown[]): this {
    this.#filters.push({ column, op: 'in', value: [...values] });
    return this;
  }

  maybeSingle(): this {
    this.#maybeSingle = true;
    return this;
  }

  upsert(
    rows: readonly Row[] | Row,
    opts?: { onConflict?: string; ignoreDuplicates?: boolean },
  ): this {
    this.#mode = 'upsert';
    const list = Array.isArray(rows) ? rows : [rows];
    this.#upsertRows = list.map((row) => ({ ...row }));
    this.#upsertOnConflict = (opts?.onConflict ?? '')
      .split(',')
      .map((c) => c.trim())
      .filter((c) => c.length > 0);
    this.#upsertIgnoreDuplicates = opts?.ignoreDuplicates ?? false;
    return this;
  }

  insert(row: Row): this {
    this.#mode = 'insert';
    this.#insertRow = { ...row };
    return this;
  }

  update(values: Row, _opts?: { count?: string }): this {
    this.#mode = 'update';
    this.#updateValues = { ...values };
    return this;
  }

  // Thenable, so `await` works on every chain the way it does on the real
  // PostgREST builder.
  then(
    onfulfilled?: ((value: unknown) => unknown) | null,
    onrejected?: ((reason: unknown) => unknown) | null,
  ): Promise<unknown> {
    return this.#run().then(onfulfilled, onrejected);
  }

  #matches(row: Row): boolean {
    return this.#filters.every((filter) => {
      const value = row[filter.column];
      if (filter.op === 'eq') return value === filter.value;
      if (filter.op === 'lt') {
        return typeof value === 'number' && typeof filter.value === 'number' &&
          value < filter.value;
      }
      return (filter.value as unknown[]).includes(value);
    });
  }

  #run(): Promise<unknown> {
    const mode = this.#mode;
    if (mode === null) return Promise.reject(new Error('stub: builder awaited with no operation'));
    const failOn = this.#client.failOn;
    if (failOn !== null && failOn.table === this.#table && failOn.op === mode) {
      return Promise.reject(new Error(`stubbed failure: ${mode} on ${this.#table}`));
    }
    const errorOn = this.#client.errorOn;
    if (errorOn !== null && errorOn.table === this.#table && errorOn.op === mode) {
      this.#client.calls.push({ table: this.#table, op: mode });
      return Promise.resolve({
        error: { message: `stubbed error: ${mode} on ${this.#table}` },
        data: null,
        count: null,
      });
    }
    this.#client.calls.push({ table: this.#table, op: mode });
    switch (mode) {
      case 'select': {
        let rows = this.#client.rows(this.#table).filter((row) => this.#matches(row));
        if (this.#range !== null) {
          rows = rows.slice(this.#range.from, this.#range.to + 1);
        }
        if (this.#maybeSingle) return Promise.resolve({ data: rows[0] ?? null, error: null });
        return Promise.resolve({ data: rows, error: null });
      }
      case 'upsert': {
        const table = this.#client.rows(this.#table);
        for (const row of this.#upsertRows) {
          const identity = (r: Row) => this.#upsertOnConflict.map((c) => String(r[c])).join('|');
          const existing = this.#upsertOnConflict.length > 0
            ? table.find((r) => identity(r) === identity(row))
            : undefined;
          if (existing !== undefined) {
            if (!this.#upsertIgnoreDuplicates) Object.assign(existing, row);
          } else {
            table.push(this.#table === 'groups' ? { ...GROUPS_DEFAULTS, ...row } : row);
          }
        }
        return Promise.resolve({ error: null });
      }
      case 'insert': {
        if (this.#insertRow !== null) this.#client.rows(this.#table).push(this.#insertRow);
        return Promise.resolve({ error: null });
      }
      case 'update': {
        const matched = this.#client.rows(this.#table).filter((row) => this.#matches(row));
        for (const row of matched) Object.assign(row, this.#updateValues);
        return Promise.resolve({ error: null, count: matched.length, data: matched });
      }
    }
  }
}

/**
 * A scripted RPC source: serves captured events filtered the way the real
 * endpoint would, one page at a time. The scan under test pages until a short
 * page, so a single full page is enough to prove the range was read.
 */
class ScriptedRpc implements RpcSource {
  readonly requests: Array<EventPageStart & { contractIds: string[] }> = [];

  constructor(
    private readonly events: readonly RpcEvent[],
    private readonly head: number,
  ) {}

  getLatestLedger(): Promise<number> {
    return Promise.resolve(this.head);
  }

  getEvents(
    params: EventPageStart & { contractIds: string[]; limit?: number },
  ): Promise<GetEventsResult> {
    const { limit: _limit, ...recorded } = params;
    this.requests.push(recorded);
    if (params.kind === 'range') {
      const ids = new Set(params.contractIds);
      const events = this.events.filter((event) =>
        ids.has(event.contractId) &&
        event.ledger >= params.startLedger &&
        event.ledger < params.endLedger
      );
      return Promise.resolve({ events });
    }
    return Promise.resolve({ events: [] });
  }
}

const TASK_SECRET = 'test-task-secret-0123456789abcdef';
const USDC_ID = `C${'B'.repeat(55)}`;

/** The ledgers the scripted scenario plays in. */
const SCENARIO_FROM = 4629055;
const SCENARIO_HEAD = 4629120;

function withTestEnv(): () => void {
  const vars: Record<string, string> = {
    SUPABASE_URL: 'https://example.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'test-service-role-key',
    INDEXER_TASK_SECRET: TASK_SECRET,
    STELLAR_RPC_URL: 'https://rpc.example.com',
    STELLAR_NETWORK_PASSPHRASE: 'Test SDF Network ; September 2015',
    FACTORY_CONTRACT_ID: FACTORY_ID,
    USDC_CONTRACT_ID: USDC_ID,
    INDEXER_START_LEDGER: String(SCENARIO_FROM),
  };
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(vars)) {
    previous.set(key, Deno.env.get(key));
    Deno.env.set(key, value);
  }
  return () => {
    for (const [key, value] of previous) {
      if (value === undefined) Deno.env.delete(key);
      else Deno.env.set(key, value);
    }
  };
}

function authorizedRequest(): Request {
  return new Request('http://localhost/', {
    headers: { 'x-indexer-task-secret': TASK_SECRET },
  });
}

function makeDeps(events: readonly RpcEvent[], head: number): {
  stub: StubSupabaseClient;
  db: IndexerDb;
  rpc: ScriptedRpc;
} {
  const stub = new StubSupabaseClient();
  // The stub implements the PostgREST surface IndexerDb uses; the cast marks
  // that boundary explicitly.
  const db = new IndexerDb(
    'https://example.supabase.co',
    'test-service-role-key',
    stub as unknown as SupabaseClient,
  );
  const rpc = new ScriptedRpc(events, head);
  return { stub, db, rpc };
}

Deno.test('toIndexedRow maps an RPC event onto an index row', () => {
  const event = groupEvents[0];
  if (!event) throw new Error('fixture is empty');
  const row = toIndexedRow(event);

  assertEquals(row.ledger, event.ledger);
  assertEquals(row.tx_hash, event.txHash);
  assertEquals(row.tx_index, event.txIndex);
  assertEquals(row.event_index, event.eventIndex);
  assertEquals(row.contract_id, event.contractId);
  assertEquals(row.topic, [...event.topic]);
  assertEquals(row.value, event.value);
  assert(row.event_identity.length > 0, 'identity must be derived');
});

Deno.test('handleRequest runs the full two-pass flow and advances the checkpoint', async () => {
  const restoreEnv = withTestEnv();
  try {
    // The 6th captured factory event creates the group whose 20 events follow
    // in the same range: the discovery that forces the second pass.
    const { stub, db, rpc } = makeDeps([factoryEvent(5), ...groupEvents], SCENARIO_HEAD);

    const response = await handleRequest(authorizedRequest(), { db, rpc });
    assertEquals(response.status, 200);
    const body = await response.json();

    assertEquals(body.status, 'ok');
    assertEquals(body.ledgerFrom, SCENARIO_FROM);
    assertEquals(body.ledgerTo, SCENARIO_HEAD);
    assertEquals(body.eventsIndexed, 21);
    assertEquals(body.eventsDecoded, 21);
    assertEquals(body.eventsRejected, 0);
    assertEquals(body.groupsDiscovered, 1);
    assertEquals(body.checkpoint, SCENARIO_HEAD);

    // The second pass actually happened: a later scan watched the group the
    // first pass discovered.
    const secondPass = rpc.requests.find((r) => r.contractIds.includes(GROUP_ID));
    assert(secondPass !== undefined, 'expected a second scan for the discovered group');

    // The checkpoint advanced exactly once, to the end of the range.
    assertEquals(stub.callsTo('indexer_checkpoints', 'upsert').length, 1);
    assertEquals(
      stub.rows('indexer_checkpoints')[0]?.['last_processed_ledger'],
      SCENARIO_HEAD,
    );

    // Everything the run promised to write is on record.
    assertEquals(stub.rows('indexed_events').length, 21);
    assertEquals(stub.rows('groups').length, 1);
    assertEquals(stub.rows('groups')[0]?.['contract_id'], GROUP_ID);
    assertEquals(stub.rows('decoded_events').length, 21);
    assertEquals(stub.rows('indexer_runs').length, 0);
  } finally {
    restoreEnv();
  }
});

Deno.test('a rejected event is persisted with its coordinates before the checkpoint advances', async () => {
  const restoreEnv = withTestEnv();
  try {
    const base = factoryEvent(5);
    if (!base) throw new Error('fixture is empty');
    // A real Factory event with its body replaced by a symbol: it decodes to a
    // non-map and is rejected, but keeps a distinct identity from its source.
    const rejectedEvent: RpcEvent = {
      ...base,
      eventIndex: base.eventIndex + 1000,
      id: `${base.ledger}-${base.eventIndex + 1000}`,
      value: base.topic[0] as string,
    };

    const { stub, db, rpc } = makeDeps(
      [rejectedEvent, factoryEvent(5), ...groupEvents],
      SCENARIO_HEAD,
    );

    const response = await handleRequest(authorizedRequest(), { db, rpc });
    assertEquals(response.status, 200);
    const body = await response.json();
    assertEquals(body.eventsRejected, 1);
    assertEquals(body.eventsDecoded, groupEvents.length + 1);

    // The acceptance criterion: a rejection is a durable record, not a log line.
    const rows = stub.rows('indexer_rejected_events');
    assertEquals(rows.length, 1);
    assertEquals(rows[0]?.['event_id'], rejectedEvent.id);
    assertEquals(rows[0]?.['contract_id'], rejectedEvent.contractId);
    assertEquals(rows[0]?.['ledger'], rejectedEvent.ledger);
    assertEquals(rows[0]?.['event_index'], rejectedEvent.eventIndex);
    assert(
      (rows[0]?.['reason'] as string).includes('not a map'),
      'the rejection reason must be recorded',
    );

    // Persisting the rejection is part of the write set, so the checkpoint
    // still advances once everything is on record.
    assertEquals(body.checkpoint, SCENARIO_HEAD);
    assertEquals(
      stub.rows('indexer_checkpoints')[0]?.['last_processed_ledger'],
      SCENARIO_HEAD,
    );
  } finally {
    restoreEnv();
  }
});

Deno.test('a run whose only event is rejected still records it', async () => {
  const restoreEnv = withTestEnv();
  try {
    const base = factoryEvent(5);
    if (!base) throw new Error('fixture is empty');
    const rejectedEvent: RpcEvent = {
      ...base,
      eventIndex: base.eventIndex + 1000,
      id: `${base.ledger}-${base.eventIndex + 1000}`,
      value: base.topic[0] as string,
    };

    const { stub, db, rpc } = makeDeps([rejectedEvent], SCENARIO_HEAD);

    const response = await handleRequest(authorizedRequest(), { db, rpc });
    assertEquals(response.status, 200);
    const body = await response.json();
    assertEquals(body.eventsRejected, 1);
    assertEquals(body.eventsDecoded, 0);
    assertEquals(stub.rows('indexer_rejected_events').length, 1);
  } finally {
    restoreEnv();
  }
});

Deno.test('IndexerDb.recordRejectedEvents throws so a rejection cannot be silently lost', async () => {
  const { stub, db } = makeDeps([], SCENARIO_HEAD);
  stub.errorOn = { table: 'indexer_rejected_events', op: 'upsert' };

  await assertRejects(
    () =>
      db.recordRejectedEvents('corr', [{
        event_id: 'ledger-token-7',
        ledger: 10,
        tx_hash: 'a'.repeat(64),
        tx_index: 0,
        event_index: 7,
        contract_id: FACTORY_ID,
        reason: 'unknown event name',
      }]),
    Error,
    'rejected events',
  );
});

Deno.test('IndexerDb.recordRejectedEvents is a no-op for an empty batch', async () => {
  const { stub, db } = makeDeps([], SCENARIO_HEAD);
  await db.recordRejectedEvents('corr', []);
  assertEquals(stub.rows('indexer_rejected_events').length, 0);
  assertEquals(stub.callsTo('indexer_rejected_events', 'upsert'), []);
});

Deno.test('a failed run records the failure and never advances the checkpoint', async () => {
  const restoreEnv = withTestEnv();
  try {
    const { stub, db, rpc } = makeDeps([factoryEvent(5), ...groupEvents], SCENARIO_HEAD);
    stub.failOn = { table: 'indexed_events', op: 'upsert' };

    const response = await handleRequest(authorizedRequest(), { db, rpc });
    assertEquals(response.status, 500);
    const body = await response.json();
    assertEquals(body.status, 'failed');

    // The acceptance criterion: the checkpoint is untouched, so the next run
    // retries the same range instead of skipping it.
    assertEquals(stub.callsTo('indexer_checkpoints', 'upsert'), []);

    // ...but the failure is on record for operators.
    const runs = stub.rows('indexer_runs');
    assertEquals(runs.length, 1);
    assertEquals(runs[0]?.['status'], 'failed');
    assert((runs[0]?.['reason'] as string).length > 0, 'a reason must be recorded');

    // The failed run records the range it was actually working on, so an
    // operator reading indexer_runs knows which ledgers to retry.
    assertEquals(runs[0]?.['ledger_from'], SCENARIO_FROM);
    assertEquals(runs[0]?.['ledger_to'], SCENARIO_HEAD);
  } finally {
    restoreEnv();
  }
});

Deno.test('a failure before the range is computed records an unknown range of 0/0', async () => {
  const restoreEnv = withTestEnv();
  try {
    const { stub, db } = makeDeps([], SCENARIO_HEAD);
    // The checkpoint read fails, so no range has been computed yet.
    stub.failOn = { table: 'indexer_checkpoints', op: 'select' };

    const response = await handleRequest(authorizedRequest(), { db });
    assertEquals(response.status, 500);
    const body = await response.json();
    assertEquals(body.status, 'failed');

    const runs = stub.rows('indexer_runs');
    assertEquals(runs.length, 1);
    assertEquals(runs[0]?.['ledger_from'], 0);
    assertEquals(runs[0]?.['ledger_to'], 0);
  } finally {
    restoreEnv();
  }
});

Deno.test('handleRequest skips a range the checkpoint already covers', async () => {
  const restoreEnv = withTestEnv();
  try {
    const { stub, db, rpc } = makeDeps([], SCENARIO_HEAD);
    await db.advanceCheckpoint({ lastProcessedLedger: SCENARIO_HEAD, startLedger: SCENARIO_FROM });
    stub.calls.length = 0;

    const response = await handleRequest(authorizedRequest(), { db, rpc });
    assertEquals(response.status, 200);
    const body = await response.json();
    assertEquals(body.status, 'skipped');

    // Nothing but the checkpoint read and latest-ledger record happened: no events, no data writes.
    assertEquals(
      stub.calls.filter(
        (call) =>
          call.op !== 'select' &&
          !(call.op === 'update' && call.table === 'indexer_checkpoints'),
      ),
      [],
    );
    assertEquals(rpc.requests, []);
  } finally {
    restoreEnv();
  }
});

Deno.test('IndexerDb.getCheckpoint returns undefined when the indexer never ran', async () => {
  const { db } = makeDeps([], SCENARIO_HEAD);
  assertEquals(await db.getCheckpoint(), undefined);
});

Deno.test('IndexerDb.upsertEvents ignores duplicate identities', async () => {
  const { stub, db } = makeDeps([], SCENARIO_HEAD);
  const event = groupEvents[0];
  if (!event) throw new Error('fixture is empty');
  const row = toIndexedRow(event);

  await db.upsertEvents([row]);
  await db.upsertEvents([row]);
  assertEquals(stub.rows('indexed_events').length, 1);
});

Deno.test('IndexerDb.advanceCheckpoint writes the checkpoint row', async () => {
  const { stub, db } = makeDeps([], SCENARIO_HEAD);
  await db.advanceCheckpoint({ lastProcessedLedger: 99, startLedger: 1 });

  const rows = stub.rows('indexer_checkpoints');
  assertEquals(rows.length, 1);
  assertEquals(rows[0]?.['last_processed_ledger'], 99);
  assertEquals(rows[0]?.['start_ledger'], 1);
});

Deno.test('IndexerDb.upsertGroupState throws when the group has no row', async () => {
  const { db } = makeDeps([], SCENARIO_HEAD);
  // Reconciliation updates groups discovery recorded; it never creates them,
  // so zero updated rows is a loud failure, not a silent skip.
  await assertRejects(
    () =>
      db.upsertGroupState([{
        contract_id: GROUP_ID,
        status: 'open',
        member_count: 0,
        current_round: 0,
        completed_rounds: 0,
        contributed_total: '0',
        paid_out_total: '0',
        fee_total: '0',
        last_event_ledger: 0,
      }]),
    Error,
    'no groups row',
  );
});

Deno.test('IndexerDb.recordRunFailure never throws on error response', async () => {
  const { stub, db } = makeDeps([], SCENARIO_HEAD);
  stub.errorOn = { table: 'indexer_runs', op: 'insert' };

  await db.recordRunFailure({
    correlationId: 'test',
    ledgerFrom: 1,
    ledgerTo: 2,
    reason: 'boom',
  });
});

Deno.test('IndexerDb.recordRunFailure never rejects when insert rejects', async () => {
  const { stub, db } = makeDeps([], SCENARIO_HEAD);
  stub.failOn = { table: 'indexer_runs', op: 'insert' };

  await db.recordRunFailure({
    correlationId: 'test',
    ledgerFrom: 1,
    ledgerTo: 2,
    reason: 'network down',
  });
});

Deno.test('handleRequest returns structured 500 even when recordRunFailure insert rejects', async () => {
  const restoreEnv = withTestEnv();
  try {
    const { stub, db } = makeDeps([], SCENARIO_HEAD);
    const rpc: RpcSource = {
      getLatestLedger: () => Promise.resolve(SCENARIO_HEAD),
      getEvents: () => Promise.reject(new Error('RPC endpoint unavailable')),
    };
    stub.failOn = { table: 'indexer_runs', op: 'insert' };

    const response = await handleRequest(authorizedRequest(), { db, rpc });
    assertEquals(response.status, 500);
    const body = await response.json();
    assertEquals(body.status, 'failed');
    assertEquals(body.reason, 'RPC endpoint unavailable');
  } finally {
    restoreEnv();
  }
});
