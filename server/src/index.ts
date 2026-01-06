import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { Server as IOServer } from 'socket.io';
import { z } from 'zod';
import Database from 'better-sqlite3';
import { nanoid } from 'nanoid';
import { Connection, PublicKey } from '@solana/web3.js';
import { getMint, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { ensureUltibotTables, loadUltibotConfig, saveUltibotConfig, setUltibotRunning, getWalletGroup, getAllWalletGroups, saveWalletGroup, deleteWalletGroup } from './ultibot/db';
import { encryptSecret } from './ultibot/crypto';
import { createUltibotEngine } from './ultibot/engine';
import { swapWithFallback } from './ultibot/openocean';
import { decryptSecret } from './ultibot/crypto';
import { Keypair } from '@solana/web3.js';
import { getAccount, getAssociatedTokenAddress } from '@solana/spl-token';
import { issueToken, requireAdmin } from './ultibot/auth';
import { getWalletBalance } from './ultibot/wallet-balance';
import { createRetryConnection } from './ultibot/rpc-retry';

// Environment validation
function validateEnvironment() {
  const required = ['ADMIN_PASSWORD'];
  const warnings = [];

  for (const env of required) {
    if (!process.env[env]) {
      console.error(`❌ Required environment variable ${env} is not set`);
      process.exit(1);
    }
  }

  // Optional but recommended
  if (!process.env.ULTIBOT_MASTER_KEY) {
    warnings.push('ULTIBOT_MASTER_KEY not set - wallet secrets will not be encrypted');
  }

  if (!process.env.SOLANA_RPC_URL) {
    warnings.push('SOLANA_RPC_URL not set - using default mainnet-beta');
  }

  if (!process.env.SESSION_SECRET) {
    warnings.push('SESSION_SECRET not set - using default (not secure for production)');
  }

  if (warnings.length > 0) {
    console.warn('⚠️  Environment warnings:');
    warnings.forEach(w => console.warn(`   - ${w}`));
  }

  console.log('✅ Environment validation passed');
}

validateEnvironment();

const PORT = Number(process.env.PORT || 8787);
const RPC_URL = process.env.SOLANA_RPC_URL || 'https://mainnet.helius-rpc.com/?api-key=f6c5e503-b09f-49c4-b652-b398c331ecf6';

const app = express();
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '2mb' }));

const httpServer = createServer(app);
const io = new IOServer(httpServer, { cors: { origin: true, credentials: true } });

// --- Admin auth (simple session token) ---
app.post('/api/admin/login', (req, res) => {
  const password = String(req.body?.password || '');
  const expected = process.env.ADMIN_PASSWORD || '';
  if (!expected) return res.status(500).json({ error: 'ADMIN_PASSWORD not configured' });
  if (password !== expected) return res.status(401).json({ error: 'invalid password' });
  const token = issueToken('admin');
  res.json({ ok: true, token });
});


/**
 * DB
 * - very small, single-file sqlite store
 */
const db = new Database(process.env.SQLITE_PATH || 'shadowcash.sqlite');
db.pragma('journal_mode = WAL');

// Ultibot tables/config
ensureUltibotTables(db);


db.exec(`
CREATE TABLE IF NOT EXISTS profiles (
  wallet TEXT PRIMARY KEY,
  username TEXT UNIQUE,
  created_at INTEGER NOT NULL,
  promo_code TEXT NOT NULL,
  referred_by TEXT,
  twitter_handle TEXT,
  tiktok_handle TEXT,
  facebook_handle TEXT,
  last_login INTEGER,
  login_count INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS promo_stats (
  promo_code TEXT PRIMARY KEY,
  referrals_count INTEGER NOT NULL DEFAULT 0,
  referred_volume_sol REAL NOT NULL DEFAULT 0,
  total_logins INTEGER NOT NULL DEFAULT 0,
  total_logouts INTEGER NOT NULL DEFAULT 0,
  total_posts INTEGER NOT NULL DEFAULT 0,
  total_likes INTEGER NOT NULL DEFAULT 0,
  total_paid_referrals INTEGER NOT NULL DEFAULT 0,
  paid_referral_percentage REAL NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS promo_activity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  promo_code TEXT NOT NULL,
  wallet TEXT NOT NULL,
  activity_type TEXT NOT NULL,
  activity_data TEXT,
  timestamp INTEGER NOT NULL,
  FOREIGN KEY (promo_code) REFERENCES promo_stats(promo_code)
);

CREATE TABLE IF NOT EXISTS market_maker_wallets (
  id TEXT PRIMARY KEY,
  address TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  private_key_encrypted TEXT,
  balance_sol REAL NOT NULL DEFAULT 0,
  balance_tokens REAL NOT NULL DEFAULT 0,
  is_whitelisted INTEGER NOT NULL DEFAULT 1,
  group_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (group_id) REFERENCES market_maker_groups(id)
);

CREATE TABLE IF NOT EXISTS market_maker_groups (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  buy_pct REAL NOT NULL DEFAULT 0,
  sell_pct REAL NOT NULL DEFAULT 0,
  rotation_enabled INTEGER NOT NULL DEFAULT 0,
  list_number INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'Live',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
`);

function ensurePromoStats(code: string) {
  db.prepare(`INSERT OR IGNORE INTO promo_stats(promo_code) VALUES (?)`).run(code);
}

function createPromoCode(): string {
  return nanoid(8).toUpperCase();
}

/**
 * In-memory bot state (kept simple; persist config in frontend/localStorage or extend DB if needed)
 */
type IntruderAction =
  | { type: 'ALERT' }
  | { type: 'PAUSE' }
  | { type: 'SELL_GROUP_PERCENT'; percentage: number };

type MonitoringRules = {
  takeProfitPct?: number; // e.g. 15 means +15%
  stopLossPct?: number;   // e.g. 10 means -10%
  maxHoldSec?: number;    // time-based exit
};

type BotConfig = {
  enabled: boolean;
  tokenMint?: string;
  whitelist: string[]; // wallets excluded from "intruder" metric
  intruderTriggerPct: number;
  intruderActions: IntruderAction[];
  groupSellPctMin: number;
  groupSellPctMax: number;
  walletsPerCycle: number;
  rpcUrl: string;
  botSecretEnc?: string | null;
  monitoringRules: MonitoringRules;
};

let botConfig: BotConfig = loadUltibotConfig(db) as any;

const ultibotEngine = createUltibotEngine({ db, io });
ultibotEngine.start();


let _connection: Connection | null = null;
let _rpcUrl = RPC_URL;
function getConnection(rpcUrl?: string) {
  const url = rpcUrl || _rpcUrl;
  if (!_connection || url !== _rpcUrl) {
    _rpcUrl = url;
    const baseConnection = new Connection(url, 'confirmed');
    // Wrap with retry logic for rate limiting
    _connection = createRetryConnection(baseConnection);
  }
  return _connection;
}


/**
 * Helpers: Unwhitelisted holder %
 *
 * NOTE: This is a best-effort approximation:
 * - Uses top accounts from getTokenLargestAccounts
 * - Computes held supply for non-whitelisted accounts in that top set
 * - For full accuracy across all holders you’d need indexing (Helius/Shyft/etc.)
 */
async function computeUnwhitelistedPct(mintStr: string, whitelist: string[]) {
  const mint = new PublicKey(mintStr);
  // Get connection - use bot config RPC URL if available, otherwise default
  const conn = getConnection(botConfig?.rpcUrl);
  const mintInfo = await getMint(conn, mint);
  const supply = Number(mintInfo.supply); // raw integer
  const decimals = mintInfo.decimals;

  const largest = await conn.getTokenLargestAccounts(mint);
  let unwhiteRaw = 0;

  for (const a of largest.value) {
    const addr = a.address.toBase58();
    if (whitelist.includes(addr)) continue;
    // uiAmount is already decimals-adjusted; convert back to raw for consistent pct calc
    const ui = a.uiAmount ?? 0;
    const raw = Math.round(ui * (10 ** decimals));
    unwhiteRaw += raw;
  }

  const pct = supply === 0 ? 0 : (unwhiteRaw / supply) * 100;
  return {
    supplyRaw: supply,
    decimals,
    unwhitelistedPctTopAccounts: pct,
    topAccounts: largest.value.map(v => ({
      tokenAccount: v.address.toBase58(),
      uiAmount: v.uiAmount ?? 0,
      amount: v.amount,
    })),
  };
}

/**
 * Wallet you don't own monitoring:
 * - subscribe to logs that mention an address (websocket)
 * - parse transaction post balances to emit BUY/SELL events (heuristic)
 */
type TradeEvent = {
  signature: string;
  slot?: number;
  type: 'BUY' | 'SELL' | 'TRANSFER' | 'UNKNOWN';
  wallet: string;
  mint?: string;
  deltaTokenUi?: number;
  deltaSol?: number;
  timestamp: number;
};

async function inferTradeFromTx(signature: string, wallet: string, mint?: string): Promise<TradeEvent | null> {
  const tx = await connection.getParsedTransaction(signature, { maxSupportedTransactionVersion: 0 });
  if (!tx) return null;
  const meta = tx.meta;
  if (!meta) return null;

  const walletPk = new PublicKey(wallet);
  const preLamports = tx.transaction.message.accountKeys.find(k => k.pubkey.equals(walletPk)) ? meta.preBalances[tx.transaction.message.accountKeys.findIndex(k => k.pubkey.equals(walletPk))] : undefined;
  const postLamports = tx.transaction.message.accountKeys.find(k => k.pubkey.equals(walletPk)) ? meta.postBalances[tx.transaction.message.accountKeys.findIndex(k => k.pubkey.equals(walletPk))] : undefined;

  const deltaSol = (preLamports !== undefined && postLamports !== undefined) ? (postLamports - preLamports) / 1e9 : undefined;

  let deltaTokenUi: number | undefined;
  if (mint) {
    const pre = meta.preTokenBalances?.filter(b => b.owner === wallet && b.mint === mint) ?? [];
    const post = meta.postTokenBalances?.filter(b => b.owner === wallet && b.mint === mint) ?? [];
    const preUi = pre.reduce((s, b) => s + Number(b.uiTokenAmount.uiAmount || 0), 0);
    const postUi = post.reduce((s, b) => s + Number(b.uiTokenAmount.uiAmount || 0), 0);
    deltaTokenUi = postUi - preUi;
  }

  let type: TradeEvent['type'] = 'UNKNOWN';
  if (deltaTokenUi !== undefined && deltaSol !== undefined) {
    if (deltaTokenUi > 0 && deltaSol < 0) type = 'BUY';
    else if (deltaTokenUi < 0 && deltaSol > 0) type = 'SELL';
    else type = 'TRANSFER';
  }

  return {
    signature,
    type,
    wallet,
    mint,
    deltaTokenUi,
    deltaSol,
    slot: tx.slot,
    timestamp: Date.now(),
  };
}

const monitoredWalletSubscriptions = new Map<string, number>();

// Ensure all active trading wallets are being monitored
async function ensureAllWalletsMonitored() {
  try {
    const wallets = db.prepare(`
      SELECT pubkey FROM ultibot_wallets
      WHERE status = 'ACTIVE' AND role = 'BUY'
    `).all() as { pubkey: string }[];

    for (const wallet of wallets) {
      await startWalletMonitor(wallet.pubkey);
    }

    console.log(`[WalletMonitor] Ensured monitoring for ${wallets.length} active trading wallets`);
  } catch (e) {
    console.error('[WalletMonitor] Error ensuring wallet monitoring:', e);
  }
}

async function startWalletMonitor(wallet: string) {
  if (monitoredWalletSubscriptions.has(wallet)) return;
  
  try {
    const walletPk = new PublicKey(wallet);

    // "mentions" subscription: gets logs where this pubkey is mentioned
    const subId = connection.onLogs(walletPk, async (logs) => {
      try {
        if (!botConfig.enabled) return;
        const mint = botConfig.tokenMint;
        if (!mint) return;
        
        const inferred = await inferTradeFromTx(logs.signature, wallet, mint);
        if (!inferred) return;
        io.emit('trade_event', inferred);
      } catch (e) {
        console.error(`[WalletMonitor] Error processing trade for ${wallet}:`, e);
        // Don't emit server_error for individual trade processing failures
      }
    }, 'confirmed');

    monitoredWalletSubscriptions.set(wallet, subId);
    console.log(`[WalletMonitor] Started monitoring wallet: ${wallet.substring(0, 8)}...`);
  } catch (e) {
    console.error(`[WalletMonitor] Failed to start monitoring wallet ${wallet}:`, e);
    // Don't throw - allow profile creation to succeed even if monitoring fails
  }
}

async function stopWalletMonitor(wallet: string) {
  const sub = monitoredWalletSubscriptions.get(wallet);
  if (!sub) return;
  await connection.removeOnLogsListener(sub);
  monitoredWalletSubscriptions.delete(wallet);
}

/**
 * API
 */
app.get('/api/health', (_req, res) => res.json({ ok: true, rpc: RPC_URL }));

// Debug endpoint to check current config
app.get('/api/debug/config', requireAdmin, (req, res) => {
  try {
    const config = loadUltibotConfig(db);
    res.json({
      enabled: config.enabled,
      tokenMint: config.tokenMint,
      walletsPerCycle: config.walletsPerCycle,
      rpcUrl: config.rpcUrl,
      hasFundingKey: !!config.fundingSecretEnc,
      hasProfitKey: !!config.profitWalletPubkey,
      activeStrategyId: config.activeStrategyId,
      dryRun: config.dryRun
    });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// Debug endpoint to check bot state
app.get('/api/debug/state', requireAdmin, (req, res) => {
  try {
    const state = db.prepare('SELECT * FROM ultibot_state WHERE id=1').get() as any;
    const cycles = db.prepare('SELECT * FROM ultibot_cycles ORDER BY started_at_ms DESC LIMIT 5').all() as any[];
    const wallets = db.prepare(`SELECT COUNT(*) as count FROM ultibot_wallets WHERE status='ACTIVE'`).get() as any;
    const positions = db.prepare(`SELECT COUNT(*) as count FROM ultibot_positions WHERE status='OPEN'`).get() as any;

    // Also check running cycles specifically
    const runningCycles = db.prepare(`SELECT * FROM ultibot_cycles WHERE status='RUNNING'`).all() as any[];
    const allWallets = db.prepare(`SELECT cycle_id, COUNT(*) as count FROM ultibot_wallets GROUP BY cycle_id`).all() as any[];

    res.json({
      state,
      runningCycles,
      recentCycles: cycles,
      activeWallets: wallets.count,
      openPositions: positions.count,
      walletDistribution: allWallets
    });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// API endpoint to fetch wallet groups for frontend display
app.get('/api/ultibot/wallet-groups', requireAdmin, (req, res) => {
  try {
    // Get saved wallet groups from database
    const savedGroups = getAllWalletGroups(db);
    
    // Get running cycles (active groups)
    const runningCycles = db.prepare(`SELECT * FROM ultibot_cycles WHERE status='RUNNING' ORDER BY started_at_ms DESC`).all() as any[];

    // Merge saved groups with active cycles
    const cycleGroups = runningCycles.map(cycle => {
      // Get wallets for this cycle
      const wallets = db.prepare(`
        SELECT w.*, p.entry_price_usd, p.entry_sol_lamports, p.entry_token_raw, p.status as position_status
        FROM ultibot_wallets w
        LEFT JOIN ultibot_positions p ON p.wallet_id = w.id AND p.cycle_id = w.cycle_id AND p.status = 'OPEN'
        WHERE w.cycle_id = ? AND w.status = 'ACTIVE'
        ORDER BY w.created_at_ms ASC
      `).all(cycle.id) as any[];

      // Format wallets for frontend
      const formattedWallets = wallets.map(w => ({
        id: w.id,
        groupId: cycle.id,
        address: w.pubkey,
        balanceSol: parseFloat(w.entry_sol_lamports || '0') / 1_000_000_000,
        balanceTokens: parseFloat(w.entry_token_raw || '0'),
        entryPrice: w.entry_price_usd ? parseFloat(w.entry_price_usd) : 0,
        status: w.position_status === 'OPEN' ? 'ACTIVE' : 'EXITED',
        isWhitelisted: false,
        label: `Wallet ${wallets.indexOf(w) + 1}`
      }));

      // Check if there's a saved group for this cycle
      const savedGroup = savedGroups.find(g => g.id === cycle.id);
      
      return {
        id: cycle.id,
        name: savedGroup?.name || `Cycle ${cycle.id.substring(0, 8)}`,
        cycleNumber: savedGroup?.cycle_number || 1,
        isActive: true,
        phase: savedGroup?.phase || 'MONITORING',
        hasDefended: savedGroup?.has_defended ? true : false,
        entryPriceUsd: savedGroup?.entry_price_usd || null,
        entryMarketCap: savedGroup?.entry_market_cap || null,
        startTime: savedGroup?.start_time || cycle.started_at_ms,
        initialBuySolPct: savedGroup?.initial_buy_sol_pct || null,
        intruderTriggerPct: savedGroup?.intruder_trigger_pct || null,
        groupSellPctMin: savedGroup?.group_sell_pct_min || null,
        groupSellPctMax: savedGroup?.group_sell_pct_max || null,
        walletsPerGroup: savedGroup?.wallets_per_group || null,
        tpStopLossPairs: savedGroup?.tp_stop_loss_pairs_json ? JSON.parse(savedGroup.tp_stop_loss_pairs_json) : [],
        marketCapTakeProfit: savedGroup?.market_cap_take_profit_json ? JSON.parse(savedGroup.market_cap_take_profit_json) : [],
        wallets: formattedWallets,
        createdAt: cycle.started_at_ms
      };
    });

    // Add saved groups that aren't active cycles
    const inactiveGroups = savedGroups
      .filter(g => !runningCycles.some(c => c.id === g.id))
      .map(g => ({
        id: g.id,
        name: g.name,
        cycleNumber: g.cycle_number,
        isActive: false,
        phase: g.phase,
        hasDefended: g.has_defended ? true : false,
        entryPriceUsd: g.entry_price_usd || null,
        entryMarketCap: g.entry_market_cap || null,
        startTime: g.start_time || null,
        initialBuySolPct: g.initial_buy_sol_pct || null,
        intruderTriggerPct: g.intruder_trigger_pct || null,
        groupSellPctMin: g.group_sell_pct_min || null,
        groupSellPctMax: g.group_sell_pct_max || null,
        walletsPerGroup: g.wallets_per_group || null,
        tpStopLossPairs: g.tp_stop_loss_pairs_json ? JSON.parse(g.tp_stop_loss_pairs_json) : [],
        marketCapTakeProfit: g.market_cap_take_profit_json ? JSON.parse(g.market_cap_take_profit_json) : [],
        wallets: [],
        createdAt: g.created_at_ms
      }));

    res.json({ groups: [...cycleGroups, ...inactiveGroups] });
  } catch (e) {
    console.error('[API] Error fetching wallet groups:', e);
    res.status(500).json({ error: String(e) });
  }
});

// Save/Update wallet group
app.post('/api/ultibot/wallet-groups', requireAdmin, (req, res) => {
  try {
    const Schema = z.object({
      id: z.string().optional(),
      name: z.string().min(1),
      cycleNumber: z.number().int().optional(),
      isActive: z.boolean().optional(),
      phase: z.string().optional(),
      hasDefended: z.boolean().optional(),
      entryPriceUsd: z.number().optional().nullable(),
      entryMarketCap: z.number().optional().nullable(),
      startTime: z.number().optional().nullable(),
      initialBuySolPct: z.number().optional().nullable(),
      intruderTriggerPct: z.number().optional().nullable(),
      groupSellPctMin: z.number().optional().nullable(),
      groupSellPctMax: z.number().optional().nullable(),
      walletsPerGroup: z.number().int().optional().nullable(),
      tpStopLossPairs: z.array(z.any()).optional().nullable(),
      marketCapTakeProfit: z.array(z.any()).optional().nullable(),
    });
    const body = Schema.parse(req.body);
    const groupId = body.id || nanoid();
    
    saveWalletGroup(db, {
      id: groupId,
      name: body.name,
      cycleNumber: body.cycleNumber || 1,
      isActive: body.isActive || false,
      phase: body.phase || 'PENDING',
      hasDefended: body.hasDefended || false,
      entryPriceUsd: body.entryPriceUsd,
      entryMarketCap: body.entryMarketCap,
      startTime: body.startTime,
      initialBuySolPct: body.initialBuySolPct,
      intruderTriggerPct: body.intruderTriggerPct,
      groupSellPctMin: body.groupSellPctMin,
      groupSellPctMax: body.groupSellPctMax,
      walletsPerGroup: body.walletsPerGroup,
      tpStopLossPairs: body.tpStopLossPairs,
      marketCapTakeProfit: body.marketCapTakeProfit,
    });

    io.emit('wallet_group_updated', { groupId, ...body });
    res.json({ ok: true, id: groupId });
  } catch (e: any) {
    console.error('[API] Error saving wallet group:', e);
    res.status(500).json({ error: String(e?.message || e) });
  }
});

// Delete wallet group
app.delete('/api/ultibot/wallet-groups/:id', requireAdmin, (req, res) => {
  try {
    const groupId = String(req.params.id);
    deleteWalletGroup(db, groupId);
    io.emit('wallet_group_deleted', { groupId });
    res.json({ ok: true });
  } catch (e: any) {
    console.error('[API] Error deleting wallet group:', e);
    res.status(500).json({ error: String(e?.message || e) });
  }
});

// Manual sell operations
app.post('/api/ultibot/groups/:id/sell', requireAdmin, async (req, res) => {
  try {
    const groupId = String(req.params.id);
    const Schema = z.object({
      sellPct: z.number().min(0).max(100),
      reason: z.string().optional(),
    });
    const body = Schema.parse(req.body);
    
    botConfig = loadUltibotConfig(db) as any;
    if (!botConfig.tokenMint) {
      return res.status(400).json({ error: 'No token mint configured' });
    }

    // Get cycle for this group
    const cycle = db.prepare(`SELECT * FROM ultibot_cycles WHERE id=? AND status='RUNNING'`).get(groupId) as any;
    if (!cycle) {
      return res.status(404).json({ error: 'Active cycle not found for this group' });
    }

    // Get open positions for this cycle
    const positions = db.prepare(`
      SELECT p.*, w.secret_enc, w.pubkey
      FROM ultibot_positions p
      JOIN ultibot_wallets w ON p.wallet_id = w.id
      WHERE p.cycle_id = ? AND p.status = 'OPEN'
    `).all(groupId) as any[];

    if (positions.length === 0) {
      return res.json({ ok: true, message: 'No open positions to sell', sold: 0 });
    }

    const conn = new Connection(botConfig.rpcUrl || RPC_URL, 'confirmed');
    const tokenMintPk = new PublicKey(botConfig.tokenMint);
    const SOL_MINT = 'So11111111111111111111111111111111111111112';
    
    let soldCount = 0;
    const errors: string[] = [];

    for (const pos of positions) {
      try {
        if (!pos.secret_enc) continue;
        
        const secretKey = JSON.parse(decryptSecret(pos.secret_enc));
        const wallet = Keypair.fromSecretKey(Uint8Array.from(secretKey));
        
        // Get current token balance
        const tokenAccount = await getAssociatedTokenAddress(tokenMintPk, wallet.publicKey);
        let tokenBalance = 0n;
        try {
          const account = await getAccount(conn, tokenAccount);
          tokenBalance = account.amount;
        } catch {
          // Account doesn't exist, skip
          continue;
        }

        if (tokenBalance === 0n) continue;

        // Calculate sell amount
        const sellAmount = (tokenBalance * BigInt(Math.floor(body.sellPct * 100))) / 10000n;
        if (sellAmount === 0n) continue;

        // Execute sell
        const result = await swapWithFallback({
          connection: conn,
          owner: wallet,
          inMint: botConfig.tokenMint,
          outMint: SOL_MINT,
          amountIn: sellAmount,
          slippagePct: Math.max(0.05, Number(botConfig.jupiterSlippageBps ?? 100) / 100),
          dryRun: !!botConfig.dryRun,
        });

        // Update position
        const remainingBalance = tokenBalance - sellAmount;
        if (remainingBalance === 0n || body.sellPct >= 100) {
          db.prepare(`UPDATE ultibot_positions SET status='CLOSED', closed_at_ms=?, exit_token_raw=?, exit_sol_lamports=? WHERE id=?`)
            .run(Date.now(), '0', result.outputAmount, pos.id);
        } else {
          db.prepare(`UPDATE ultibot_positions SET exit_token_raw=?, exit_sol_lamports=? WHERE id=?`)
            .run(remainingBalance.toString(), result.outputAmount, pos.id);
        }

        soldCount++;
        io.emit('position_sold', { positionId: pos.id, groupId, sellPct: body.sellPct, txid: result.txid });
      } catch (e: any) {
        errors.push(`Wallet ${pos.pubkey?.substring(0, 8)}: ${e.message}`);
      }
    }

    res.json({ ok: true, sold: soldCount, errors });
  } catch (e: any) {
    console.error('[API] Error executing group sell:', e);
    res.status(500).json({ error: String(e?.message || e) });
  }
});

// Sell unwhitelisted holdings from active group
app.post('/api/ultibot/sell-unwhitelisted', requireAdmin, async (req, res) => {
  try {
    botConfig = loadUltibotConfig(db) as any;
    if (!botConfig.tokenMint) {
      return res.status(400).json({ error: 'No token mint configured' });
    }

    // Get active cycle
    const cycle = db.prepare(`SELECT * FROM ultibot_cycles WHERE status='RUNNING' ORDER BY started_at_ms DESC LIMIT 1`).get() as any;
    if (!cycle) {
      return res.status(404).json({ error: 'No active cycle found' });
    }

    // Get positions and check whitelist
    const positions = db.prepare(`
      SELECT p.*, w.secret_enc, w.pubkey
      FROM ultibot_positions p
      JOIN ultibot_wallets w ON p.wallet_id = w.id
      WHERE p.cycle_id = ? AND p.status = 'OPEN'
    `).all(cycle.id) as any[];

    // Filter unwhitelisted wallets (wallets not in whitelist)
    const unwhitelisted = positions.filter(p => !botConfig.whitelist.includes(p.pubkey));

    if (unwhitelisted.length === 0) {
      return res.json({ ok: true, message: 'No unwhitelisted positions found', sold: 0 });
    }

    const conn = new Connection(botConfig.rpcUrl || RPC_URL, 'confirmed');
    const tokenMintPk = new PublicKey(botConfig.tokenMint);
    const SOL_MINT = 'So11111111111111111111111111111111111111112';
    
    let soldCount = 0;
    const errors: string[] = [];

    for (const pos of unwhitelisted) {
      try {
        if (!pos.secret_enc) continue;
        
        const secretKey = JSON.parse(decryptSecret(pos.secret_enc));
        const wallet = Keypair.fromSecretKey(Uint8Array.from(secretKey));
        
        const tokenAccount = await getAssociatedTokenAddress(tokenMintPk, wallet.publicKey);
        let tokenBalance = 0n;
        try {
          const account = await getAccount(conn, tokenAccount);
          tokenBalance = account.amount;
        } catch {
          continue;
        }

        if (tokenBalance === 0n) continue;

        // Sell 100% of unwhitelisted holdings
        const result = await swapWithFallback({
          connection: conn,
          owner: wallet,
          inMint: botConfig.tokenMint,
          outMint: SOL_MINT,
          amountIn: tokenBalance,
          slippagePct: Math.max(0.05, Number(botConfig.jupiterSlippageBps ?? 100) / 100),
          dryRun: !!botConfig.dryRun,
        });

        db.prepare(`UPDATE ultibot_positions SET status='CLOSED', closed_at_ms=?, exit_token_raw='0', exit_sol_lamports=? WHERE id=?`)
          .run(Date.now(), result.outputAmount, pos.id);

        soldCount++;
        io.emit('position_sold', { positionId: pos.id, groupId: cycle.id, sellPct: 100, txid: result.txid, unwhitelisted: true });
      } catch (e: any) {
        errors.push(`Wallet ${pos.pubkey?.substring(0, 8)}: ${e.message}`);
      }
    }

    res.json({ ok: true, sold: soldCount, errors });
  } catch (e: any) {
    console.error('[API] Error selling unwhitelisted:', e);
    res.status(500).json({ error: String(e?.message || e) });
  }
});

// CSV wallet import
app.post('/api/ultibot/wallets/import', requireAdmin, (req, res) => {
  try {
    const Schema = z.object({
      csv: z.string(),
      groupId: z.string().optional(),
    });
    const body = Schema.parse(req.body);
    
    // Parse CSV (simple format: address,privateKey or just address)
    const lines = body.csv.trim().split('\n');
    const wallets: Array<{ address: string; privateKey?: string }> = [];
    
    for (const line of lines) {
      const parts = line.split(',').map(s => s.trim());
      if (parts[0]) {
        wallets.push({
          address: parts[0],
          privateKey: parts[1] || undefined,
        });
      }
    }

    if (wallets.length === 0) {
      return res.status(400).json({ error: 'No valid wallets found in CSV' });
    }

    // Get or create cycle
    let cycleId = body.groupId;
    if (!cycleId) {
      // Create new cycle
      cycleId = nanoid();
      const now = Date.now();
      db.prepare(`INSERT INTO ultibot_cycles (id, strategy_id, mint, status, started_at_ms) VALUES (?, ?, ?, 'RUNNING', ?)`)
        .run(cycleId, botConfig.activeStrategyId ?? null, botConfig.tokenMint, now);
    }

    const now = Date.now();
    let imported = 0;

    for (const w of wallets) {
      try {
        // Validate address
        new PublicKey(w.address);
        
        const secretEnc = w.privateKey ? encryptSecret(w.privateKey) : null;
        db.prepare(`INSERT INTO ultibot_wallets (id, cycle_id, role, pubkey, secret_enc, status, created_at_ms)
                     VALUES (?, ?, 'BUY', ?, ?, 'ACTIVE', ?)`)
          .run(nanoid(), cycleId, w.address, secretEnc, now);
        imported++;
      } catch (e) {
        // Skip invalid addresses
        console.warn(`Skipping invalid wallet: ${w.address}`);
      }
    }

    io.emit('wallets_imported', { cycleId, count: imported });

    // Start monitoring imported wallets
    setTimeout(() => ensureAllWalletsMonitored(), 500);

    res.json({ ok: true, imported, cycleId });
  } catch (e: any) {
    console.error('[API] Error importing wallets:', e);
    res.status(500).json({ error: String(e?.message || e) });
  }
});

// Reset stuck cycles (for debugging)
app.post('/api/debug/reset-cycles', requireAdmin, (req, res) => {
  try {
    // Mark all running cycles as complete
    db.prepare(`UPDATE ultibot_cycles SET status='COMPLETE', ended_at_ms=? WHERE status='RUNNING'`)
      .run(Date.now());

    // Mark all wallets as destroyed
    db.prepare(`UPDATE ultibot_wallets SET status='DESTROYED', destroyed_at_ms=? WHERE status='ACTIVE'`)
      .run(Date.now());

    // Clear secrets for security
    db.prepare('UPDATE ultibot_wallets SET secret_enc=NULL WHERE secret_enc IS NOT NULL').run();

    res.json({ ok: true, message: 'Cycles reset successfully' });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// Check if wallet exists (without creating/updating)
app.get('/api/profile/check/:wallet', (req, res) => {
  const wallet = String(req.params.wallet);
  const existing = db.prepare(`SELECT wallet, promo_code, username FROM profiles WHERE wallet=?`).get(wallet) as any;

  if (existing) {
    res.json({ exists: true, username: existing.username, promoCode: existing.promo_code });
  } else {
    res.json({ exists: false });
  }
});

app.post('/api/profile/connect', (req, res) => {
  const Schema = z.object({
    wallet: z.string().min(1),
    username: z.string().optional(),
    referredBy: z.string().optional(),
    twitterHandle: z.string().optional(),
    tiktokHandle: z.string().optional(),
    facebookHandle: z.string().optional(),
  });
  const body = Schema.parse(req.body);

  const existing = db.prepare(`SELECT wallet, promo_code, username FROM profiles WHERE wallet=?`).get(body.wallet) as any;
  const now = Date.now();

  if (existing) {
    // Update last login and login count
    db.prepare(`UPDATE profiles SET last_login = ?, login_count = login_count + 1 WHERE wallet=?`).run(now, body.wallet);

    // Track login activity for promo code
    db.prepare(`INSERT INTO promo_activity(promo_code, wallet, activity_type, timestamp) VALUES(?, ?, 'LOGIN', ?)`).run(
      existing.promo_code,
      body.wallet,
      now
    );

    // Update promo stats login count
    db.prepare(`UPDATE promo_stats SET total_logins = total_logins + 1 WHERE promo_code=?`).run(existing.promo_code);

    return res.json({ wallet: body.wallet, username: existing.username, promoCode: existing.promo_code, existing: true });
  }

  // Generate unique username if not provided
  let username = body.username?.trim() || null;
  if (!username) {
    // Generate unique username: user_[random]_[timestamp]
    let attempts = 0;
    do {
      username = `user_${Math.random().toString(36).substring(2, 10)}_${Date.now().toString(36)}`;
      const existingUsername = db.prepare(`SELECT wallet FROM profiles WHERE username=?`).get(username);
      if (!existingUsername) break;
      attempts++;
      if (attempts > 10) {
        username = `user_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
        break;
      }
    } while (true);
  } else {
    // Check if username is already taken
    const existingUsername = db.prepare(`SELECT wallet FROM profiles WHERE username=?`).get(username);
    if (existingUsername) {
      return res.status(400).json({ error: 'Username already taken' });
    }
  }

  const promoCode = createPromoCode();

  try {
    db.prepare(`
      INSERT INTO profiles(wallet, username, created_at, promo_code, referred_by, twitter_handle, tiktok_handle, facebook_handle, last_login, login_count)
      VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
    `).run(
      body.wallet,
      username,
      now,
      promoCode,
      body.referredBy || null,
      body.twitterHandle || null,
      body.tiktokHandle || null,
      body.facebookHandle || null,
      now
    );
  } catch (e: any) {
    if (e.message?.includes('UNIQUE constraint') && e.message?.includes('username')) {
      return res.status(400).json({ error: 'Username already taken' });
    }
    if (e.message?.includes('UNIQUE constraint') && e.message?.includes('wallet')) {
      return res.status(400).json({ error: 'Wallet already registered' });
    }
    throw e;
  }

  ensurePromoStats(promoCode);
  
  // Track initial login
  db.prepare(`INSERT INTO promo_activity(promo_code, wallet, activity_type, timestamp) VALUES(?, ?, 'LOGIN', ?)`).run(
    promoCode,
    body.wallet,
    now
  );
  db.prepare(`UPDATE promo_stats SET total_logins = total_logins + 1 WHERE promo_code=?`).run(promoCode);

  // Update referral stats if code exists
  if (body.referredBy) {
    ensurePromoStats(body.referredBy);
    db.prepare(`UPDATE promo_stats SET referrals_count = referrals_count + 1 WHERE promo_code=?`).run(body.referredBy);
    
    // Track referral activity
    db.prepare(`INSERT INTO promo_activity(promo_code, wallet, activity_type, timestamp) VALUES(?, ?, 'REFERRAL', ?)`).run(
      body.referredBy,
      body.wallet,
      now
    );
  }

  // start monitoring this wallet in background
  startWalletMonitor(body.wallet).catch(() => {});

  res.json({ wallet: body.wallet, username, promoCode, existing: false });
});

// Track logout
app.post('/api/profile/logout', (req, res) => {
  const Schema = z.object({
    wallet: z.string().min(32),
  });
  const body = Schema.parse(req.body);
  
  const profile = db.prepare(`SELECT promo_code FROM profiles WHERE wallet=?`).get(body.wallet) as any;
  if (!profile) return res.status(404).json({ error: 'Profile not found' });
  
  const now = Date.now();
  db.prepare(`INSERT INTO promo_activity(promo_code, wallet, activity_type, timestamp) VALUES(?, ?, 'LOGOUT', ?)`).run(
    profile.promo_code,
    body.wallet,
    now
  );
  db.prepare(`UPDATE promo_stats SET total_logouts = total_logouts + 1 WHERE promo_code=?`).run(profile.promo_code);
  
  res.json({ ok: true });
});

// Track activity (posts, likes, etc.)
app.post('/api/profile/activity', (req, res) => {
  const Schema = z.object({
    wallet: z.string().min(32),
    activityType: z.enum(['POST', 'LIKE']),
    activityData: z.record(z.any()).optional(),
  });
  const body = Schema.parse(req.body);
  
  const profile = db.prepare(`SELECT promo_code FROM profiles WHERE wallet=?`).get(body.wallet) as any;
  if (!profile) return res.status(404).json({ error: 'Profile not found' });
  
  const now = Date.now();
  db.prepare(`INSERT INTO promo_activity(promo_code, wallet, activity_type, activity_data, timestamp) VALUES(?, ?, ?, ?, ?)`).run(
    profile.promo_code,
    body.wallet,
    body.activityType,
    body.activityData ? JSON.stringify(body.activityData) : null,
    now
  );
  
  if (body.activityType === 'POST') {
    db.prepare(`UPDATE promo_stats SET total_posts = total_posts + 1 WHERE promo_code=?`).run(profile.promo_code);
  } else if (body.activityType === 'LIKE') {
    db.prepare(`UPDATE promo_stats SET total_likes = total_likes + 1 WHERE promo_code=?`).run(profile.promo_code);
  }
  
  res.json({ ok: true });
});

// Update volume for promo code
app.post('/api/promo/volume', (req, res) => {
  const Schema = z.object({
    promoCode: z.string(),
    volumeSol: z.number(),
    isPaid: z.boolean().optional(),
  });
  const body = Schema.parse(req.body);
  
  ensurePromoStats(body.promoCode);
  db.prepare(`UPDATE promo_stats SET referred_volume_sol = referred_volume_sol + ? WHERE promo_code=?`).run(
    body.volumeSol,
    body.promoCode
  );
  
  if (body.isPaid) {
    db.prepare(`UPDATE promo_stats SET total_paid_referrals = total_paid_referrals + 1 WHERE promo_code=?`).run(body.promoCode);
    
    // Calculate paid referral percentage
    const stats = db.prepare(`SELECT referrals_count, total_paid_referrals FROM promo_stats WHERE promo_code=?`).get(body.promoCode) as any;
    if (stats && stats.referrals_count > 0) {
      const percentage = (stats.total_paid_referrals / stats.referrals_count) * 100;
      db.prepare(`UPDATE promo_stats SET paid_referral_percentage = ? WHERE promo_code=?`).run(percentage, body.promoCode);
    }
  }
  
  res.json({ ok: true });
});

app.get('/api/promo/:code', (req, res) => {
  const code = String(req.params.code || '').toUpperCase();
  const row = db.prepare(`SELECT * FROM promo_stats WHERE promo_code=?`).get(code);
  if (!row) return res.status(404).json({ error: 'Not found' });
  res.json(row);
});

app.get('/api/promo/leaderboard', (req, res) => {
  try {
    const leaderboard = db.prepare(`
      SELECT 
        promo_code,
        referrals_count,
        referred_volume_sol,
        total_logins,
        total_logouts,
        total_posts,
        total_likes,
        total_paid_referrals,
        paid_referral_percentage
      FROM promo_stats
      ORDER BY referrals_count DESC, referred_volume_sol DESC
      LIMIT 100
    `).all();
    res.json(leaderboard);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// Admin Profile Management
app.get('/api/admin/profiles', (req, res) => {
  try {
    const profiles = db.prepare(`
      SELECT 
        p.wallet,
        p.created_at,
        p.promo_code,
        p.referred_by,
        p.twitter_handle,
        p.tiktok_handle,
        p.facebook_handle,
        p.last_login,
        p.login_count,
        ps.referrals_count,
        ps.referred_volume_sol,
        ps.total_logins,
        ps.total_logouts,
        ps.total_posts,
        ps.total_likes
      FROM profiles p
      LEFT JOIN promo_stats ps ON p.promo_code = ps.promo_code
      ORDER BY p.created_at DESC
      LIMIT 500
    `).all();
    res.json(profiles);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.put('/api/admin/profiles/:wallet', (req, res) => {
  const Schema = z.object({
    twitterHandle: z.string().optional(),
    tiktokHandle: z.string().optional(),
    facebookHandle: z.string().optional(),
  });
  const body = Schema.parse(req.body);
  const wallet = String(req.params.wallet);
  
  try {
    db.prepare(`
      UPDATE profiles 
      SET twitter_handle = COALESCE(?, twitter_handle),
          tiktok_handle = COALESCE(?, tiktok_handle),
          facebook_handle = COALESCE(?, facebook_handle)
      WHERE wallet = ?
    `).run(
      body.twitterHandle || null,
      body.tiktokHandle || null,
      body.facebookHandle || null,
      wallet
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.delete('/api/admin/profiles/:wallet', (req, res) => {
  const wallet = String(req.params.wallet);
  
  try {
    // Get promo code before deletion
    const profile = db.prepare(`SELECT promo_code FROM profiles WHERE wallet=?`).get(wallet) as any;
    
    if (profile) {
      // Delete profile
      db.prepare(`DELETE FROM profiles WHERE wallet=?`).run(wallet);
      // Delete activity logs
      db.prepare(`DELETE FROM promo_activity WHERE wallet=?`).run(wallet);
      // Note: We keep promo_stats for historical data
    }
    
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.get('/api/leaderboard', (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT
        ps.promo_code,
        ps.referrals_count,
        ps.referred_volume_sol,
        ps.total_logins,
        ps.total_logouts,
        ps.total_posts,
        ps.total_likes,
        ps.total_paid_referrals,
        ps.paid_referral_percentage,
        p.twitter_handle,
        p.tiktok_handle,
        p.facebook_handle,
        p.wallet
      FROM promo_stats ps
      LEFT JOIN profiles p ON ps.promo_code = p.promo_code
      WHERE ps.referrals_count > 0 OR ps.referred_volume_sol > 0
      ORDER BY ps.referrals_count DESC, ps.referred_volume_sol DESC
      LIMIT 100
    `).all();
    res.json(rows);
  } catch (error) {
    console.error('Leaderboard error:', error);
    res.status(500).json({ error: 'Database query failed' });
  }
});

app.post('/api/promo/volume', (req, res) => {
  const Schema = z.object({
    promoCode: z.string().min(3),
    volumeSol: z.number().nonnegative(),
  });
  const body = Schema.parse(req.body);
  ensurePromoStats(body.promoCode.toUpperCase());
  db.prepare(`UPDATE promo_stats SET referred_volume_sol = referred_volume_sol + ? WHERE promo_code=?`).run(body.volumeSol, body.promoCode.toUpperCase());
  res.json({ ok: true });
});

app.post('/api/ultibot/config', requireAdmin, (req, res) => {
  const Schema = z.object({
    enabled: z.boolean(),
    tokenMint: z.string().optional(),
    whitelist: z.array(z.string()).optional().default([]),
    intruderTriggerPct: z.number().min(0).max(100).optional().default(1),
    intruderActions: z.array(z.any()).optional().default([]),
    groupSellPctMin: z.number().min(0).max(100).optional().default(10),
    groupSellPctMax: z.number().min(0).max(100).optional().default(20),
    walletsPerCycle: z.number().int().min(1).max(50).default(5),
    buySolPerWalletLamports: z.number().int().min(1000).optional(),
    holderScanIntervalMs: z.number().int().min(10000).max(600000).optional(),
    holderScanTimeoutMs: z.number().int().min(3000).max(60000).optional(),
    dryRun: z.boolean().optional(),
    activeStrategyId: z.string().optional(),
    jupiterSlippageBps: z.number().int().min(1).max(5000).optional(),
    rpcUrl: z.string().optional(),
    botSecretKey: z.string().optional(),
    fundingSecretKey: z.string().optional(),
    profitWalletPubkey: z.string().optional(),
    profitSecretKey: z.string().optional(),
    monitoringRules: z.object({
      takeProfitPct: z.number().optional(),
      stopLossPct: z.number().optional(),
      maxHoldSec: z.number().optional(),
    }).default({}),
  });
  console.log('Config update request body:', JSON.stringify(req.body, null, 2));
  const body = Schema.parse(req.body);
  console.log('Parsed body:', body);

  botConfig = {
    ...botConfig,
    ...body,
    tokenMint: body.tokenMint || botConfig.tokenMint,
    rpcUrl: body.rpcUrl || botConfig.rpcUrl,
  };

  if (body.botSecretKey) {
    botConfig.botSecretEnc = encryptSecret(body.botSecretKey);
  }
  if (body.fundingSecretKey) {
    (botConfig as any).fundingSecretEnc = encryptSecret(body.fundingSecretKey);
  }
  if (body.profitSecretKey) {
    (botConfig as any).profitSecretEnc = encryptSecret(body.profitSecretKey);
  }
  if (body.profitWalletPubkey) {
    (botConfig as any).profitWalletPubkey = body.profitWalletPubkey;
  }
  if (typeof body.dryRun === 'boolean') {
    (botConfig as any).dryRun = body.dryRun;
  }
  if (typeof body.jupiterSlippageBps === 'number') {
    (botConfig as any).jupiterSlippageBps = body.jupiterSlippageBps;
  }
  if (typeof body.activeStrategyId === 'string') {
    (botConfig as any).activeStrategyId = body.activeStrategyId;
  }
  if (typeof body.buySolPerWalletLamports === 'number') {
    (botConfig as any).buySolPerWalletLamports = body.buySolPerWalletLamports;
  }
  if (typeof body.holderScanIntervalMs === 'number') {
    (botConfig as any).holderScanIntervalMs = body.holderScanIntervalMs;
  }
  if (typeof body.holderScanTimeoutMs === 'number') {
    (botConfig as any).holderScanTimeoutMs = body.holderScanTimeoutMs;
  }

  // Persist
  saveUltibotConfig(db, botConfig as any);

  const { botSecretEnc, fundingSecretEnc, profitSecretEnc, ...safe } = botConfig as any;
  res.json({ ok: true, botConfig: safe });
  return;

});


app.get('/api/ultibot/config', requireAdmin, (req, res) => {
  botConfig = loadUltibotConfig(db) as any;
  const { botSecretEnc, fundingSecretEnc, profitSecretEnc, ...safe } = botConfig as any;
  res.json({ ok: true, botConfig: safe });
});

// Get wallet balance (for special wallets)
app.post('/api/wallet/balance', requireAdmin, async (req, res) => {
  try {
    const { privateKey, rpcUrl } = req.body;
    if (!privateKey) {
      return res.status(400).json({ error: 'Private key required' });
    }
    
    const connection = new Connection(rpcUrl || RPC_URL, 'confirmed');
    const balance = await getWalletBalance(connection, privateKey);
    
    res.json({ ok: true, balance: balance.sol, publicKey: balance.publicKey });
  } catch (e: any) {
    console.error('Balance fetch error:', e);
    res.status(500).json({ error: String(e?.message || e) });
  }
});


/**
 * Solana proxy endpoints (RPC key stays server-side)
 */
app.get('/api/solana/token-info', requireAdmin, async (req, res) => {
  try {
    const mint = String(req.query.mint || '');
    if (!mint) return res.status(400).json({ error: 'mint required' });
    botConfig = loadUltibotConfig(db) as any;

    const conn = getConnection(botConfig.rpcUrl);
    const mintPk = new PublicKey(mint);
    const mintInfo = await getMint(conn, mintPk);

    // Fetch token metadata from Metaplex
    let metadata = null;
    try {
      // Metaplex Token Metadata Program ID
      const METADATA_PROGRAM_ID = new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s');

      // Derive the metadata account address
      const [metadataPDA] = PublicKey.findProgramAddressSync(
        [
          Buffer.from('metadata'),
          METADATA_PROGRAM_ID.toBuffer(),
          mintPk.toBuffer(),
        ],
        METADATA_PROGRAM_ID
      );

      const metadataAccount = await conn.getAccountInfo(metadataPDA);
      if (metadataAccount && metadataAccount.data.length > 0) {
        // Parse metadata manually since we don't have the full SDK
        // Metadata structure: https://docs.metaplex.com/programs/token-metadata/accounts/metadata
        const data = metadataAccount.data;

        // Skip the first byte (account discriminator) and read the updateAuthority (32 bytes)
        let offset = 1 + 32;

        // Read mint (32 bytes, but we already know it)
        offset += 32;

        // Read name (4 bytes length + string)
        const nameLen = data.readUInt32LE(offset);
        offset += 4;
        const name = data.slice(offset, offset + nameLen).toString('utf8').replace(/\x00/g, '').trim();
        offset += nameLen;

        // Read symbol (4 bytes length + string)
        const symbolLen = data.readUInt32LE(offset);
        offset += 4;
        const symbol = data.slice(offset, offset + symbolLen).toString('utf8').replace(/\x00/g, '').trim();

        if (name && symbol) {
          metadata = {
            name: name,
            symbol: symbol,
          };
        }
      }
    } catch (metadataError) {
      console.warn('Failed to fetch token metadata:', metadataError.message);
      // Continue without metadata
    }

    res.json({
      mint,
      supply: mintInfo.supply.toString(),
      decimals: mintInfo.decimals,
      metadata,
    });
  } catch (e: any) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

app.get('/api/ultibot/metrics', async (req, res) => {
  try {
    const mint = req.query.mint ? String(req.query.mint) : botConfig.tokenMint;
    if (!mint) return res.status(400).json({ error: 'mint required' });
    const out = await computeUnwhitelistedPct(mint, botConfig.whitelist);
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});


app.post('/api/ultibot/start', requireAdmin, (req, res) => {
  botConfig = loadUltibotConfig(db) as any;
  botConfig.enabled = true;
  saveUltibotConfig(db, botConfig as any);
  setUltibotRunning(db, true);
  ultibotEngine.start();

  // Ensure all trading wallets are being monitored for trade events
  ensureAllWalletsMonitored();

  // Emit bot config update to notify frontend
  io.emit('bot_config', botConfig);
  res.json({ ok: true });

/**
 * Strategies CRUD
 */
app.get('/api/ultibot/strategies', requireAdmin, (req, res) => {
  const rows = db.prepare('SELECT * FROM ultibot_strategies ORDER BY updated_at_ms DESC').all() as any[];
  res.json(rows.map(r => ({
    id: r.id,
    name: r.name,
    description: r.description,
    config: JSON.parse(r.config_json || '{}'),
    createdAtMs: r.created_at_ms,
    updatedAtMs: r.updated_at_ms,
  })));
});

app.post('/api/ultibot/strategies', requireAdmin, (req, res) => {
  const Schema = z.object({
    id: z.string().min(3).optional(),
    name: z.string().min(1),
    description: z.string().optional(),
    config: z.record(z.any()),
  });
  const body = Schema.parse(req.body);
  const now = Date.now();
  const id = body.id || nanoid();
  const exists = db.prepare('SELECT id FROM ultibot_strategies WHERE id=?').get(id);
  if (exists) {
    db.prepare(`UPDATE ultibot_strategies SET name=?, description=?, config_json=?, updated_at_ms=? WHERE id=?`)
      .run(body.name, body.description || null, JSON.stringify(body.config || {}), now, id);
  } else {
    db.prepare(`INSERT INTO ultibot_strategies (id, name, description, config_json, created_at_ms, updated_at_ms) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(id, body.name, body.description || null, JSON.stringify(body.config || {}), now, now);
  }
  res.json({ ok: true, id });
});

app.delete('/api/ultibot/strategies/:id', requireAdmin, (req, res) => {
  const id = String(req.params.id);
  db.prepare('DELETE FROM ultibot_strategies WHERE id=?').run(id);
  res.json({ ok: true });
});

/**
 * Bot state + cycles
 */
app.get('/api/ultibot/state', requireAdmin, (req, res) => {
  const state = db.prepare('SELECT * FROM ultibot_state WHERE id=1').get() as any;
  const cycle = db.prepare(`SELECT * FROM ultibot_cycles WHERE status='RUNNING' ORDER BY started_at_ms DESC LIMIT 1`).get() as any;
  const wallets = cycle ? (db.prepare(`SELECT id, cycle_id, role, pubkey, status, created_at_ms, destroyed_at_ms FROM ultibot_wallets WHERE cycle_id=?`).all(cycle.id) as any[]) : [];
  res.json({
    config: botConfig,
    state,
    activeCycle: cycle || null,
    wallets,
  });
});

app.post('/api/ultibot/cycle/start', requireAdmin, (req, res) => {
  // Flip enabled and let engine create a cycle based on activeStrategyId/config
  botConfig.enabled = true;
  saveUltibotConfig(db, botConfig as any);

  // Ensure wallets from new cycle are monitored
  setTimeout(() => ensureAllWalletsMonitored(), 1000);

  io.emit('bot_config', botConfig);
  res.json({ ok: true });
});

app.post('/api/ultibot/cycle/stop', requireAdmin, (req, res) => {
  botConfig.enabled = false;
  saveUltibotConfig(db, botConfig as any);
  io.emit('bot_config', botConfig);
  res.json({ ok: true });
});

});

app.post('/api/ultibot/stop', requireAdmin, (req, res) => {
  botConfig = loadUltibotConfig(db) as any;
  botConfig.enabled = false;
  saveUltibotConfig(db, botConfig as any);
  // Emit bot config update to notify frontend
  io.emit('bot_config', botConfig);
  res.json({ ok: true });
});

io.on('connection', (socket) => {
  try {
    socket.emit('bot_config', botConfig);
    console.log(`[Socket.IO] Client connected: ${socket.id}`);
    
    socket.on('disconnect', (reason) => {
      console.log(`[Socket.IO] Client disconnected: ${socket.id}, reason: ${reason}`);
    });
    
    socket.on('error', (error) => {
      console.error(`[Socket.IO] Socket error for ${socket.id}:`, error);
    });
  } catch (error) {
    console.error('[Socket.IO] Connection handler error:', error);
  }
});

// Handle Socket.IO server errors
io.engine.on('connection_error', (err) => {
  console.error('[Socket.IO] Engine connection error:', err);
});

/**
 * Periodic metrics push (reduced frequency to avoid rate limits)
 */
setInterval(async () => {
  try {
    if (!botConfig.enabled || !botConfig.tokenMint) return;
    const metrics = await computeUnwhitelistedPct(botConfig.tokenMint, botConfig.whitelist);
    io.emit('unwhitelisted_pct', {
      mint: botConfig.tokenMint,
      unwhitelistedPctTopAccounts: metrics.unwhitelistedPctTopAccounts,
      ts: Date.now(),
    });
    // intruder trigger is based on this pct (top accounts approximation)
    if (metrics.unwhitelistedPctTopAccounts >= botConfig.intruderTriggerPct) {
      io.emit('intruder_trigger', {
        mint: botConfig.tokenMint,
        pct: metrics.unwhitelistedPctTopAccounts,
        trigger: botConfig.intruderTriggerPct,
        actions: botConfig.intruderActions,
        ts: Date.now(),
      });
    }
  } catch (e: any) {
    // Don't emit server_error for rate limit errors - they're expected and handled
    if (!String(e?.message || e).includes('429') && !String(e?.message || e).includes('Too many requests')) {
      io.emit('server_error', { message: String(e) });
    }
  }
}, 30000); // Increased to 30s to further reduce RPC load

/**
 * Market Maker API Endpoints
 */
type MarketMakerWallet = {
  id: string;
  address: string;
  label: string;
  balanceSol: number;
  balanceTokens: number;
  isWhitelisted: boolean;
  groupId?: string;
};

type MarketMakerConfig = {
  mode: 'CONTINUOUS' | 'CYCLE' | 'MANUAL';
  strategy: string;
  tokenMint: string;
  minTradeAmount: number;
  maxTradeAmount: number;
  tradeDelayMs: number;
  spreadPct: number;
  marketProtectionEnabled: boolean;
  marketProtectionTriggerPct: number;
  profitTakingEnabled: boolean;
  profitTargetPct: number;
  usePrivacyMode: boolean;
  whitelist: string[];
  waitForUnwhitelistedExit: boolean;
};

// In-memory market maker state (config and orders still in-memory for now)
let mmConfig: MarketMakerConfig | null = null;
let mmOrders: any[] = [];
let mmTransfers: any[] = [];

// Market Maker Wallet Management (using database)
app.post('/api/marketmaker/wallets', (req, res) => {
  const Schema = z.object({
    address: z.string().min(32),
    label: z.string().optional(),
    privateKey: z.string().optional(),
    isWhitelisted: z.boolean().default(true),
    groupId: z.string().optional(),
  });
  const body = Schema.parse(req.body);
  
  const walletId = nanoid();
  const now = Date.now();
  
  try {
    db.prepare(`
      INSERT INTO market_maker_wallets (id, address, label, private_key_encrypted, balance_sol, balance_tokens, is_whitelisted, group_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      walletId,
      body.address,
      body.label || `Wallet ${body.address.substring(0, 8)}`,
      body.privateKey || null, // TODO: Encrypt in production
      0,
      0,
      body.isWhitelisted ? 1 : 0,
      body.groupId || null,
      now,
      now
    );
    
    const wallet: MarketMakerWallet = {
      id: walletId,
      address: body.address,
      label: body.label || `Wallet ${body.address.substring(0, 8)}`,
      balanceSol: 0,
      balanceTokens: 0,
      isWhitelisted: body.isWhitelisted,
      groupId: body.groupId,
    };
    
    res.json(wallet);
  } catch (e: any) {
    if (e.message.includes('UNIQUE constraint')) {
      return res.status(400).json({ error: 'Wallet address already exists' });
    }
    res.status(500).json({ error: String(e) });
  }
});

app.get('/api/marketmaker/wallets', (_req, res) => {
  const rows = db.prepare(`
    SELECT id, address, label, balance_sol as balanceSol, balance_tokens as balanceTokens, 
           is_whitelisted as isWhitelisted, group_id as groupId
    FROM market_maker_wallets
    ORDER BY created_at DESC
  `).all();
  
  res.json(rows.map((r: any) => ({
    ...r,
    isWhitelisted: r.isWhitelisted === 1,
  })));
});

app.delete('/api/marketmaker/wallets/:id', (req, res) => {
  const id = String(req.params.id);
  const stmt = db.prepare('DELETE FROM market_maker_wallets WHERE id = ?');
  const result = stmt.run(id);
  
  if (result.changes === 0) {
    return res.status(404).json({ error: 'Wallet not found' });
  }
  
  res.json({ ok: true });
});

// Market Maker Groups (using database)
app.post('/api/marketmaker/groups', (req, res) => {
  const Schema = z.object({
    name: z.string().min(1),
    buyPct: z.number().optional(),
    sellPct: z.number().optional(),
    rotationEnabled: z.boolean().optional(),
    listNumber: z.number().optional(),
  });
  const body = Schema.parse(req.body);
  
  const groupId = nanoid();
  const now = Date.now();
  
  try {
    db.prepare(`
      INSERT INTO market_maker_groups (id, name, buy_pct, sell_pct, rotation_enabled, list_number, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      groupId,
      body.name,
      body.buyPct || 0,
      body.sellPct || 0,
      body.rotationEnabled ? 1 : 0,
      body.listNumber || 1,
      'Live',
      now,
      now
    );
    
    const group = {
      id: groupId,
      name: body.name,
      wallets: [],
      buyPct: body.buyPct || 0,
      sellPct: body.sellPct || 0,
      rotationEnabled: body.rotationEnabled || false,
      listNumber: body.listNumber || 1,
      status: 'Live',
      createdAt: new Date(now).toISOString(),
      updatedAt: new Date(now).toISOString(),
    };
    
    res.json(group);
  } catch (e: any) {
    res.status(500).json({ error: String(e) });
  }
});

app.get('/api/marketmaker/groups', (_req, res) => {
  const groups = db.prepare(`
    SELECT id, name, buy_pct as buyPct, sell_pct as sellPct, 
           rotation_enabled as rotationEnabled, list_number as listNumber,
           status, created_at as createdAt, updated_at as updatedAt
    FROM market_maker_groups
    ORDER BY created_at DESC
  `).all();
  
  // Update wallet counts
  const groupsWithCounts = groups.map((g: any) => {
    const walletCount = db.prepare('SELECT COUNT(*) as count FROM market_maker_wallets WHERE group_id = ?')
      .get(g.id) as { count: number };
    return {
      ...g,
      rotationEnabled: g.rotationEnabled === 1,
      walletCount: walletCount.count,
    };
  });
  
  res.json(groupsWithCounts);
});

app.get('/api/marketmaker/groups/:id', (req, res) => {
  const id = String(req.params.id);
  const group = db.prepare(`
    SELECT id, name, buy_pct as buyPct, sell_pct as sellPct, 
           rotation_enabled as rotationEnabled, list_number as listNumber,
           status, created_at as createdAt, updated_at as updatedAt
    FROM market_maker_groups
    WHERE id = ?
  `).get(id) as any;
  
  if (!group) {
    return res.status(404).json({ error: 'Group not found' });
  }
  
  const groupWallets = db.prepare(`
    SELECT id, address, label, balance_sol as balanceSol, balance_tokens as balanceTokens,
           is_whitelisted as isWhitelisted, group_id as groupId
    FROM market_maker_wallets
    WHERE group_id = ?
  `).all(id);
  
  res.json({
    ...group,
    rotationEnabled: group.rotationEnabled === 1,
    wallets: groupWallets.map((w: any) => ({
      ...w,
      isWhitelisted: w.isWhitelisted === 1,
    })),
    walletCount: groupWallets.length,
  });
});

app.put('/api/marketmaker/groups/:id', (req, res) => {
  const id = String(req.params.id);
  const existing = db.prepare('SELECT * FROM market_maker_groups WHERE id = ?').get(id);
  if (!existing) {
    return res.status(404).json({ error: 'Group not found' });
  }
  
  const Schema = z.object({
    name: z.string().optional(),
    buyPct: z.number().optional(),
    sellPct: z.number().optional(),
    rotationEnabled: z.boolean().optional(),
    status: z.enum(['Live', 'Paused', 'Suspended']).optional(),
    listNumber: z.number().optional(),
  });
  const updates = Schema.parse(req.body);
  
  const updateFields: string[] = [];
  const updateValues: any[] = [];
  
  if (updates.name !== undefined) {
    updateFields.push('name = ?');
    updateValues.push(updates.name);
  }
  if (updates.buyPct !== undefined) {
    updateFields.push('buy_pct = ?');
    updateValues.push(updates.buyPct);
  }
  if (updates.sellPct !== undefined) {
    updateFields.push('sell_pct = ?');
    updateValues.push(updates.sellPct);
  }
  if (updates.rotationEnabled !== undefined) {
    updateFields.push('rotation_enabled = ?');
    updateValues.push(updates.rotationEnabled ? 1 : 0);
  }
  if (updates.status !== undefined) {
    updateFields.push('status = ?');
    updateValues.push(updates.status);
  }
  if (updates.listNumber !== undefined) {
    updateFields.push('list_number = ?');
    updateValues.push(updates.listNumber);
  }
  
  updateFields.push('updated_at = ?');
  updateValues.push(Date.now());
  updateValues.push(id);
  
  db.prepare(`UPDATE market_maker_groups SET ${updateFields.join(', ')} WHERE id = ?`).run(...updateValues);
  
  const updated = db.prepare(`
    SELECT id, name, buy_pct as buyPct, sell_pct as sellPct, 
           rotation_enabled as rotationEnabled, list_number as listNumber,
           status, created_at as createdAt, updated_at as updatedAt
    FROM market_maker_groups
    WHERE id = ?
  `).get(id) as any;
  
  res.json({
    ...updated,
    rotationEnabled: updated.rotationEnabled === 1,
  });
});

app.delete('/api/marketmaker/groups/:id', (req, res) => {
  const id = String(req.params.id);
  
  // Remove wallets from this group (set group_id to null)
  db.prepare('UPDATE market_maker_wallets SET group_id = NULL WHERE group_id = ?').run(id);
  
  // Delete the group
  const stmt = db.prepare('DELETE FROM market_maker_groups WHERE id = ?');
  const result = stmt.run(id);
  
  if (result.changes === 0) {
    return res.status(404).json({ error: 'Group not found' });
  }
  
  res.json({ ok: true });
});

// Group Analytics
app.get('/api/marketmaker/groups/:id/analytics', (req, res) => {
  const id = String(req.params.id);
  const group = db.prepare('SELECT * FROM market_maker_groups WHERE id = ?').get(id);
  if (!group) {
    return res.status(404).json({ error: 'Group not found' });
  }
  
  const groupWallets = db.prepare(`
    SELECT id, address, label, balance_sol as balanceSol, balance_tokens as balanceTokens,
           is_whitelisted as isWhitelisted, group_id as groupId
    FROM market_maker_wallets
    WHERE group_id = ?
  `).all(id);
  
  const walletIds = groupWallets.map((w: any) => w.id);
  const groupOrders = mmOrders.filter(o => walletIds.includes(o.walletId));
  
  const analytics = {
    groupId: id,
    totalTrades: groupOrders.length,
    totalVolume: groupOrders.reduce((sum, o) => sum + (o.amount || 0), 0),
    totalSol: groupWallets.reduce((sum, w) => sum + (w.balanceSol || 0), 0),
    totalTokens: groupWallets.reduce((sum, w) => sum + (w.balanceTokens || 0), 0),
    walletCount: groupWallets.length,
    buyOrders: groupOrders.filter(o => o.type === 'BUY').length,
    sellOrders: groupOrders.filter(o => o.type === 'SELL').length,
    completedOrders: groupOrders.filter(o => o.status === 'COMPLETED').length,
    pendingOrders: groupOrders.filter(o => o.status === 'PENDING' || o.status === 'EXECUTING').length,
    last24hVolume: groupOrders
      .filter(o => o.timestamp > Date.now() - 24 * 60 * 60 * 1000)
      .reduce((sum, o) => sum + (o.amount || 0), 0),
    last24hTrades: groupOrders.filter(o => o.timestamp > Date.now() - 24 * 60 * 60 * 1000).length,
  };
  
  res.json(analytics);
});

// Market Maker Configuration
app.post('/api/marketmaker/config', (req, res) => {
  const Schema = z.object({
    mode: z.enum(['CONTINUOUS', 'CYCLE', 'MANUAL']),
    strategy: z.string(),
    tokenMint: z.string().min(32),
    minTradeAmount: z.number().min(0),
    maxTradeAmount: z.number().min(0),
    tradeDelayMs: z.number().min(0),
    spreadPct: z.number().min(0).max(100),
    marketProtectionEnabled: z.boolean(),
    marketProtectionTriggerPct: z.number(),
    profitTakingEnabled: z.boolean(),
    profitTargetPct: z.number(),
    usePrivacyMode: z.boolean(),
    whitelist: z.array(z.string()),
    waitForUnwhitelistedExit: z.boolean(),
  });
  mmConfig = Schema.parse(req.body);
  res.json(mmConfig);
});

app.get('/api/marketmaker/config', (_req, res) => {
  res.json(mmConfig);
});

// Manual Trading
app.post('/api/marketmaker/orders', (req, res) => {
  const Schema = z.object({
    walletIds: z.array(z.string()),
    type: z.enum(['BUY', 'SELL']),
    amount: z.number().optional(),
    amountPct: z.number().optional(),
    price: z.number().optional(),
    executions: z.number().default(1),
    spacingMs: z.number().default(0),
    dryRun: z.boolean().default(false),
  });
  const body = Schema.parse(req.body);
  
  // Create orders (implementation would execute trades)
  const orders = body.walletIds.map(walletId => ({
    id: nanoid(),
    walletId,
    type: body.type,
    amount: body.amount,
    amountPct: body.amountPct,
    price: body.price,
    status: body.dryRun ? 'PENDING' : 'EXECUTING',
    timestamp: Date.now(),
    isManual: true,
  }));
  
  mmOrders.push(...orders);
  res.json(orders);
});

// Fund Management
app.post('/api/marketmaker/transfers', (req, res) => {
  const Schema = z.object({
    type: z.enum(['DEPOSIT', 'WITHDRAW', 'REBALANCE', 'CONSOLIDATE']),
    fromWallets: z.array(z.string()).optional(),
    toWallets: z.array(z.string()).optional(),
    amount: z.number().optional(),
    amountPct: z.number().optional(),
    distribution: z.enum(['EQUAL', 'CUSTOM', 'RANGE']).optional(),
    customAmounts: z.record(z.number()).optional(),
    rebalanceMode: z.enum(['AVERAGE', 'TARGET', 'THRESHOLD']).optional(),
    rebalanceTarget: z.number().optional(),
    destination: z.string().optional(),
    fundingSource: z.string().optional(),
    usePrivacyMode: z.boolean().default(true),
    preview: z.any().optional(),
  });
  const body = Schema.parse(req.body);
  
  // Create transfer (implementation would execute using privacy system if enabled)
  const transfer = {
    id: nanoid(),
    type: body.type,
    fromWallets: body.fromWallets,
    toWallets: body.toWallets,
    amount: body.amount,
    amountPct: body.amountPct,
    distribution: body.distribution,
    customAmounts: body.customAmounts,
    rebalanceMode: body.rebalanceMode,
    rebalanceTarget: body.rebalanceTarget,
    destination: body.destination,
    fundingSource: body.fundingSource,
    status: 'PENDING',
    timestamp: Date.now(),
    usePrivacyMode: body.usePrivacyMode,
    txHashes: [], // Will be populated after execution
  };
  
  // In production, this would:
  // 1. Execute transfers using PrivacyCashDirect if usePrivacyMode is true
  // 2. Or use direct SystemProgram.transfer if false
  // 3. Track all transaction hashes
  // 4. Update wallet balances
  
  mmTransfers.push(transfer);
  res.json({ ...transfer, txHashes: ['mock_tx_hash_' + Date.now()] }); // Mock for now
});

// Market Maker Stats
// Site Fee Management
let siteFees = {
  anonPayFee: 0.001,
  cleanerFee: 0.001,
  marketMakerFee: 0.001,
  defaultFee: 0.001,
};

app.get('/api/admin/fees', (_req, res) => {
  res.json(siteFees);
});

app.post('/api/admin/fees', (req, res) => {
  const Schema = z.object({
    anonPayFee: z.number().min(0).max(1),
    cleanerFee: z.number().min(0),
    marketMakerFee: z.number().min(0).max(1),
    defaultFee: z.number().min(0).max(1),
  });
  siteFees = Schema.parse(req.body);
  res.json(siteFees);
});

app.get('/api/marketmaker/stats', async (_req, res) => {
  try {
    if (!mmConfig || !mmConfig.tokenMint) {
      return res.json({
        totalTrades: 0,
        totalVolume: 0,
        totalProfit: 0,
        activeWallets: mmWallets.size,
        currentPrice: 0,
        unwhitelistedHoldingsPct: 0,
      });
    }
    
    const metrics = await computeUnwhitelistedPct(mmConfig.tokenMint, mmConfig.whitelist);
    
    res.json({
      totalTrades: mmOrders.filter(o => o.status === 'COMPLETED').length,
      totalVolume: mmOrders.reduce((sum, o) => sum + (o.amount || 0), 0),
      totalProfit: 0, // Calculate from completed trades
      activeWallets: Array.from(mmWallets.values()).filter(w => w.balanceSol > 0).length,
      currentPrice: 0, // Fetch from pool
      unwhitelistedHoldingsPct: metrics.unwhitelistedPctTopAccounts,
    });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

httpServer.listen(PORT, () => {
  console.log(`ShadowCash server listening on :${PORT}`);
});
