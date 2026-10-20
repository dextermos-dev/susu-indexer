<img src="assets/wireframe-mesh.svg" alt="Abstract dark wireframe mesh: glowing connected nodes over a perspective grid" width="100%" />

# Susu Protocol — Indexer

[![CI](https://github.com/susu-labs/susu-indexer/actions/workflows/ci.yml/badge.svg)](https://github.com/susu-labs/susu-indexer/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Status: Testnet · reviewed](https://img.shields.io/badge/status-testnet%20%C2%B7%20reviewed-orange.svg)](#project-status)
[![Mainnet: readiness implemented · deployment gated](https://img.shields.io/badge/mainnet-readiness%20implemented%20%C2%B7%20deployment%20gated-yellow.svg)](#project-status)

A scheduled blockchain indexer for **Susu Protocol**. It reads Soroban contract events, records them
idempotently in PostgreSQL, and maintains a resumable checkpoint.

It is a **reader of the chain and a writer to index tables** — never a financial authority, and it
can be deleted and rebuilt from history without affecting a single balance.

> **Reviewed by the maintainer, and not independently audited.** It is deployed to Testnet, where
> the balances are worthless. Mainnet readiness is implemented and mechanically verified, but
> deployment is deliberately gated until the attestations are satisfied. Read
> [Project status](#project-status) before you read anything else.

---

## The system

Susu is four repositories. This one makes the chain queryable.

| Repository                                                      | Responsibility                                                         | Runs on                     |
| --------------------------------------------------------------- | ---------------------------------------------------------------------- | --------------------------- |
| [`susu-contracts`](https://github.com/susu-labs/susu-contracts) | Soroban contracts. The financial authority.                            | **Testnet**                 |
| **`susu-indexer`** _(you are here)_                             | Reads chain events, records them in Postgres on a schedule.            | **Testnet** (Supabase Cron) |
| [`susu-api`](https://github.com/susu-labs/susu-api)             | Read model, accounts, invites, notifications, transaction preparation. | Local                       |
| [`susu-web`](https://github.com/susu-labs/susu-web)             | The client.                                                            | Local                       |

The index is a **rebuildable cache**. If it disagrees with the chain, the chain wins and this
service is wrong.

## Project status

**Testnet. Reviewed by the maintainer. Mainnet readiness implemented — deployment gated on
attestations.**

All twelve planned build phases are implemented. This function is deployed to Supabase and invoked
by `pg_cron` on a fixed schedule; the checkpoint advances on schedule, and a health check runs under
its own cron job and raises an alert when progress stalls.

Deployment surfaced three faults that no stubbed test could reach — the RPC's
five-contracts-per-filter limit, a reconciliation upsert that Postgres rejects before it resolves
the conflict, and an age-out window that makes a stale checkpoint unrecoverable. All three are
fixed, and all three are the kind of bug that only appears against a real RPC.

The retry path is covered by automated endpoint-level failure-injection tests
(`tests/indexer_orchestration_test.ts`), verifying transient and permanent recovery for both RPC and
database failures.

Two gates stand between this and Mainnet. The machinery for both is written; neither is satisfied:

| Gate                            | State                                                                                                                                                                                                                       |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Independent security review** | **Not commissioned. The maintainer has reviewed this code, which is a different claim.** See [`susu-contracts/docs/AUDIT_SCOPE.md`](https://github.com/susu-labs/susu-contracts/blob/main/docs/AUDIT_SCOPE.md).             |
| **Mainnet readiness**           | **Implemented and mechanically verified; `NO-GO` until the attestations are satisfied.** See [`susu-contracts/docs/MAINNET_READINESS.md`](https://github.com/susu-labs/susu-contracts/blob/main/docs/MAINNET_READINESS.md). |

## Contents

- [What it is not](#what-it-is-not)
- [Why these design choices](#why-these-design-choices)
- [Layout](#layout)
- [Money](#money)
- [Database security](#database-security)
- [Development](#development)
- [Deploying](#deploying)
- [Operations](#operations)
- [Documentation](#documentation)
- [Contributing](#contributing)
- [Security](#security)
- [License](#license)

## What it is not

The indexer is a **reader** of chain state and a **writer** to index tables. It is **not** a
financial authority:

- It never decides balances, payout recipients, eligibility, or authorization.
- It never signs or submits transactions.
- It cannot move funds.
- If index state ever conflicts with chain state, **the chain wins** and reconciliation repairs the
  index.

## Why these design choices

### Factory + separate Group contract

Each Susu group controls its own pool in its own contract. The indexer therefore watches the Factory
for group creation and follows each group's events, rather than assuming a single shared contract
holds all state.

### Supabase Cron + Edge Function, not a paid worker

The MVP must not depend on a paid always-on background worker. Supabase Cron invokes this Edge
Function on a schedule. This is safe because runs are **idempotent and resumable**:

- Events are keyed by a chain-derived identity (`contractId:ledger:txHash:eventIndex`) with a unique
  constraint, so replays and overlapping ranges never duplicate rows.
- The checkpoint only advances **forward**, and only **after** writes succeed — so a failed or
  missed run retries the same range instead of skipping ledgers.
- A run that is already caught up exits without writing.

A dedicated always-on worker is a later production optimization, not an MVP requirement.

### Bounded runs

Each invocation processes at most `INDEXER_MAX_LEDGER_RANGE` ledgers and exits, so it stays within
its execution budget. Progress is durable; the next run continues where this one stopped.

### Chain-derived tables, reconciled rather than trusted

`decoded_events` and the tables below it (`groups`, `group_members`, `contributions`, `payouts`,
`protocol_fees`) are projections of chain events, not records in their own right. Every figure read
back from them — member count, round, totals — is recomputed from those rows on each run rather than
incremented, so a replayed range corrects a total instead of doubling it.

Amounts are `numeric(39,0)` in the database, because the largest `i128` is 39 digits, and `BigInt`
in the code. A read that forgets its `::text` cast fails loudly rather than rounding: PostgREST
renders `numeric` as a JSON number, and JavaScript loses integers above 2^53 without saying so.

The chain remains the authority. A group's events are emitted by an address nobody knows in advance,
so the indexer learns it from the Factory's `group_created` event and reads that ledger range a
second time for it — the checkpoint only moves forward, and a group created and used inside one
range would otherwise be skipped permanently.

## Layout

```text
supabase/
  functions/
    indexer/index.ts        # scheduled entrypoint
    _shared/
      auth.ts               # constant-time invocation authorisation
      checkpoint.ts         # ledger ranges, checkpoint advancement, lag
      config.ts             # environment validation
      db.ts                 # index tables, chain-derived tables, checkpoints
      decode.ts             # XDR event decoding, strictly validated
      discovery.ts          # finds group contracts from factory events
      events.ts             # event identity, ordering, deduplication
      ingest.ts             # decoded events -> chain-derived rows
      logger.ts             # structured logging with recursive redaction
      money.ts              # integer-only fee/recipient verification
      retry.ts              # bounded exponential backoff
      scan.ts               # reads a ledger range in full, by cursor
      state.ts              # derives group state from recorded facts
      stellar.ts            # minimal read-only Soroban RPC client
  migrations/               # schema, RLS, grants, alerts
scripts/
  schedule-indexer.sql      # cron schedule (reads its secret from Vault)
tests/                      # Deno tests
```

## Money

`money.ts` performs **verification only** — it never decides an amount. All arithmetic is integer
(`bigint`) stroops; floating point is never used for money.

```text
fee              = amount * fee_bps / 10_000     (integer division, truncated)
recipient_amount = amount - fee
fee_bps          = 50
fee + recipient_amount == pool
```

The canonical check is 3 members × 10 USDC = 30 USDC → fee 0.15 USDC, recipient 29.85 USDC.

## Database security

Index tables are **server-owned**. RLS is enabled with no policies (deny by default), and
`anon`/`authenticated` privileges are explicitly revoked. Only the service role — used exclusively
by this function — can access them. RLS is never a substitute for grants, so both are enforced, and
CI verifies both, including that browser roles hold no table privileges at all.

The cron schedule reads its secret from **Vault** at call time, so no credential is written into the
migration, into `cron.job`, or into source control.

## Development

Requires Deno and the Supabase CLI.

```bash
cp .env.example .env
deno task check
deno task lint
deno task test
```

## Deploying

`scripts/deploy-indexer.sh` deploys the function and records its configuration in one idempotent
step, so it is also how a change ships. It needs a personal access token (`sbp_…`) from
[Account → Access Tokens](https://supabase.com/dashboard/account/tokens) — not the anon or
service-role key, which are project-scoped and cannot deploy anything.

```bash
export SUPABASE_ACCESS_TOKEN=sbp_...
export SUPABASE_PROJECT_REF=...
export INDEXER_TASK_SECRET=$(openssl rand -hex 32)
export FACTORY_CONTRACT_ID=C...
export TOKEN_CONTRACT_ID=C...
export INDEXER_START_LEDGER=...
./scripts/deploy-indexer.sh
```

Two steps the script cannot do for you, both needing database access, are printed when it finishes:
storing the invocation secret in Vault, and applying `scripts/schedule-indexer.sql`.

`TOKEN_CONTRACT_ID` is the asset the groups actually transact in, and it is not always what
`.env.testnet` records. Testnet deployments built by `e2e-testnet.sh` use a self-issued test asset,
so pointing this at the real USDC SAC makes the indexer watch a contract the groups never touch —
silently, since the run still succeeds.

## Operations

- **Alerts:** `check_indexer_health()` runs under its own cron job and opens one row in
  `indexer_alerts` per condition — a stale checkpoint, a recorded failure, a rejected event, or a
  scheduled invocation that did not succeed. One alert per condition rather than one per check, so
  it does not become noise, and it resolves when the condition clears. Without a webhook stored in
  Vault the alerts are recorded but not delivered, which means the table has to be looked at — see
  [`docs/RUNBOOK.md`](docs/RUNBOOK.md#alerts-and-what-they-are-for).
- **Stale checkpoint:** check `indexer_runs` for failures, then confirm RPC reachability. Restarting
  resumes from the checkpoint automatically.
- **Full rebuild:** reset `indexer_checkpoints` to the later of the deployment ledger and the RPC's
  retention floor, then let the indexer re-scan. Event identity makes this safe. A start ledger
  below the retention floor fails every run instead of rebuilding — see `docs/RUNBOOK.md`.
- **Groups missing from the index:** a group is only learned from the Factory's `group_created`
  event inside a range that is read. If that range was processed before group discovery existed, its
  events were never read and the checkpoint has moved past them — only a rebuild re-reads them.
- **Reconciliation:** each touched group's state is recomputed from its recorded facts on every run
  and written back; divergence is logged. A difference means the index was wrong, never the chain.

See [`docs/RUNBOOK.md`](docs/RUNBOOK.md).

## Documentation

| Document                                       | What it covers                                                  |
| ---------------------------------------------- | --------------------------------------------------------------- |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | The tables, the pipeline, and where idempotency is enforced.    |
| [`docs/RUNBOOK.md`](docs/RUNBOOK.md)           | Alerts, checkpoints, rebuilds, and what to do when a run fails. |

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md) and the [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md).

## Security

Reviewed by the maintainer, not by an independent auditor. See [`SECURITY.md`](SECURITY.md) for
reporting.

## License

[MIT](LICENSE)
