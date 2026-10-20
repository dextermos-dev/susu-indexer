#!/usr/bin/env bash
#
# Deploy the indexer Edge Function and record its configuration.
#
# Idempotent: re-running redeploys the same code and re-sets the same secrets, so
# it is also the procedure for shipping a change.
#
# NO SECRET IS EVER PASSED AS A COMMAND ARGUMENT. On macOS and Linux an
# argument is readable by any process that can read `ps`, so a value handed to
# `supabase` that way is exposed for the lifetime of the call. Secrets travel
# through the environment or through 0600 files that are removed on exit. For the
# same reason this script prints variable NAMES and never values.
#
# Usage:
#   export SUPABASE_ACCESS_TOKEN=sbp_...        # personal access token
#   export SUPABASE_PROJECT_REF=...             # project ref, not a URL
#   export INDEXER_TASK_SECRET=$(openssl rand -hex 32)
#   export FACTORY_CONTRACT_ID=C...
#   export TOKEN_CONTRACT_ID=C...               # the asset the groups actually use
#   export INDEXER_START_LEDGER=...
#   ./scripts/deploy-indexer.sh
#
# Required environment:
#   SUPABASE_ACCESS_TOKEN   Personal access token (sbp_...). Never committed.
#   SUPABASE_PROJECT_REF    Project ref, e.g. abcdefghijklmnopqrst.
#   INDEXER_TASK_SECRET     Shared secret authorising invocations, >= 32 chars.
#   FACTORY_CONTRACT_ID     Factory contract whose events seed discovery.
#   TOKEN_CONTRACT_ID       Token contract the groups transact in.
#   INDEXER_START_LEDGER    Ledger a first run begins at. Must be within the
#                           RPC's retention window, or every run fails.
#
# Optional environment:
#   STELLAR_RPC_URL             Defaults to the public Testnet endpoint.
#   STELLAR_NETWORK             local | testnet | mainnet. Defaults to testnet.
#   STELLAR_NETWORK_PASSPHRASE  Must match STELLAR_NETWORK.
#   INDEXER_MAX_LEDGER_RANGE    Ledgers per run. Defaults to 1000.
#
# Note: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided by the platform
# and must not be set here. Setting them would shadow the managed values.

set -euo pipefail

readonly FUNCTION_NAME='indexer'
readonly CONTRACT_ID_PATTERN='^C[A-Z2-7]{55}$'

fail() {
  printf 'error: %s\n' "$1" >&2
  exit 1
}

require() {
  local name="$1"
  if [ -z "${!name:-}" ]; then
    fail "$name is not set"
  fi
}

# Prints which variables are set without revealing any of them. A CI log showing
# which secrets were provided is useful; a CI log showing their values is a leak.
report() {
  local name="$1"
  if [ -n "${!name:-}" ]; then
    printf '  %s: set\n' "$name"
  else
    printf '  %s: (not set)\n' "$name"
  fi
}

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

printf '==> Checking configuration\n'
require SUPABASE_ACCESS_TOKEN
require SUPABASE_PROJECT_REF
require INDEXER_TASK_SECRET
require FACTORY_CONTRACT_ID
require TOKEN_CONTRACT_ID
require INDEXER_START_LEDGER

if [ "${#INDEXER_TASK_SECRET}" -lt 32 ]; then
  fail 'INDEXER_TASK_SECRET must be at least 32 characters'
fi
if ! [[ "$FACTORY_CONTRACT_ID" =~ $CONTRACT_ID_PATTERN ]]; then
  fail 'FACTORY_CONTRACT_ID must be a C... Soroban contract address'
fi
if ! [[ "$TOKEN_CONTRACT_ID" =~ $CONTRACT_ID_PATTERN ]]; then
  fail 'TOKEN_CONTRACT_ID must be a C... Soroban contract address'
fi
if ! [[ "$INDEXER_START_LEDGER" =~ ^[0-9]+$ ]] || [ "$INDEXER_START_LEDGER" -le 0 ]; then
  fail 'INDEXER_START_LEDGER must be a positive integer'
fi

report SUPABASE_ACCESS_TOKEN
report SUPABASE_PROJECT_REF
report INDEXER_TASK_SECRET
report FACTORY_CONTRACT_ID
report TOKEN_CONTRACT_ID
report INDEXER_START_LEDGER

# The import map is not optional. The function imports `@supabase/supabase-js`
# and `@stellar/stellar-sdk` by bare specifier, and the Edge runtime resolves
# those from this map. Without it the deploy fails to resolve the imports.
readonly IMPORT_MAP='supabase/functions/import_map.json'
if [ ! -f "$IMPORT_MAP" ]; then
  fail "missing $IMPORT_MAP, which the function's bare imports depend on"
fi

printf '\n==> Deploying %s (bundled server-side; no Docker required)\n' "$FUNCTION_NAME"
# --no-verify-jwt: the platform's JWT check is dropped because invocation is
#   authorised by the shared secret instead. Supabase Cron calls this function
#   without a user JWT, so leaving the check on would reject every scheduled run.
# --use-api: bundles in the cloud rather than locally.
supabase functions deploy "$FUNCTION_NAME" \
  --project-ref "$SUPABASE_PROJECT_REF" \
  --import-map "$IMPORT_MAP" \
  --no-verify-jwt \
  --use-api

printf '\n==> Setting function secrets\n'
# Values are read from a file rather than passed as `NAME=value` arguments. An
# argument is visible to any process that can read `ps`, which is exactly the
# kind of incidental exposure a secret should not have. The file is written 0600
# and removed on exit, including on failure.
#
# SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are deliberately absent: the
# platform injects them, and setting them here would shadow the managed values
# with stale copies.
secrets_file="$(mktemp)"
chmod 600 "$secrets_file"
trap 'rm -f "$secrets_file"' EXIT

{
  printf 'INDEXER_TASK_SECRET=%s\n' "$INDEXER_TASK_SECRET"
  printf 'FACTORY_CONTRACT_ID=%s\n' "$FACTORY_CONTRACT_ID"
  printf 'USDC_CONTRACT_ID=%s\n' "$TOKEN_CONTRACT_ID"
  printf 'INDEXER_START_LEDGER=%s\n' "$INDEXER_START_LEDGER"
  printf 'STELLAR_RPC_URL=%s\n' "${STELLAR_RPC_URL:-https://soroban-testnet.stellar.org}"
  printf 'STELLAR_NETWORK=%s\n' "${STELLAR_NETWORK:-testnet}"
  printf 'STELLAR_NETWORK_PASSPHRASE=%s\n' \
    "${STELLAR_NETWORK_PASSPHRASE:-Test SDF Network ; September 2015}"
  printf 'INDEXER_MAX_LEDGER_RANGE=%s\n' "${INDEXER_MAX_LEDGER_RANGE:-1000}"
  printf 'ALLOW_MAINNET=%s\n' "${ALLOW_MAINNET:-false}"
} >"$secrets_file"

supabase secrets set \
  --project-ref "$SUPABASE_PROJECT_REF" \
  --env-file "$secrets_file"

printf '\n==> Deployed.\n\n'
cat <<'NEXT'
Remaining steps, both of which need database access:

  1. Store the invocation secret in Vault, so the cron job can read it without it
     being written into cron.job or source control. Run once, as the postgres role:

       select vault.create_secret('<the-indexer-task-secret>', 'indexer_task_secret',
                                  'Authorises scheduled indexer invocations');
       select vault.create_secret('https://<project-ref>.supabase.co', 'project_url',
                                  'Supabase project URL');

     The secret must equal INDEXER_TASK_SECRET above. If it does not, scheduled
     runs will be rejected and the checkpoint will stop advancing.

  2. Apply scripts/schedule-indexer.sql, which enables pg_cron and pg_net and
     schedules the run every 5 minutes.

Then confirm the first scheduled run succeeded:

  select * from indexer_runs order by created_at desc limit 5;
  select * from indexer_checkpoints;

A run that fails leaves the checkpoint untouched, so the range is retried rather
than skipped. See docs/RUNBOOK.md for what each failure reason means.
NEXT
