
import Database from 'better-sqlite3';

export type UltibotConfig = {
  enabled: boolean;
  tokenMint?: string;
  whitelist: string[];
  intruderTriggerPct: number;
  intruderActions: Array<{ type: 'ALERT' | 'SELL_GROUP_PERCENT' | 'PAUSE' }>;
  groupSellPctMin: number;
  groupSellPctMax: number;
  walletsPerCycle: number;

  // Trading controls
  buySolPerWalletLamports?: number;

  // Holder scan controls
  holderScanIntervalMs?: number;
  holderScanTimeoutMs?: number;

  monitoringRules: { takeProfitPct?: number; stopLossPct?: number; maxHoldSec?: number };
  // Strategy-specific overrides
  takeProfitPct?: number;
  stopLossPct?: number;
  maxHoldSec?: number;
  usePrivacyMode?: boolean;

  dryRun: boolean;
  activeStrategyId?: string | null;

  rpcUrl: string;
  jupiterSlippageBps: number;

  botSecretEnc?: string | null;
  fundingSecretEnc?: string | null;
  profitWalletPubkey?: string | null;
  profitSecretEnc?: string | null;
};

export function ensureUltibotTables(db: Database.Database) {
  db.exec(`
  CREATE TABLE IF NOT EXISTS ultibot_config (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    enabled INTEGER NOT NULL,
    token_mint TEXT,
    whitelist_json TEXT NOT NULL,
    intruder_trigger_pct REAL NOT NULL,
    intruder_actions_json TEXT NOT NULL,
    group_sell_pct_min REAL NOT NULL,
    group_sell_pct_max REAL NOT NULL,
    wallets_per_cycle INTEGER NOT NULL,
    buy_sol_per_wallet_lamports TEXT,
    holder_scan_interval_ms INTEGER NOT NULL DEFAULT 90000,
    holder_scan_timeout_ms INTEGER NOT NULL DEFAULT 12000,
    monitoring_rules_json TEXT NOT NULL,
    rpc_url TEXT NOT NULL,
    jupiter_slippage_bps INTEGER NOT NULL DEFAULT 100,
    dry_run INTEGER NOT NULL DEFAULT 1,
    active_strategy_id TEXT,
    bot_secret_enc TEXT,
    funding_secret_enc TEXT,
    profit_wallet_pubkey TEXT,
    profit_secret_enc TEXT
  );

  CREATE TABLE IF NOT EXISTS ultibot_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    running INTEGER NOT NULL DEFAULT 0,
    last_tick_ms INTEGER,
    last_intruder_pct REAL,
    last_error TEXT
  );

  CREATE TABLE IF NOT EXISTS ultibot_events (
    id TEXT PRIMARY KEY,
    ts_ms INTEGER NOT NULL,
    level TEXT NOT NULL,
    type TEXT NOT NULL,
    message TEXT NOT NULL,
    data_json TEXT
  );

  CREATE TABLE IF NOT EXISTS ultibot_trades (
    id TEXT PRIMARY KEY,
    ts_ms INTEGER NOT NULL,
    side TEXT NOT NULL,
    mint TEXT NOT NULL,
    in_mint TEXT NOT NULL,
    out_mint TEXT NOT NULL,
    in_amount TEXT NOT NULL,
    out_amount TEXT,
    sig TEXT,
    status TEXT NOT NULL,
    error TEXT
  );

  CREATE TABLE IF NOT EXISTS ultibot_strategies (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    config_json TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL
  );

  
  CREATE TABLE IF NOT EXISTS ultibot_positions (
    id TEXT PRIMARY KEY,
    cycle_id TEXT NOT NULL,
    wallet_id TEXT NOT NULL,
    mint TEXT NOT NULL,
    status TEXT NOT NULL,
    opened_at_ms INTEGER NOT NULL,
    closed_at_ms INTEGER,
    entry_price_usd REAL,
    last_price_usd REAL,
    entry_sol_lamports TEXT,
    entry_token_raw TEXT,
    exit_sol_lamports TEXT,
    exit_token_raw TEXT,
    pnl_pct REAL,
    notes TEXT
  );


  CREATE TABLE IF NOT EXISTS ultibot_cycles (
    id TEXT PRIMARY KEY,
    strategy_id TEXT,
    mint TEXT,
    status TEXT NOT NULL,
    started_at_ms INTEGER NOT NULL,
    ended_at_ms INTEGER,
    notes TEXT
  );

  CREATE TABLE IF NOT EXISTS ultibot_wallets (
    id TEXT PRIMARY KEY,
    cycle_id TEXT NOT NULL,
    role TEXT NOT NULL,
    pubkey TEXT NOT NULL,
    secret_enc TEXT,
    status TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL,
    destroyed_at_ms INTEGER
  );

  CREATE TABLE IF NOT EXISTS ultibot_wallet_state (
    wallet_id TEXT NOT NULL,
    ts_ms INTEGER NOT NULL,
    sol_balance_lamports TEXT,
    token_balance_raw TEXT,
    entry_price_usd REAL,
    last_price_usd REAL,
    PRIMARY KEY (wallet_id, ts_ms)
  );

  CREATE TABLE IF NOT EXISTS ultibot_wallet_groups (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    cycle_number INTEGER NOT NULL,
    is_active INTEGER NOT NULL DEFAULT 0,
    phase TEXT NOT NULL DEFAULT 'PENDING',
    has_defended INTEGER NOT NULL DEFAULT 0,
    entry_price_usd REAL,
    entry_market_cap REAL,
    start_time INTEGER,
    initial_buy_sol_pct REAL,
    intruder_trigger_pct REAL,
    group_sell_pct_min REAL,
    group_sell_pct_max REAL,
    wallets_per_group INTEGER,
    tp_stop_loss_pairs_json TEXT,
    market_cap_take_profit_json TEXT,
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL
  );
  `);

  // Migrations for existing installs
  const addCol = (sql: string) => { try { db.exec(sql); } catch {} };
  addCol(`ALTER TABLE ultibot_config ADD COLUMN jupiter_slippage_bps INTEGER NOT NULL DEFAULT 100`);
  addCol(`ALTER TABLE ultibot_config ADD COLUMN dry_run INTEGER NOT NULL DEFAULT 1`);
  addCol(`ALTER TABLE ultibot_config ADD COLUMN active_strategy_id TEXT`);
  addCol(`ALTER TABLE ultibot_config ADD COLUMN funding_secret_enc TEXT`);
  addCol(`ALTER TABLE ultibot_config ADD COLUMN profit_wallet_pubkey TEXT`);
  addCol(`ALTER TABLE ultibot_config ADD COLUMN profit_secret_enc TEXT`);
  
  // Add wallet_id column to ultibot_wallet_groups if linking needed
  try {
    db.exec(`ALTER TABLE ultibot_wallets ADD COLUMN group_id TEXT`);
  } catch {}

  const row = db.prepare('SELECT * FROM ultibot_config WHERE id=1').get();
  if (!row) {
    db.prepare(`
      INSERT INTO ultibot_config (
        id, enabled, token_mint, whitelist_json, intruder_trigger_pct, intruder_actions_json,
        group_sell_pct_min, group_sell_pct_max, wallets_per_cycle, monitoring_rules_json, rpc_url,
        jupiter_slippage_bps, dry_run, active_strategy_id, bot_secret_enc, funding_secret_enc, profit_wallet_pubkey, profit_secret_enc
      ) VALUES (1, 0, NULL, ?, ?, ?, ?, ?, ?, ?, ?, 100, 1, NULL, NULL, NULL, NULL, NULL)
    `).run(
      JSON.stringify([]),
      1,
      JSON.stringify([{ type: 'ALERT' }]),
      10,
      20,
      5,
      JSON.stringify({ takeProfitPct: 20, stopLossPct: 15, maxHoldSec: 3600 }),
      process.env.SOLANA_RPC_URL || 'https://mainnet.helius-rpc.com/?api-key=f6c5e503-b09f-49c4-b652-b398c331ecf6'
    );
  }

  const s = db.prepare('SELECT * FROM ultibot_state WHERE id=1').get();
  if (!s) {
    db.prepare('INSERT INTO ultibot_state (id, running, last_tick_ms, last_intruder_pct, last_error) VALUES (1, 0, NULL, NULL, NULL)').run();
  }
}

export function loadUltibotConfig(db: Database.Database): UltibotConfig {
  const r: any = db.prepare('SELECT * FROM ultibot_config WHERE id=1').get();

  // If no config exists, return default config
  if (!r) {
    return {
      enabled: false,
      whitelist: [],
      intruderTriggerPct: 1,
      intruderActions: [{ type: 'ALERT' }],
      groupSellPctMin: 10,
      groupSellPctMax: 20,
      walletsPerCycle: 5,
      buySolPerWalletLamports: undefined,
      holderScanIntervalMs: 90000,
      holderScanTimeoutMs: 12000,
      monitoringRules: { takeProfitPct: 20, stopLossPct: 15, maxHoldSec: 3600 },
      rpcUrl: process.env.SOLANA_RPC_URL || 'https://mainnet.helius-rpc.com/?api-key=f6c5e503-b09f-49c4-b652-b398c331ecf6',
      jupiterSlippageBps: 100,
      dryRun: true,
      activeStrategyId: null,
      botSecretEnc: null,
      fundingSecretEnc: null,
      profitWalletPubkey: null,
      profitSecretEnc: null,
    };
  }

  return {
    enabled: !!r.enabled,
    tokenMint: r.token_mint || undefined,
    whitelist: JSON.parse(r.whitelist_json || '[]'),
    intruderTriggerPct: Number(r.intruder_trigger_pct),
    intruderActions: JSON.parse(r.intruder_actions_json || '[]'),
    groupSellPctMin: Number(r.group_sell_pct_min),
    groupSellPctMax: Number(r.group_sell_pct_max),
    walletsPerCycle: Number(r.wallets_per_cycle),
    buySolPerWalletLamports: r.buy_sol_per_wallet_lamports ? Number(r.buy_sol_per_wallet_lamports) : undefined,
    holderScanIntervalMs: r.holder_scan_interval_ms ? Number(r.holder_scan_interval_ms) : undefined,
    holderScanTimeoutMs: r.holder_scan_timeout_ms ? Number(r.holder_scan_timeout_ms) : undefined,
    monitoringRules: JSON.parse(r.monitoring_rules_json || '{}'),
    rpcUrl: String(r.rpc_url),
    jupiterSlippageBps: Number(r.jupiter_slippage_bps ?? 100),
    dryRun: !!r.dry_run,
    activeStrategyId: r.active_strategy_id ?? null,
    botSecretEnc: r.bot_secret_enc ?? null,
    fundingSecretEnc: r.funding_secret_enc ?? null,
    profitWalletPubkey: r.profit_wallet_pubkey ?? null,
    profitSecretEnc: r.profit_secret_enc ?? null,
  };
}

export function saveUltibotConfig(db: Database.Database, cfg: UltibotConfig) {
  db.prepare(`
    UPDATE ultibot_config SET
      enabled=?,
      token_mint=?,
      whitelist_json=?,
      intruder_trigger_pct=?,
      intruder_actions_json=?,
      group_sell_pct_min=?,
      group_sell_pct_max=?,
      wallets_per_cycle=?,
      buy_sol_per_wallet_lamports=?,
      holder_scan_interval_ms=?,
      holder_scan_timeout_ms=?,
      monitoring_rules_json=?,
      rpc_url=?,
      jupiter_slippage_bps=?,
      dry_run=?,
      active_strategy_id=?,
      bot_secret_enc=?,
      funding_secret_enc=?,
      profit_wallet_pubkey=?,
      profit_secret_enc=?
    WHERE id=1
  `).run(
    cfg.enabled ? 1 : 0,
    cfg.tokenMint || null,
    JSON.stringify(cfg.whitelist || []),
    cfg.intruderTriggerPct,
    JSON.stringify(cfg.intruderActions || []),
    cfg.groupSellPctMin,
    cfg.groupSellPctMax,
    cfg.walletsPerCycle,
    cfg.buySolPerWalletLamports ?? null,
    cfg.holderScanIntervalMs ?? 90000,
    cfg.holderScanTimeoutMs ?? 12000,
    JSON.stringify(cfg.monitoringRules || {}),
    cfg.rpcUrl,
    cfg.jupiterSlippageBps ?? 100,
    cfg.dryRun ? 1 : 0,
    cfg.activeStrategyId ?? null,
    cfg.botSecretEnc ?? null,
    cfg.fundingSecretEnc ?? null,
    cfg.profitWalletPubkey ?? null,
    cfg.profitSecretEnc ?? null
  );
}

export function setUltibotRunning(db: Database.Database, running: boolean) {
  db.prepare('UPDATE ultibot_state SET running=? WHERE id=1').run(running ? 1 : 0);
}

export function getUltibotState(db: Database.Database) {
  return db.prepare('SELECT * FROM ultibot_state WHERE id=1').get() as any;
}

export function updateUltibotState(db: Database.Database, patch: Partial<{ last_tick_ms: number; last_intruder_pct: number; last_error: string | null; }>) {
  const cur: any = db.prepare('SELECT * FROM ultibot_state WHERE id=1').get();
  const next = { ...cur, ...patch };
  db.prepare('UPDATE ultibot_state SET last_tick_ms=?, last_intruder_pct=?, last_error=? WHERE id=1')
    .run(next.last_tick_ms ?? null, next.last_intruder_pct ?? null, next.last_error ?? null);
}

export function insertUltibotEvent(db: Database.Database, ev: { id: string; tsMs: number; level: string; type: string; message: string; data?: any }) {
  db.prepare(`INSERT INTO ultibot_events (id, ts_ms, level, type, message, data_json) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(ev.id, ev.tsMs, ev.level, ev.type, ev.message, ev.data ? JSON.stringify(ev.data) : null);
}

export function insertUltibotTrade(db: Database.Database, tr: { id: string; tsMs: number; side: string; mint: string; inMint: string; outMint: string; inAmount: string; outAmount?: string | null; sig?: string | null; status: string; error?: string | null }) {
  db.prepare(`INSERT INTO ultibot_trades (id, ts_ms, side, mint, in_mint, out_mint, in_amount, out_amount, sig, status, error)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(tr.id, tr.tsMs, tr.side, tr.mint, tr.inMint, tr.outMint, tr.inAmount, tr.outAmount ?? null, tr.sig ?? null, tr.status, tr.error ?? null);
}

export function insertPosition(db: Database.Database, p: {
  id: string;
  cycleId: string;
  walletId: string;
  mint: string;
  status: string;
  openedAtMs: number;
  entryPriceUsd?: number | null;
  entrySolLamports?: string | null;
  entryTokenRaw?: string | null;
  notes?: string | null;
}) {
  db.prepare(`INSERT INTO ultibot_positions (id, cycle_id, wallet_id, mint, status, opened_at_ms, entry_price_usd, entry_sol_lamports, entry_token_raw, notes)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(p.id, p.cycleId, p.walletId, p.mint, p.status, p.openedAtMs, p.entryPriceUsd ?? null, p.entrySolLamports ?? null, p.entryTokenRaw ?? null, p.notes ?? null);
}

export function updatePosition(db: Database.Database, p: {
  id: string;
  status?: string;
  closedAtMs?: number | null;
  lastPriceUsd?: number | null;
  exitSolLamports?: string | null;
  exitTokenRaw?: string | null;
  pnlPct?: number | null;
  notes?: string | null;
}) {
  const current = db.prepare(`SELECT * FROM ultibot_positions WHERE id=?`).get(p.id) as any;
  if (!current) return;
  db.prepare(`UPDATE ultibot_positions SET
    status=?,
    closed_at_ms=?,
    last_price_usd=?,
    exit_sol_lamports=?,
    exit_token_raw=?,
    pnl_pct=?,
    notes=?
    WHERE id=?`)
    .run(
      p.status ?? current.status,
      p.closedAtMs ?? current.closed_at_ms,
      p.lastPriceUsd ?? current.last_price_usd,
      p.exitSolLamports ?? current.exit_sol_lamports,
      p.exitTokenRaw ?? current.exit_token_raw,
      p.pnlPct ?? current.pnl_pct,
      p.notes ?? current.notes,
      p.id
    );
}

export function listOpenPositions(db: Database.Database, cycleId: string): any[] {
  return db.prepare(`SELECT * FROM ultibot_positions WHERE cycle_id=? AND status='OPEN'`).all(cycleId) as any[];
}

// Wallet Groups functions
export function getWalletGroup(db: Database.Database, groupId: string): any | null {
  return db.prepare('SELECT * FROM ultibot_wallet_groups WHERE id=?').get(groupId) as any || null;
}

export function getAllWalletGroups(db: Database.Database): any[] {
  return db.prepare('SELECT * FROM ultibot_wallet_groups ORDER BY created_at_ms DESC').all() as any[];
}

export function saveWalletGroup(db: Database.Database, group: {
  id: string;
  name: string;
  cycleNumber: number;
  isActive: boolean;
  phase: string;
  hasDefended: boolean;
  entryPriceUsd?: number | null;
  entryMarketCap?: number | null;
  startTime?: number | null;
  initialBuySolPct?: number | null;
  intruderTriggerPct?: number | null;
  groupSellPctMin?: number | null;
  groupSellPctMax?: number | null;
  walletsPerGroup?: number | null;
  tpStopLossPairs?: any[] | null;
  marketCapTakeProfit?: any[] | null;
}) {
  const now = Date.now();
  const existing = getWalletGroup(db, group.id);
  
  if (existing) {
    db.prepare(`
      UPDATE ultibot_wallet_groups SET
        name=?, cycle_number=?, is_active=?, phase=?, has_defended=?,
        entry_price_usd=?, entry_market_cap=?, start_time=?,
        initial_buy_sol_pct=?, intruder_trigger_pct=?,
        group_sell_pct_min=?, group_sell_pct_max=?, wallets_per_group=?,
        tp_stop_loss_pairs_json=?, market_cap_take_profit_json=?,
        updated_at_ms=?
      WHERE id=?
    `).run(
      group.name,
      group.cycleNumber,
      group.isActive ? 1 : 0,
      group.phase,
      group.hasDefended ? 1 : 0,
      group.entryPriceUsd ?? null,
      group.entryMarketCap ?? null,
      group.startTime ?? null,
      group.initialBuySolPct ?? null,
      group.intruderTriggerPct ?? null,
      group.groupSellPctMin ?? null,
      group.groupSellPctMax ?? null,
      group.walletsPerGroup ?? null,
      group.tpStopLossPairs ? JSON.stringify(group.tpStopLossPairs) : null,
      group.marketCapTakeProfit ? JSON.stringify(group.marketCapTakeProfit) : null,
      now,
      group.id
    );
  } else {
    db.prepare(`
      INSERT INTO ultibot_wallet_groups (
        id, name, cycle_number, is_active, phase, has_defended,
        entry_price_usd, entry_market_cap, start_time,
        initial_buy_sol_pct, intruder_trigger_pct,
        group_sell_pct_min, group_sell_pct_max, wallets_per_group,
        tp_stop_loss_pairs_json, market_cap_take_profit_json,
        created_at_ms, updated_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      group.id,
      group.name,
      group.cycleNumber,
      group.isActive ? 1 : 0,
      group.phase,
      group.hasDefended ? 1 : 0,
      group.entryPriceUsd ?? null,
      group.entryMarketCap ?? null,
      group.startTime ?? null,
      group.initialBuySolPct ?? null,
      group.intruderTriggerPct ?? null,
      group.groupSellPctMin ?? null,
      group.groupSellPctMax ?? null,
      group.walletsPerGroup ?? null,
      group.tpStopLossPairs ? JSON.stringify(group.tpStopLossPairs) : null,
      group.marketCapTakeProfit ? JSON.stringify(group.marketCapTakeProfit) : null,
      now,
      now
    );
  }
}

export function deleteWalletGroup(db: Database.Database, groupId: string) {
  db.prepare('DELETE FROM ultibot_wallet_groups WHERE id=?').run(groupId);
}
