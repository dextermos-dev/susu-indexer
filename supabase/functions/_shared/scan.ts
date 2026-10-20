/**
 * Reading a ledger range in full.
 *
 * The checkpoint only moves forward, so a range that is read incompletely is
 * never read again: whatever the missing events said about money moving is lost
 * for good. This module exists so that "read in full" is a property that can be
 * tested, rather than an assumption about how the RPC pages.
 *
 * The RPC addresses events in two mutually exclusive ways — a ledger range,
 * which bounds the scan, and a cursor, which continues it. Sending both is an
 * error (`-32602: ledger ranges and cursor cannot both be set`), so only the
 * first request of a scan carries a range and every later one carries the
 * cursor from the previous response.
 *
 * An earlier implementation instead advanced the next request's `startLedger`
 * to the highest ledger seen in the previous page. That loses events whenever a
 * page is filled entirely by a single ledger — the ledger's remaining events sit
 * after the page boundary, and the next request starts *past* them — and it
 * re-reads the boundary ledger in every other case. The cursor has neither
 * problem, which is what it is for.
 */

import { type RetryOptions, withRetry } from './retry.ts';
import type { EventPageStart, GetEventsResult, RpcEvent } from './stellar.ts';

/** Events requested per page. */
export const PAGE_LIMIT = 100;

/**
 * Most contract IDs the RPC accepts in one filter.
 *
 * A hard server-side limit, enforced with `-32602: filter 1 invalid: maximum 5
 * contract IDs per filter`. It is not a documented budget to plan against but an
 * error to avoid, which is why the scan splits its watch list rather than
 * assuming the list stays small. Beyond five groups in one ledger range the
 * second discovery pass sends one ID per group, so a protocol with six groups
 * fails every run until this is respected.
 */
export const MAX_CONTRACT_IDS_PER_FILTER = 5;

/**
 * Hard cap on pages fetched for one range.
 *
 * The cursor is the loop's own condition, so a cursor that stopped advancing
 * would spin forever. This is far above any real range at the protocol's
 * current size, and exists to turn an unbounded loop into a loud failure.
 */
export const MAX_PAGES = 1_000;

/** Bounded retry policy for transient RPC failures during a scan. */
const RETRY = { attempts: 4, baseDelayMs: 250, maxDelayMs: 4_000 } as const;

/**
 * The slice of the RPC client a scan needs.
 *
 * Narrowing to this makes the paging logic testable without a network stub, and
 * keeps the scan honest about the fact that it only ever reads.
 */
export type EventSource = {
  getEvents(
    params: EventPageStart & { contractIds: string[]; limit?: number },
  ): Promise<GetEventsResult>;
};

/**
 * Fetches every event emitted by `contractIds` in the ledger range `from`..`to`
 * (inclusive at both ends).
 *
 * The watch list is split into filters the RPC will accept, and each is scanned
 * to completion. Splitting is not an optimisation: the RPC rejects a filter
 * carrying more than five contract IDs outright, so a watch list that outgrows
 * one filter would otherwise fail every run rather than degrade.
 *
 * Each contract appears in exactly one chunk, so an event is returned once and
 * the caller's ordering is all that remains to restore. The chunks are read one
 * after another rather than concurrently: the RPC is a shared public endpoint,
 * and a dozen parallel scans are a good way to be rate limited part-way through
 * a range that then cannot be advanced.
 *
 * Throws rather than returning a partial result whenever it cannot prove the
 * range was read in full. A partial result would be recorded and the checkpoint
 * advanced past it, which is indistinguishable from the events never existing.
 */
export async function fetchRangeEvents(
  rpc: EventSource,
  contractIds: readonly string[],
  from: number,
  to: number,
  retryOptions?: Partial<RetryOptions>,
): Promise<RpcEvent[]> {
  if (contractIds.length === 0) return [];
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from > to) {
    throw new Error(`invalid ledger range: ${from}-${to}`);
  }

  // De-duplicated first: a repeated ID would consume one of the five slots to
  // fetch the same events twice.
  const unique = [...new Set(contractIds)];
  const chunks: string[][] = [];
  for (let i = 0; i < unique.length; i += MAX_CONTRACT_IDS_PER_FILTER) {
    chunks.push(unique.slice(i, i + MAX_CONTRACT_IDS_PER_FILTER));
  }

  const collected: RpcEvent[] = [];
  for (const chunk of chunks) {
    collected.push(...(await fetchChunk(rpc, chunk, from, to, retryOptions)));
  }

  return collected;
}

/** Reads the whole range for one filter's worth of contracts. */
async function fetchChunk(
  rpc: EventSource,
  ids: string[],
  from: number,
  to: number,
  retryOptions?: Partial<RetryOptions>,
): Promise<RpcEvent[]> {
  const retryPolicy: RetryOptions = {
    ...RETRY,
    ...retryOptions,
  };

  const fetchPage = (start: EventPageStart): Promise<GetEventsResult> =>
    withRetry(
      () => rpc.getEvents({ ...start, contractIds: ids, limit: PAGE_LIMIT }),
      retryPolicy,
    );

  const collected: RpcEvent[] = [];
  let previousCursor: string | undefined;

  // `endLedger` is exclusive; verified against the RPC, which returns an event
  // at ledger N for endLedger N+1 and none for endLedger N.
  let page = await fetchPage({ kind: 'range', startLedger: from, endLedger: to + 1 });

  for (let pages = 1;; pages++) {
    if (pages > MAX_PAGES) {
      throw new Error(`gave up paging after ${MAX_PAGES} pages for ledgers ${from}-${to}`);
    }

    if (page.events.length === 0) break;

    // A cursor page carries no ledger bound, so its tail can run past the range.
    // Events are ordered by ledger, so the first one beyond `to` ends the scan.
    const inRange = page.events.filter((event) => event.ledger <= to);
    collected.push(...inRange);
    if (inRange.length < page.events.length) break;

    // A short page means the range is exhausted.
    if (page.events.length < PAGE_LIMIT) break;

    // A full page means more may follow, and without a cursor we cannot show
    // that we reached the end. Stopping here would truncate the range silently,
    // which is the one failure this function exists to prevent.
    if (page.cursor === undefined) {
      throw new Error(
        `RPC returned a full page with no cursor for ledgers ${from}-${to}; ` +
          `cannot prove the range was read in full`,
      );
    }
    if (page.cursor === previousCursor) {
      throw new Error(`RPC cursor stopped advancing at ${page.cursor} for ledgers ${from}-${to}`);
    }

    previousCursor = page.cursor;
    page = await fetchPage({ kind: 'cursor', cursor: previousCursor });
  }

  return collected;
}
