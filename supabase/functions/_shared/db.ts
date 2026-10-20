/**
 * Index tables and checkpoint persistence.
 *
 * Uses the service-role key, which bypasses RLS. This code runs **only** in the
 * trusted indexer function: the key must never be shipped to a client, embedded
 * in a response, or written to a log.
 *
 * RLS remains enabled on these tables and grants browser roles no access, so a
 * leaked anon key cannot read or write index state. The service role is not a
 * substitute for those protections — it is an additional, server-only path.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Checkpoint } from './checkpoint.ts';
import type { NewGroup } from './discovery.ts';
import type { IngestPlan } from './ingest.ts';
import type { GroupFacts, GroupState, StoredGroupState } from './state.ts';

/**
 * Facts as they are accumulated while reading.
 *
 * The arrays are mutable so they can be pushed to; `GroupFacts` accepts them
 * because a mutable array is assignable to a readonly one.
 */
type MutableFacts = {
  members: { position: number }[];
  contributions: { round: number; amount: string }[];
  payouts: { round: number; recipient_amount: string }[];
  fees: { round: number; fee: string }[];
  started: boolean;
  completed: boolean;
  lastEventLedger: number;
};

export type IndexedEventRow = {
  /** Chain-derived identity; unique, so replays never duplicate rows. */
  event_identity: string;
  ledger: number;
  tx_hash: string;
  tx_index: number;
  event_index: number;
  contract_id: string;
  topic: string[];
  value: string;
};

/**
 * A raw event the decoder rejected, as it is persisted.
 *
 * The identity (`event_id`) and the chain coordinates let an operator find the
 * offending event on chain; the reason says why the decoder refused it.
 */
export type RejectedEventRow = {
  event_id: string;
  ledger: number;
  tx_hash: string;
  tx_index: number;
  event_index: number;
  contract_id: string;
  reason: string;
};

export class IndexerDb {
  #client: SupabaseClient;

  /**
   * An explicit client may be injected for tests, so the orchestration can be
   * exercised against a stub instead of a live database. Production callers
   * omit it and get the service-role client as before.
   */
  constructor(supabaseUrl: string, serviceRoleKey: string, client?: SupabaseClient) {
    this.#client = client ??
      createClient(supabaseUrl, serviceRoleKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
  }

  /**
   * Reads the stored checkpoint.
   *
   * Returns `undefined` when none exists, which means the indexer has not run
   * yet and should start from the configured deployment ledger.
   */
  async getCheckpoint(): Promise<Checkpoint | undefined> {
    const { data, error } = await this.#client
      .from('indexer_checkpoints')
      .select('last_processed_ledger, start_ledger, updated_at')
      .eq('id', 'default')
      .maybeSingle();

    if (error) {
      throw new Error(`Failed to read indexer checkpoint: ${error.message}`);
    }
    if (!data) return undefined;

    return {
      lastProcessedLedger: Number(data.last_processed_ledger),
      startLedger: Number(data.start_ledger),
      updatedAt: String(data.updated_at),
    };
  }

  /**
   * Idempotently upserts indexed events.
   *
   * Conflicting on `event_identity` means a replay or an overlapping range, so
   * the existing row is left as-is rather than overwritten.
   */
  async upsertEvents(rows: readonly IndexedEventRow[]): Promise<void> {
    if (rows.length === 0) return;

    const { error } = await this.#client
      .from('indexed_events')
      .upsert([...rows], { onConflict: 'event_identity', ignoreDuplicates: true });

    if (error) {
      throw new Error(`Failed to upsert indexed events: ${error.message}`);
    }
  }

  /**
   * Persists events the decoder could not recognise, one row per event identity.
   *
   * Conflicting on `event_id` means the same range was re-read, so the existing
   * row is kept. Unlike `recordRunFailure`, this throws on failure: a rejection
   * is only durable once written, and swallowing the error would let the
   * checkpoint advance past an event that nobody can fetch again. The caller
   * retries, and the range moves on only once every rejection is on record.
   */
  async recordRejectedEvents(
    correlationId: string,
    rows: readonly RejectedEventRow[],
  ): Promise<void> {
    if (rows.length === 0) return;

    const { error } = await this.#client
      .from('indexer_rejected_events')
      .upsert(
        // Truncated: reasons are short by construction, but never unbounded.
        rows.map((row) => ({
          ...row,
          reason: row.reason.slice(0, 500),
          correlation_id: correlationId,
        })),
        { onConflict: 'event_id', ignoreDuplicates: true },
      );

    if (error) {
      throw new Error(`Failed to persist rejected events: ${error.message}`);
    }
  }

  /**
   * The group contracts the indexer already knows about.
   *
   * This is the watch list: a group's events are emitted by its own contract,
   * so without these the indexer would see only the Factory. The set grows with
   * every group deployed. Pages through groups in batches using .range() so lists
   * larger than PostgREST's max-rows cap (typically 1000) are not truncated.
   */
  async listGroupContractIds(pageSize = 1000): Promise<string[]> {
    const contractIds: string[] = [];
    let from = 0;

    while (true) {
      const to = from + pageSize - 1;
      const selectQuery = this.#client.from('groups').select('contract_id');
      const orderedQuery = typeof (selectQuery as { order?: unknown }).order === 'function'
        ? (selectQuery as { order: (col: string, opts?: unknown) => typeof selectQuery }).order(
          'contract_id',
          { ascending: true },
        )
        : selectQuery;

      const { data, error } = await orderedQuery.range(from, to);

      if (error) {
        throw new Error(`Failed to read indexed group contracts: ${error.message}`);
      }

      if (!data || data.length === 0) {
        break;
      }

      for (const row of data) {
        contractIds.push(String(row.contract_id));
      }

      if (data.length < pageSize) {
        break;
      }

      from += pageSize;
    }

    return contractIds;
  }

  /**
   * Records groups the indexer has just discovered.
   *
   * Existing rows are left alone. Discovery supplies identity and nothing else,
   * and the columns it does not set — status, member count, totals — are derived
   * state that belongs to reconciliation, not to discovery.
   */
  async upsertGroups(rows: readonly NewGroup[]): Promise<void> {
    if (rows.length === 0) return;

    const { error } = await this.#client
      .from('groups')
      .upsert([...rows], { onConflict: 'contract_id', ignoreDuplicates: true });

    if (error) {
      throw new Error(`Failed to upsert groups: ${error.message}`);
    }
  }

  /**
   * Records a run's projected events.
   *
   * Groups must already be written: every fact table refers to a group row, and
   * in the range that discovers a group, the group and its facts arrive
   * together.
   *
   * Every write ignores rows that already exist. A replay, an overlapping range
   * and a retried failure therefore all do the same thing, so the index cannot
   * be corrupted by running the same ledger twice.
   */
  async persistPlan(plan: IngestPlan): Promise<void> {
    await this.#insertIgnoringDuplicates('decoded_events', plan.decoded, 'event_identity');
    await this.#insertIgnoringDuplicates('group_members', plan.members, 'contract_id,member');
    await this.#insertIgnoringDuplicates('contributions', plan.contributions, 'event_identity');
    await this.#insertIgnoringDuplicates('payouts', plan.payouts, 'event_identity');
    await this.#insertIgnoringDuplicates('protocol_fees', plan.fees, 'event_identity');
  }

  async #insertIgnoringDuplicates(
    table: string,
    rows: readonly object[],
    onConflict: string,
  ): Promise<void> {
    if (rows.length === 0) return;

    const { error } = await this.#client
      .from(table)
      .upsert([...rows], { onConflict, ignoreDuplicates: true });

    if (error) {
      throw new Error(`Failed to record ${table}: ${error.message}`);
    }
  }

  /**
   * Reads the facts a group's state is derived from.
   *
   * Money columns are read through an explicit `::text` cast. PostgREST renders
   * `numeric` as a JSON *number*, and JavaScript loses integers above 2^53, so
   * reading one without the cast would silently round a total before any of our
   * code saw it. `sumAmounts` refuses a value that is not an integer string, so
   * dropping a cast here fails loudly rather than quietly.
   */
  async readGroupFacts(
    contractIds: readonly string[],
    pageSize = 1000,
  ): Promise<Map<string, GroupFacts>> {
    const facts = new Map<string, GroupFacts>();
    if (contractIds.length === 0) return facts;

    const ids = [...contractIds];

    const forGroup = (contractId: string): MutableFacts => {
      let existing = facts.get(contractId) as MutableFacts | undefined;
      if (existing === undefined) {
        existing = {
          members: [],
          contributions: [],
          payouts: [],
          fees: [],
          started: false,
          completed: false,
          lastEventLedger: 0,
        };
        facts.set(contractId, existing);
      }
      return existing;
    };

    const rows = await Promise.all([
      this.#selectIn('group_members', 'contract_id, position', ids, pageSize),
      this.#selectIn('contributions', 'contract_id, round, amount::text', ids, pageSize),
      this.#selectIn('payouts', 'contract_id, round, recipient_amount::text', ids, pageSize),
      this.#selectIn('protocol_fees', 'contract_id, round, fee::text', ids, pageSize),
      // Lifecycle and the last ledger the group was heard from. `start` and
      // `completed` are the only events that change its status, and both are
      // emitted by the group itself.
      this.#selectIn('decoded_events', 'contract_id, name, ledger', ids, pageSize),
    ]);

    const [members, contributions, payouts, fees, events] = rows as [
      Record<string, unknown>[],
      Record<string, unknown>[],
      Record<string, unknown>[],
      Record<string, unknown>[],
      Record<string, unknown>[],
    ];

    for (const row of members) {
      forGroup(String(row['contract_id'])).members.push({ position: Number(row['position']) });
    }
    for (const row of contributions) {
      forGroup(String(row['contract_id'])).contributions.push({
        round: Number(row['round']),
        amount: String(row['amount']),
      });
    }
    for (const row of payouts) {
      forGroup(String(row['contract_id'])).payouts.push({
        round: Number(row['round']),
        recipient_amount: String(row['recipient_amount']),
      });
    }
    for (const row of fees) {
      forGroup(String(row['contract_id'])).fees.push({
        round: Number(row['round']),
        fee: String(row['fee']),
      });
    }
    for (const row of events) {
      const group = forGroup(String(row['contract_id']));
      const name = String(row['name']);
      const ledger = Number(row['ledger']);

      if (name === 'start') group.started = true;
      if (name === 'completed') group.completed = true;
      if (ledger > group.lastEventLedger) group.lastEventLedger = ledger;
    }

    return facts;
  }

  /**
   * Derives each group's state with one Postgres aggregation per group.
   *
   * This is the bounded-cost replacement for `readGroupFacts` + `deriveGroupState`
   * in the reconcile path: the `derive_group_state` RPC returns one row per
   * requested contract, however many fact rows sit behind it, so reconcile work
   * stays bounded by the groups touched rather than growing with their lifetime
   * histories. The aggregates mirror `deriveGroupState` field for field — the
   * equivalence test in `tests/` pins that — including `COALESCE` to the same
   * zero values an empty fact set derives to.
   *
   * Wide integers cross PostgREST as `text`, for the same reason the fact
   * readers cast money columns: PostgREST renders `numeric` and `bigint` as
   * JSON numbers and JavaScript would silently round past 2^53. The inputs are
   * already `numeric(39,0)` in Postgres, so no string-shape validation is
   * needed the way `sumAmounts` does it for JSON input; the `::text` casts in
   * the function are the exactness guarantee here.
   */
  async readDerivedGroupState(contractIds: readonly string[]): Promise<GroupState[]> {
    if (contractIds.length === 0) return [];

    const { data, error } = await this.#client.rpc('derive_group_state', {
      p_contract_ids: [...contractIds],
    });

    if (error) {
      throw new Error(`Failed to derive group state: ${error.message}`);
    }

    return ((data ?? []) as Record<string, unknown>[]).map((row) => ({
      contract_id: String(row['contract_id']),
      // `completed` outranks `start`: same precedence as `deriveGroupState`.
      status: (row['completed'] ? 'completed' : row['started'] ? 'active' : 'open') as GroupState[
        'status'
      ],
      member_count: Number(row['member_count']),
      current_round: Number(row['current_round']),
      completed_rounds: Number(row['completed_rounds']),
      contributed_total: String(row['contributed_total']),
      paid_out_total: String(row['paid_out_total']),
      fee_total: String(row['fee_total']),
      last_event_ledger: Number(row['last_event_ledger']),
    }));
  }

  /** Reads the derived state currently stored for the given groups. */
  async readGroupState(
    contractIds: readonly string[],
    pageSize = 1000,
  ): Promise<Map<string, StoredGroupState>> {
    const states = new Map<string, StoredGroupState>();
    if (contractIds.length === 0) return states;

    const rows = await this.#selectIn(
      'groups',
      'contract_id, status, member_count, current_round, completed_rounds, ' +
        'contributed_total::text, paid_out_total::text, fee_total::text, last_event_ledger',
      contractIds,
      pageSize,
    );

    for (const row of rows) {
      states.set(String(row['contract_id']), {
        status: String(row['status']) as StoredGroupState['status'],
        member_count: Number(row['member_count']),
        current_round: Number(row['current_round']),
        completed_rounds: Number(row['completed_rounds']),
        contributed_total: String(row['contributed_total']),
        paid_out_total: String(row['paid_out_total']),
        fee_total: String(row['fee_total']),
        last_event_ledger: Number(row['last_event_ledger']),
      });
    }

    return states;
  }

  /**
   * Writes derived state over the stored figures in a single bulk operation.
   *
   * An UPDATE, not an upsert, because Postgres evaluates `NOT NULL` constraints
   * on the proposed tuple before `ON CONFLICT` resolution, and `groups` carries
   * immutable identity columns (`factory_contract_id`, etc.) that reconciliation
   * neither knows nor touches.
   *
   * Updates all groups in a single round trip via the `bulk_update_group_state`
   * database function. Reconciling a group with no corresponding `groups` row
   * fails loudly, matching the zero-rows-updated check.
   */
  async upsertGroupState(states: readonly GroupState[]): Promise<void> {
    if (states.length === 0) return;
    const updatedAt = new Date().toISOString();

    const { data, error } = await this.#client.rpc('bulk_update_group_state', {
      p_states: states.map((s) => ({
        contract_id: s.contract_id,
        status: s.status,
        member_count: s.member_count,
        current_round: s.current_round,
        completed_rounds: s.completed_rounds,
        contributed_total: s.contributed_total,
        paid_out_total: s.paid_out_total,
        fee_total: s.fee_total,
        last_event_ledger: s.last_event_ledger,
        updated_at: updatedAt,
      })),
    });

    if (error) {
      throw new Error(`Failed to record group state: ${error.message}`);
    }

    const updatedIds = new Set(
      ((data ?? []) as Array<Record<string, unknown>>).map((r) => String(r['contract_id'])),
    );

    for (const state of states) {
      if (!updatedIds.has(state.contract_id)) {
        throw new Error(
          `Failed to record group state: no groups row for ${state.contract_id}. ` +
            'Reconciliation updates existing groups; it never creates them.',
        );
      }
    }
  }

  async #selectIn(
    table: string,
    columns: string,
    contractIds: readonly string[],
    pageSize = 1000,
  ): Promise<Record<string, unknown>[]> {
    if (contractIds.length === 0) return [];
    if (pageSize <= 0) {
      throw new Error(`pageSize must be positive, got ${pageSize}`);
    }

    const CONTRACT_CHUNK_SIZE = 100;
    const allRows: Record<string, unknown>[] = [];

    for (let c = 0; c < contractIds.length; c += CONTRACT_CHUNK_SIZE) {
      const chunk = contractIds.slice(c, c + CONTRACT_CHUNK_SIZE);
      let from = 0;

      while (true) {
        const to = from + pageSize - 1;
        const selectQuery = this.#client
          .from(table)
          .select(columns)
          .in('contract_id', chunk);

        const pagedQuery = typeof (selectQuery as { range?: unknown }).range === 'function'
          ? (selectQuery as { range: (from: number, to: number) => typeof selectQuery }).range(
            from,
            to,
          )
          : selectQuery;

        const { data, error } = await pagedQuery;

        if (error) {
          throw new Error(`Failed to read ${table}: ${error.message}`);
        }

        const rows = (data ?? []) as unknown as Record<string, unknown>[];
        for (const row of rows) {
          allRows.push(row);
        }

        if (typeof (selectQuery as { range?: unknown }).range !== 'function') {
          if (rows.length >= pageSize) {
            throw new Error(
              `Failed to read ${table}: returned ${rows.length} rows at server cap without pagination support`,
            );
          }
          break;
        }

        if (rows.length < pageSize) {
          break;
        }

        from += pageSize;
      }
    }

    // The column list is dynamic, so the client's inferred row type is not
    // usable here. Callers coerce each field they read.
    return allRows;
  }

  /**
   * Advances the checkpoint.
   *
   * Guards against regression in the database as well as in code: the update
   * only applies when the new ledger is strictly greater, so concurrent runs
   * cannot move the checkpoint backwards.
   *
   * The observed chain tip travels with the checkpoint because the lag alert
   * (`check_indexer_health`) compares the two. A run that indexed nothing
   * still observed the tip, so callers pass it here too rather than leaving
   * the comparison to go stale.
   */
  async advanceCheckpoint(params: {
    lastProcessedLedger: number;
    startLedger: number;
    lastSeenLatestLedger?: number;
  }): Promise<void> {
    const { data, error } = await this.#client
      .from('indexer_checkpoints')
      .update({
        last_processed_ledger: params.lastProcessedLedger,
        start_ledger: params.startLedger,
        updated_at: new Date().toISOString(),
      })
      .eq('id', 'default')
      .lt('last_processed_ledger', params.lastProcessedLedger)
      .select('id');

    if (error) {
      throw new Error(`Failed to advance indexer checkpoint: ${error.message}`);
    }

    if (data && data.length > 0) {
      return;
    }

    // When no row was updated, either no checkpoint row exists yet (initial run),
    // or an existing checkpoint already has a greater or equal last_processed_ledger.
    // Insert if absent; ignoreDuplicates ensures this is a no-op if a row already exists.
    const { error: insertError } = await this.#client
      .from('indexer_checkpoints')
      .upsert(
        {
          id: 'default',
          last_processed_ledger: params.lastProcessedLedger,
          start_ledger: params.startLedger,
          updated_at: new Date().toISOString(),
          ...(params.lastSeenLatestLedger !== undefined
            ? { last_seen_latest_ledger: params.lastSeenLatestLedger }
            : {}),
        },
        { onConflict: 'id', ignoreDuplicates: true },
      );

    if (insertError) {
      throw new Error(`Failed to advance indexer checkpoint: ${insertError.message}`);
    }

    // In case a concurrent initial run inserted a lower ledger between our update
    // and upsert, re-run conditional update to guarantee the higher ledger wins.
    const { error: recheckError } = await this.#client
      .from('indexer_checkpoints')
      .update({
        last_processed_ledger: params.lastProcessedLedger,
        start_ledger: params.startLedger,
        updated_at: new Date().toISOString(),
      })
      .eq('id', 'default')
      .lt('last_processed_ledger', params.lastProcessedLedger);

    if (recheckError) {
      throw new Error(`Failed to advance indexer checkpoint: ${recheckError.message}`);
    }
  }

  /**
   * Records the chain tip observed by a run that indexed nothing.
   *
   * The checkpoint row is the lag alert's input, and a skipped run still
   * observed the tip — without this write, `last_seen_latest_ledger` would
   * freeze at the last indexing run and the lag comparison would go stale
   * exactly when the indexer looks idle but healthy.
   *
   * A plain update, not an upsert: with no checkpoint row yet there is no lag
   * to measure (the stale_checkpoint "never ran" condition owns that case),
   * and inventing `last_processed_ledger`/`start_ledger` values here would be
   * worse than writing nothing.
   */
  async recordLatestLedger(latestLedger: number): Promise<void> {
    const { error } = await this.#client
      .from('indexer_checkpoints')
      .update({
        last_seen_latest_ledger: latestLedger,
        updated_at: new Date().toISOString(),
      })
      .eq('id', 'default');

    if (error) {
      throw new Error(`Failed to record latest ledger: ${error.message}`);
    }
  }

  /** Records a failed run for operational visibility. Never throws. */
  async recordRunFailure(params: {
    correlationId: string;
    ledgerFrom: number;
    ledgerTo: number;
    reason: string;
  }): Promise<void> {
    try {
      const { error } = await this.#client.from('indexer_runs').insert({
        correlation_id: params.correlationId,
        ledger_from: params.ledgerFrom,
        ledger_to: params.ledgerTo,
        status: 'failed',
        // Truncated: error text can be long, and never contains secrets by construction.
        reason: params.reason.slice(0, 500),
      });

      if (error) {
        console.error(
          JSON.stringify({
            level: 'error',
            message: 'Failed to record indexer run failure',
            correlationId: params.correlationId,
            error: error.message,
          }),
        );
      }
    } catch (err) {
      console.error(
        JSON.stringify({
          level: 'error',
          message: 'Exception recording indexer run failure',
          correlationId: params.correlationId,
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    }
  }
}
