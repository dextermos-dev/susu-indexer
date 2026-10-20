/**
 * Indexer configuration.
 *
 * The indexer is a **reader** of chain state and a **writer** to index tables.
 * It holds no financial authority, cannot sign transactions, and can never move
 * funds. If indexing fails or diverges, the chain remains authoritative.
 *
 * Secrets are read from the environment only and are never logged. Validation
 * returns a structured result rather than throwing, so a failed scheduled run can
 * report which variables are wrong without echoing their values.
 */

export type IndexerConfig = {
  /** Supabase project URL. */
  supabaseUrl: string;
  /** Server-only service-role key. Never exposed to a client. */
  serviceRoleKey: string;
  /** Shared secret that authorises a scheduled or manual invocation. */
  taskSecret: string;
  /** Soroban RPC endpoint. */
  rpcUrl: string;
  /** Stellar network name. Mainnet requires explicit opt-in. */
  network: 'local' | 'testnet' | 'mainnet';
  /** Stellar network passphrase, for decoding network-scoped data. */
  networkPassphrase: string;
  /** Factory contract whose events seed group discovery. */
  factoryContractId: string;
  /** USDC SAC used by groups. Recorded for reconciliation. */
  usdcContractId: string;
  /** Ledger the contracts were deployed at; where a first run begins. */
  startLedger: number;
  /** Maximum ledgers to process in a single invocation. */
  maxLedgersPerRun: number;
  /** Maximum rows per PostgREST upsert batch. */
  writeBatchSize?: number;
  /** Safety switch for Mainnet, which is out of scope for the MVP. */
  allowMainnet: boolean;
};

export type ConfigResult =
  | { ok: true; config: IndexerConfig }
  | { ok: false; missing: string[]; invalid: string[] };

const CONTRACT_ID_PATTERN = /^C[A-Z2-7]{55}$/;

function readString(env: Record<string, string | undefined>, key: string): string | undefined {
  const value = env[key];
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readPositiveInt(
  env: Record<string, string | undefined>,
  key: string,
  fallback: number,
): { value: number; valid: boolean } {
  const raw = readString(env, key);
  if (raw === undefined) return { value: fallback, valid: true };
  if (!/^\d+$/.test(raw)) return { value: fallback, valid: false };
  const value = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(value) || value <= 0) return { value: fallback, valid: false };
  return { value, valid: true };
}

/**
 * Validates configuration from the given environment.
 *
 * Returns a structured result rather than throwing, so the caller can report
 * which variables are missing without echoing their values.
 */
export function loadConfig(
  env: Record<string, string | undefined> = Deno.env.toObject(),
): ConfigResult {
  const missing: string[] = [];
  const invalid: string[] = [];

  const required = [
    'SUPABASE_URL',
    'SUPABASE_SERVICE_ROLE_KEY',
    'INDEXER_TASK_SECRET',
    'STELLAR_RPC_URL',
    'STELLAR_NETWORK_PASSPHRASE',
    'FACTORY_CONTRACT_ID',
    'USDC_CONTRACT_ID',
  ] as const;

  const values: Record<string, string> = {};
  for (const key of required) {
    const value = readString(env, key);
    if (value === undefined) {
      missing.push(key);
      continue;
    }
    values[key] = value;
  }

  if (missing.length > 0) {
    return { ok: false, missing, invalid };
  }

  const supabaseUrl = values['SUPABASE_URL'] as string;
  if (!supabaseUrl.startsWith('https://')) {
    invalid.push('SUPABASE_URL (must be an https URL)');
  }

  const taskSecret = values['INDEXER_TASK_SECRET'] as string;
  if (taskSecret.length < 32) {
    invalid.push('INDEXER_TASK_SECRET (must be at least 32 characters)');
  }

  const factoryContractId = values['FACTORY_CONTRACT_ID'] as string;
  if (!CONTRACT_ID_PATTERN.test(factoryContractId)) {
    invalid.push('FACTORY_CONTRACT_ID (must be a C... Soroban contract address)');
  }

  const usdcContractId = values['USDC_CONTRACT_ID'] as string;
  if (!CONTRACT_ID_PATTERN.test(usdcContractId)) {
    invalid.push('USDC_CONTRACT_ID (must be a C... Soroban contract address)');
  }

  const rpcUrl = values['STELLAR_RPC_URL'] as string;
  if (!rpcUrl.startsWith('https://') && !rpcUrl.startsWith('http://localhost')) {
    invalid.push('STELLAR_RPC_URL (must be an https URL, or localhost for local development)');
  }

  const allowMainnet = readString(env, 'ALLOW_MAINNET') === 'true';
  const network = (readString(env, 'STELLAR_NETWORK') ?? 'testnet') as IndexerConfig['network'];
  if (!['local', 'testnet', 'mainnet'].includes(network)) {
    invalid.push('STELLAR_NETWORK (must be local, testnet or mainnet)');
  }
  if (network === 'mainnet' && !allowMainnet) {
    invalid.push('STELLAR_NETWORK=mainnet requires ALLOW_MAINNET=true (explicit approval)');
  }

  const maxLedgers = readPositiveInt(env, 'INDEXER_MAX_LEDGER_RANGE', 1000);
  if (!maxLedgers.valid || maxLedgers.value > 100_000) {
    invalid.push('INDEXER_MAX_LEDGER_RANGE (must be an integer between 1 and 100000)');
  }

  const startLedger = readPositiveInt(env, 'INDEXER_START_LEDGER', 1);
  if (!startLedger.valid) {
    invalid.push('INDEXER_START_LEDGER (must be a positive integer)');
  }

  const writeBatchSize = readPositiveInt(env, 'INDEXER_WRITE_BATCH_SIZE', 500);
  if (!writeBatchSize.valid || writeBatchSize.value > 10_000) {
    invalid.push('INDEXER_WRITE_BATCH_SIZE (must be an integer between 1 and 10000)');
  }

  if (invalid.length > 0) {
    return { ok: false, missing, invalid };
  }

  return {
    ok: true,
    config: {
      supabaseUrl,
      serviceRoleKey: values['SUPABASE_SERVICE_ROLE_KEY'] as string,
      taskSecret,
      rpcUrl,
      network,
      networkPassphrase: values['STELLAR_NETWORK_PASSPHRASE'] as string,
      factoryContractId,
      usdcContractId,
      startLedger: startLedger.value,
      maxLedgersPerRun: maxLedgers.value,
      writeBatchSize: writeBatchSize.value,
      allowMainnet,
    },
  };
}
