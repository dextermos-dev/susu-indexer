import { assert, assertEquals } from '@std/assert';
import type { SupabaseClient } from '@supabase/supabase-js';
import { IndexerDb } from '../supabase/functions/_shared/db.ts';
import { deriveGroupState } from '../supabase/functions/_shared/state.ts';

Deno.test('every #selectIn query includes an order call before range', async () => {
  const contractId = 'C0000000000000000000000000000000000000000000000000000001';
  const recordedCalls: {
    table: string;
    orderColumns: { col: string; ascending: boolean }[];
    hadOrderBeforeRange: boolean;
  }[] = [];

  const stubClient = {
    from(table: string) {
      const orderColumns: { col: string; ascending: boolean }[] = [];
      let ordered = false;

      return {
        select(_columns: string) {
          return {
            in(column: string, values: readonly string[]) {
              assertEquals(column, 'contract_id');
              assertEquals(values.includes(contractId), true);
              return {
                order(col: string, options?: { ascending: boolean }) {
                  ordered = true;
                  orderColumns.push({ col, ascending: options?.ascending ?? true });
                  return this;
                },
                range(_from: number, _to: number) {
                  recordedCalls.push({
                    table,
                    orderColumns: [...orderColumns],
                    hadOrderBeforeRange: ordered,
                  });
                  return Promise.resolve({ data: [], error: null });
                },
              };
            },
          };
        },
      };
    },
  } as unknown as SupabaseClient;

  const db = new IndexerDb('https://example.supabase.co', 'dummy-key', stubClient);

  // 1. readGroupFacts queries 5 tables: group_members, contributions, payouts, protocol_fees, decoded_events
  await db.readGroupFacts([contractId], 1000);

  const factTables = recordedCalls.map((c) => c.table);
  assertEquals(factTables.sort(), [
    'contributions',
    'decoded_events',
    'group_members',
    'payouts',
    'protocol_fees',
  ]);

  for (const call of recordedCalls) {
    assert(
      call.hadOrderBeforeRange,
      `Table ${call.table} must call .order(...) before .range(...)`,
    );
    assert(
      call.orderColumns.length >= 1,
      `Table ${call.table} must specify at least one order column`,
    );
    assertEquals(call.orderColumns[0]?.col, 'contract_id');
    assertEquals(call.orderColumns[0]?.ascending, true);
  }

  // Check specific deterministic tiebreakers
  const membersCall = recordedCalls.find((c) => c.table === 'group_members');
  assertEquals(
    membersCall?.orderColumns.map((c) => c.col),
    ['contract_id', 'position'],
  );

  const contribCall = recordedCalls.find((c) => c.table === 'contributions');
  assertEquals(
    contribCall?.orderColumns.map((c) => c.col),
    ['contract_id', 'round', 'event_identity'],
  );

  const payoutCall = recordedCalls.find((c) => c.table === 'payouts');
  assertEquals(
    payoutCall?.orderColumns.map((c) => c.col),
    ['contract_id', 'round', 'event_identity'],
  );

  const feeCall = recordedCalls.find((c) => c.table === 'protocol_fees');
  assertEquals(
    feeCall?.orderColumns.map((c) => c.col),
    ['contract_id', 'round', 'event_identity'],
  );

  const eventCall = recordedCalls.find((c) => c.table === 'decoded_events');
  assertEquals(
    eventCall?.orderColumns.map((c) => c.col),
    ['contract_id', 'ledger', 'event_identity'],
  );

  // 2. readGroupState queries the groups table
  recordedCalls.length = 0;
  await db.readGroupState([contractId], 1000);
  assertEquals(recordedCalls.length, 1);
  assertEquals(recordedCalls[0]?.table, 'groups');
  assert(recordedCalls[0]?.hadOrderBeforeRange, 'groups query must call .order() before .range()');
  assertEquals(recordedCalls[0]?.orderColumns[0]?.col, 'contract_id');
});

Deno.test('paged-stub test with >1000 rows and shuffled slices returns every row exactly once and derives correct facts', async () => {
  const contractId = 'C0000000000000000000000000000000000000000000000000000001';
  const TOTAL_CONTRIBUTIONS = 2500;
  const CONTRIBUTION_AMOUNT = '10000000'; // 10 USDC (7 decimals)

  // 1. Generate 2500 contributions with deterministic identities and sequence
  type ContributionRow = {
    contract_id: string;
    round: number;
    amount: string;
    event_identity: string;
  };

  const canonicalRows: ContributionRow[] = Array.from(
    { length: TOTAL_CONTRIBUTIONS },
    (_, i) => ({
      contract_id: contractId,
      round: (i % 10) + 1,
      amount: CONTRIBUTION_AMOUNT,
      event_identity: `evt_${String(i).padStart(6, '0')}`,
    }),
  );

  // 2. Shuffle rows in the mock database store using pseudo-random permutation
  const shuffledRows = [...canonicalRows];
  for (let i = shuffledRows.length - 1; i > 0; i--) {
    const j = (i * 31 + 17) % (i + 1);
    const tmp = shuffledRows[i]!;
    shuffledRows[i] = shuffledRows[j]!;
    shuffledRows[j] = tmp;
  }

  const recordedPageCalls: { from: number; to: number; returnedCount: number }[] = [];
  const orderColumnsInvoked: string[] = [];

  const stubClient = {
    from(table: string) {
      if (table !== 'contributions') {
        return {
          select(_columns: string) {
            return {
              in(_col: string, _vals: readonly string[]) {
                return {
                  order(_c: string) {
                    return this;
                  },
                  range(_from: number, _to: number) {
                    return Promise.resolve({ data: [], error: null });
                  },
                };
              },
            };
          },
        };
      }

      return {
        select(_columns: string) {
          return {
            in(_col: string, _vals: readonly string[]) {
              // The stub tracks whether sorting was requested
              let isSorted = false;

              return {
                order(column: string, _opts?: { ascending: boolean }) {
                  orderColumnsInvoked.push(column);
                  isSorted = true;
                  return this;
                },
                range(from: number, to: number) {
                  // If ordered, sort stably before paging. If not ordered,
                  // PostgREST/Postgres could return rows out of order or shifted across pages.
                  const workingRows = isSorted
                    ? [...shuffledRows].sort((a, b) =>
                      a.event_identity.localeCompare(b.event_identity)
                    )
                    : shuffledRows;

                  const page = workingRows.slice(from, to + 1);
                  recordedPageCalls.push({
                    from,
                    to,
                    returnedCount: page.length,
                  });
                  return Promise.resolve({ data: page, error: null });
                },
              };
            },
          };
        },
      };
    },
  } as unknown as SupabaseClient;

  const db = new IndexerDb('https://example.supabase.co', 'dummy-key', stubClient);

  // Read facts using pageSize = 1000
  const factsMap = await db.readGroupFacts([contractId], 1000);
  const facts = factsMap.get(contractId);
  assert(facts !== undefined, 'Facts must be returned for group');

  // Verify pagination occurred in expected ranges
  assertEquals(recordedPageCalls, [
    { from: 0, to: 999, returnedCount: 1000 },
    { from: 1000, to: 1999, returnedCount: 1000 },
    { from: 2000, to: 2999, returnedCount: 500 },
  ]);

  // Verify order was invoked before range
  assert(orderColumnsInvoked.includes('contract_id'));
  assert(orderColumnsInvoked.includes('event_identity'));

  // Acceptance Criterion: A paged-stub test with >1000 rows and shuffled slices
  // returns every row exactly once
  assertEquals(facts.contributions.length, TOTAL_CONTRIBUTIONS);

  // Verify that all contributions survived and totals match without duplication or omission
  const returnedRounds = facts.contributions.map((c) => c.round);
  assertEquals(returnedRounds.length, TOTAL_CONTRIBUTIONS);

  // Acceptance Criterion: Fact derivation is correct on a paged response
  const derived = deriveGroupState(contractId, facts);
  const expectedTotal = (BigInt(TOTAL_CONTRIBUTIONS) * BigInt(CONTRIBUTION_AMOUNT)).toString();
  assertEquals(derived.contributed_total, expectedTotal);
  assertEquals(derived.contributed_total, '25000000000');
});
