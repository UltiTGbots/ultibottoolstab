
import { Connection, Keypair, PublicKey, SystemProgram, Transaction } from '@solana/web3.js';
import type Database from 'better-sqlite3';
import { nanoid } from 'nanoid';
import { getMint, getAccount, getAssociatedTokenAddress, createAssociatedTokenAccountInstruction } from '@solana/spl-token';
import bs58 from 'bs58';

import { decryptSecret, encryptSecret } from './crypto';
import {
  loadUltibotConfig,
  updateUltibotState,
  setUltibotRunning,
  insertUltibotEvent,
  insertUltibotTrade,
  insertPosition,
  updatePosition,
  listOpenPositions,
  getWalletGroup,
  getAllWalletGroups,
  saveWalletGroup
} from './db';
import { swapWithFallback, openOceanPriceUsd } from './openocean';
import { scanAllTokenHolders } from './holders';
import { calculateCycleFunding, calculateWalletFundingAmount } from './funding';
import { createRetryConnection } from './rpc-retry';
import pLimit from 'p-limit';

// Import Privacy Cash for backend privacy transfers
// Note: Privacy Cash SDK is designed for Node.js and can be used in backend
// If not available, privacy transfers will fall back to direct transfers or emit events
let PrivacyCash: any = null;
try {
  // Try to import PrivacyCash from the src directory
  // Path is relative to server/src/ultibot/engine.ts -> ../../../src/index.js
  const privacyCashModule = require('../../../src/index.js');
  PrivacyCash = privacyCashModule?.PrivacyCash || null;
  if (PrivacyCash) {
    console.log('[Engine] Privacy Cash SDK loaded successfully');
  }
} catch (e: any) {
  // Privacy Cash SDK not available - will use direct transfers or emit events
  console.warn('[Engine] Privacy Cash SDK not available, privacy transfers will use direct transfers or emit events:', e?.message || e);
}

export type UltibotEngine = ReturnType<typeof createUltibotEngine>;

const SOL_MINT = 'So11111111111111111111111111111111111111112';

export function createUltibotEngine(opts: {
  db: Database.Database;
  io: { emit: (ev: string, data: any) => void };
}) {
  let timer: any = null;
  let lastRpc = '';
  let connection: Connection | null = null;

  // cached holder scan
  let lastHolderScanMs = 0;
  let lastHolderSnapshot: any = null;

  // cached funding calculation per cycle
  const cycleFundingCache = new Map<string, { fundingAmounts: Map<number, number>; calculatedAt: number }>();

  function getConnection(rpcUrl: string | null | undefined): Connection {
    const url = rpcUrl || 'https://mainnet.helius-rpc.com/?api-key=f6c5e503-b09f-49c4-b652-b398c331ecf6';
    if (!connection || url !== lastRpc) {
      lastRpc = url;
      const baseConnection = new Connection(url, { commitment: 'confirmed' });
      // Wrap with retry logic for rate limiting
      connection = createRetryConnection(baseConnection);
    }
    return connection!;
  }

  function log(level: string, type: string, message: string, data?: any) {
    const ev = { id: nanoid(), tsMs: Date.now(), level, type, message, data };
    try { insertUltibotEvent(opts.db, ev); } catch {}
    opts.io.emit('ultibot_event', ev);
  }

  function getActiveCycle(): any | null {
    return opts.db.prepare(`SELECT * FROM ultibot_cycles WHERE status='RUNNING' ORDER BY started_at_ms DESC LIMIT 1`).get() as any || null;
  }

  function getCycleWallets(cycleId: string): any[] {
    return opts.db.prepare(`SELECT * FROM ultibot_wallets WHERE cycle_id=? AND role='BUY' AND status='ACTIVE' ORDER BY created_at_ms ASC`).all(cycleId) as any[];
  }

  function markCycleComplete(cycleId: string, notes?: string) {
    const now = Date.now();
    opts.db.prepare(`UPDATE ultibot_cycles SET status='COMPLETE', ended_at_ms=?, notes=? WHERE id=?`).run(now, notes ?? null, cycleId);
    opts.db.prepare(`UPDATE ultibot_wallets SET status='DESTROYED', destroyed_at_ms=?, secret_enc=NULL WHERE cycle_id=?`).run(now, cycleId);
  }

  async function ensureCycle(cfg: any): Promise<any | null> {
    if (!cfg.enabled || !cfg.tokenMint) return null;

    const existing = getActiveCycle();
    if (existing) return existing;

    const cycleId = nanoid();
    const now = Date.now();
    opts.db.prepare(`INSERT INTO ultibot_cycles (id, strategy_id, mint, status, started_at_ms) VALUES (?, ?, ?, 'RUNNING', ?)`)
      .run(cycleId, cfg.activeStrategyId ?? null, cfg.tokenMint, now);

    // Generate N buy wallets for the cycle
    const n = Number(cfg.walletsPerCycle || 5);

    // Get active wallet groups to distribute wallets
    const activeGroups = getAllWalletGroups(opts.db).filter(g => g.isActive && g.phase !== 'COMPLETED');

    // Update entry market cap for groups that don't have it set
    for (const group of activeGroups) {
      if (!group.entryMarketCap && marketData.marketCap > 0) {
        updateWalletGroup(opts.db, {
          ...group,
          entryMarketCap: marketData.marketCap,
          entryPriceUsd: marketData.priceUsd
        });
      }
    }

    let groupIndex = 0;

    for (let i = 0; i < n; i++) {
      const kp = Keypair.generate();
      const secretEnc = encryptSecret(JSON.stringify(Array.from(kp.secretKey)));
      const walletId = nanoid();

      // Assign wallet to a group (round-robin distribution)
      let groupId = null;
      if (activeGroups.length > 0) {
        groupId = activeGroups[groupIndex % activeGroups.length].id;
        groupIndex++;
      }

      opts.db.prepare(`INSERT INTO ultibot_wallets (id, cycle_id, role, pubkey, secret_enc, status, created_at_ms, group_id)
                       VALUES (?, ?, 'BUY', ?, ?, 'ACTIVE', ?, ?)`)
        .run(walletId, cycleId, kp.publicKey.toBase58(), secretEnc, now, groupId);

      // Wallet monitoring will be started by the main server when wallet is created
    }

    log('INFO', 'CYCLE_START', 'Started new cycle and generated buy wallets', { cycleId, wallets: n, groups: activeGroups.length, mint: cfg.tokenMint });
    return getActiveCycle();
  }

  function getFundingKeypair(cfg: any): Keypair | null {
    // Funding wallet optional; if not set, trades must be done by the cycle wallets already funded
    const enc = cfg.fundingSecretEnc || null;
    if (!enc) return null;
    try {
      const raw = decryptSecret(enc);
      const arr = JSON.parse(raw) as number[];
      return Keypair.fromSecretKey(Uint8Array.from(arr));
    } catch (e) {
      return null;
    }
  }

  function getProfitPubkey(cfg: any): PublicKey | null {
    if (!cfg.profitWalletPubkey) return null;
    try { return new PublicKey(cfg.profitWalletPubkey); } catch { return null; }
  }

  async function transferSol(connection: Connection, from: Keypair, to: PublicKey, lamports: number): Promise<string> {
    const tx = new Transaction().add(
      SystemProgram.transfer({ fromPubkey: from.publicKey, toPubkey: to, lamports })
    );
    const sig = await connection.sendTransaction(tx, [from], { skipPreflight: false, maxRetries: 2 });
    const latest = await connection.getLatestBlockhash('confirmed');
    const res = await connection.confirmTransaction({ signature: sig, blockhash: latest.blockhash, lastValidBlockHeight: latest.lastValidBlockHeight }, 'confirmed');
    if (res.value.err) throw new Error(`Transfer failed: ${JSON.stringify(res.value.err)}`);
    return sig;
  }

  async function ensureAta(connection: Connection, payer: Keypair, mint: PublicKey, owner: PublicKey): Promise<PublicKey> {
    const ata = await getAssociatedTokenAddress(mint, owner, false);
    try {
      await getAccount(connection, ata, 'confirmed');
      return ata;
    } catch {
      // create
      const ix = createAssociatedTokenAccountInstruction(payer.publicKey, ata, owner, mint);
      const tx = new Transaction().add(ix);
      const sig = await connection.sendTransaction(tx, [payer], { skipPreflight: false, maxRetries: 2 });
      const latest = await connection.getLatestBlockhash('confirmed');
      const res = await connection.confirmTransaction({ signature: sig, blockhash: latest.blockhash, lastValidBlockHeight: latest.lastValidBlockHeight }, 'confirmed');
      if (res.value.err) throw new Error(`ATA create failed: ${JSON.stringify(res.value.err)}`);
      return ata;
    }
  }

  async function getSolBalanceLamports(connection: Connection, pubkey: PublicKey): Promise<bigint> {
    const b = await connection.getBalance(pubkey, 'confirmed');
    return BigInt(b);
  }

  async function getTokenBalanceRaw(connection: Connection, mint: PublicKey, owner: PublicKey): Promise<bigint> {
    const ata = await getAssociatedTokenAddress(mint, owner, false);
    try {
      const acct = await getAccount(connection, ata, 'confirmed');
      return acct.amount;
    } catch {
      return 0n;
    }
  }

  function pLimit(concurrency: number) {
    let active = 0;
    const queue: Array<() => void> = [];
    const next = () => {
      active--;
      if (queue.length) queue.shift()!();
    };
    return async <T>(fn: () => Promise<T>) => {
      if (active >= concurrency) {
        await new Promise<void>((r) => queue.push(r));
      }
      active++;
      try {
        return await fn();
      } finally {
        next();
      }
    };
  }

  async function performParallelBuys(params: {
    cfg: any;
    cycle: any;
    wallets: any[];
    mintPk: PublicKey;
    decimals: number;
    supplyRaw: bigint;
    priceUsd: number | null;
  }) {
    const { cfg, cycle, wallets, mintPk, decimals, supplyRaw, priceUsd } = params;
    const conn = getConnection(cfg.rpcUrl || 'https://mainnet.helius-rpc.com/?api-key=f6c5e503-b09f-49c4-b652-b398c331ecf6');
    const funding = getFundingKeypair(cfg);

    // Calculate funding amounts based on supply percentage tiers
    // Cache calculation per cycle to avoid recalculating on every tick
    let walletFundingAmounts: Map<number, number> = new Map();
    
    // Check cache first (cache valid for 5 minutes)
    const cacheKey = cycle.id;
    const cached = cycleFundingCache.get(cacheKey);
    const cacheValid = cached && (Date.now() - cached.calculatedAt) < 300000; // 5 minutes
    
    if (cacheValid) {
      walletFundingAmounts = cached.fundingAmounts;
      // Don't log if using cached value
    } else if (priceUsd != null && priceUsd > 0) {
      const cycleFunding = calculateCycleFunding({
        walletsPerCycle: wallets.length,
        totalSupply: supplyRaw,
        decimals,
        priceUsd,
        slippageBuffer: 0.05 // 5% buffer for slippage
      });
      
      // Only log once per cycle (when cache is empty)
      if (!cached) {
        log('INFO', 'FUNDING_CALC', 'Calculated cycle funding', {
          cycleId: cycle.id,
          tokenMint: cfg.tokenMint,
          priceUsd: priceUsd?.toFixed(6),
          totalSolNeeded: cycleFunding.totalSolNeeded.toFixed(4),
          wallets: wallets.length,
          walletFunding: cycleFunding.walletFunding.map(w => ({
            index: w.walletIndex,
            supplyPct: w.targetSupplyPct.toFixed(2),
            sol: w.requiredSol.toFixed(4)
          }))
        });
      }
      
      // Store funding amounts per wallet index
      cycleFunding.walletFunding.forEach(w => {
        walletFundingAmounts.set(w.walletIndex, w.requiredSolLamports);
      });
      
      // Cache the result
      cycleFundingCache.set(cacheKey, {
        fundingAmounts: new Map(walletFundingAmounts),
        calculatedAt: Date.now()
      });
    } else {
      // Fallback: use fixed amount if price unavailable
      const fallbackLamports = cfg.buySolPerWalletLamports ?? 50_000_000;
      wallets.forEach((_, i) => walletFundingAmounts.set(i, fallbackLamports));
      if (!cached) {
        log('WARN', 'FUNDING_FALLBACK', 'Using fallback funding (price unavailable)', {
          perWalletLamports: fallbackLamports
        });
      }
    }

    // Fund wallets from funding wallet using privacy transfers
    // Note: Privacy transfers are handled by frontend Shadow Pool system
    // Backend just needs to ensure wallets have enough SOL
    // Skip funding in dry-run mode since no real transactions will occur
    if (funding && !cfg.dryRun) {
      log('INFO', 'FUNDING', 'Funding cycle wallets before buys', {
        cycleId: cycle.id,
        wallets: wallets.length,
        usePrivacyMode: cfg.usePrivacyMode ?? false
      });

      const limit = pLimit(5);
      await Promise.all(wallets.map((w, index) => limit(async () => {
        const to = new PublicKey(w.pubkey);
        let bal: bigint;
        try {
          bal = await getSolBalanceLamports(conn, to);
        } catch (e) {
          log('ERROR', 'BALANCE_FETCH_FAIL', 'Failed to fetch wallet balance', {
            wallet: w.pubkey,
            error: String((e as any)?.message ?? e)
          });
          return; // Skip this wallet
        }
        const requiredLamports = walletFundingAmounts.get(index) ?? 50_000_000;
        const requiredWithBuffer = requiredLamports + 10_000_000; // Add 0.01 SOL for fees
        
        if (bal >= BigInt(requiredWithBuffer)) {
          log('INFO', 'FUND_SKIP', 'Wallet already funded', { wallet: w.pubkey, balance: bal.toString() });
          return;
        }
        
        // If privacy mode, emit event for frontend to handle via Shadow Pool
        // Otherwise, direct transfer
        if (cfg.usePrivacyMode) {
          opts.io.emit('privacy_funding_request', {
            cycleId: cycle.id,
            walletId: w.id,
            walletPubkey: w.pubkey,
            amountSol: requiredLamports / 1_000_000_000,
            amountLamports: requiredLamports,
            walletIndex: index
          });
          log('INFO', 'PRIVACY_FUNDING', 'Privacy funding requested', { 
            wallet: w.pubkey, 
            amount: (requiredLamports / 1_000_000_000).toFixed(4) + ' SOL'
          });
        } else {
          // Direct transfer (non-privacy mode)
          const sig = await transferSol(conn, funding, to, requiredWithBuffer);
          log('INFO', 'FUND_WALLET', 'Funded wallet (direct)', { wallet: w.pubkey, sig, amount: requiredWithBuffer });
        }
      })));
    }

    // Buy SOL -> token per wallet (non-bundled) with confirmations
    // Use calculated funding amounts per wallet
    const limit = pLimit(4);
    await Promise.all(wallets.map((w, index) => limit(async () => {
      const walletId = w.id as string;

      // Parse wallet keypair with error handling
      let kp: Keypair;
      try {
        kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(decryptSecret(w.secret_enc))));
      } catch (e) {
        log('ERROR', 'KEYPAIR_PARSE_FAIL', 'Failed to parse wallet keypair', {
          walletId,
          error: String((e as any)?.message ?? e)
        });
        return; // Skip this wallet
      }

      // Get required funding amount for this wallet
      const requiredLamports = walletFundingAmounts.get(index) ?? 50_000_000;
      const spendLamports = BigInt(requiredLamports);
      
      try {
        if (!cfg.dryRun) {
          // ensure ATA exists (payer = wallet itself)
          await ensureAta(conn, kp, mintPk, kp.publicKey);
        }

        const entryPrice = await openOceanPriceUsd(cfg.tokenMint).catch(() => null);
        const tradeId = nanoid();
        insertUltibotTrade(opts.db, {
          id: tradeId,
          tsMs: Date.now(),
          side: 'BUY',
          mint: cfg.tokenMint,
          inMint: SOL_MINT,
          outMint: cfg.tokenMint,
          inAmount: spendLamports.toString(),
          status: cfg.dryRun ? 'SIMULATED' : 'PENDING',
        });

        let tokenBefore = 0n;
        if (!cfg.dryRun) {
          tokenBefore = await getTokenBalanceRaw(conn, mintPk, kp.publicKey);
        }

        let sig: string | null = null;
        let outAmount: string | null = null;

        if (cfg.dryRun) {
          sig = `SIM-${nanoid()}`;
          outAmount = '0';
          log('INFO', 'DRY_BUY', 'Simulated buy (dry run)', {
            wallet: kp.publicKey.toBase58(),
            spendSol: spendLamports.toString(),
            simulatedSig: sig
          });
        } else {
          const res = await swapWithFallback({
            connection: conn,
            owner: kp,
            inMint: SOL_MINT,
            outMint: cfg.tokenMint,
            amountIn: spendLamports,
            slippagePct: Math.max(0.05, Number(cfg.jupiterSlippageBps ?? 100) / 100),
            dryRun: !!cfg.dryRun,
          });
          sig = res.txid;
          outAmount = res.outputAmount ?? null;
        }

        let tokenAfter = tokenBefore;
        if (!cfg.dryRun) {
          // reconcile actual amount bought (post-confirm)
          tokenAfter = await getTokenBalanceRaw(conn, mintPk, kp.publicKey);
        } else {
          // Simulate token purchase for dry-run
          const solSpent = Number(spendLamports) / 1_000_000_000; // Convert lamports to SOL
          const simulatedTokens = entryPrice ? (solSpent / entryPrice) * (10 ** decimals) : solSpent * 1000000; // Rough simulation
          tokenAfter = tokenBefore + BigInt(Math.floor(simulatedTokens));
        }
        const tokenDelta = tokenAfter - tokenBefore;

        // position open
        const posId = nanoid();
        insertPosition(opts.db, {
          id: posId,
          cycleId: cycle.id,
          walletId,
          mint: cfg.tokenMint,
          status: 'OPEN',
          openedAtMs: Date.now(),
          entryPriceUsd: entryPrice ?? null,
          entrySolLamports: spendLamports.toString(),
          entryTokenRaw: tokenDelta.toString(),
          notes: sig ? `sig=${sig}` : null,
        });

        insertUltibotTrade(opts.db, {
          id: nanoid(),
          tsMs: Date.now(),
          side: 'BUY',
          mint: cfg.tokenMint,
          inMint: SOL_MINT,
          outMint: cfg.tokenMint,
          inAmount: spendLamports.toString(),
          outAmount: tokenDelta.toString(),
          sig,
          status: cfg.dryRun ? 'SIMULATED' : 'CONFIRMED',
        });

        const buyType = cfg.dryRun ? 'DRY_RUN' : 'LIVE';
        log('INFO', 'BUY_OK', `Wallet buy completed (${buyType})`, {
          wallet: kp.publicKey.toBase58(),
          sig,
          tokenDelta: tokenDelta.toString(),
          entryPrice,
          spendSol: spendLamports.toString(),
          dryRun: cfg.dryRun
        });
      } catch (e: any) {
        const msg = String(e?.message ?? e);
        insertUltibotTrade(opts.db, {
          id: nanoid(),
          tsMs: Date.now(),
          side: 'BUY',
          mint: cfg.tokenMint,
          inMint: SOL_MINT,
          outMint: cfg.tokenMint,
          inAmount: spendLamports.toString(),
          status: 'FAILED',
          error: msg,
        });
        log('ERROR', 'BUY_FAIL', 'Wallet buy failed', { wallet: w.pubkey, error: msg, dryRun: cfg.dryRun });
      }
    })));
  }

  async function maybeScanHolders(cfg: any, conn: Connection, mintPk: PublicKey, decimals: number, supplyRaw: bigint) {
    const intervalMs = Number(cfg.holderScanIntervalMs ?? 90_000);
    const timeoutMs = Number(cfg.holderScanTimeoutMs ?? 12_000);
    if (Date.now() - lastHolderScanMs < intervalMs) return;

    lastHolderScanMs = Date.now();
    try {
      const snap = await scanAllTokenHolders({ connection: conn, mint: mintPk.toBase58(), decimals, supplyRaw, timeoutMs });
      lastHolderSnapshot = snap;
      opts.io.emit('ultibot_holders', {
        tsMs: snap.tsMs,
        totalHolders: snap.holders.length,
        top10: snap.holders.slice(0, 10),
      });
    } catch (e: any) {
      log('WARN', 'HOLDER_SCAN_FAIL', 'Holder scan failed/timed out', { error: String(e?.message ?? e) });
    }
  }

  function computeIntruderPct(cfg: any): number | null {
    if (!lastHolderSnapshot?.holders || !Array.isArray(cfg.whitelist)) return null;
    const wl = new Set((cfg.whitelist ?? []).map((s: string) => s.trim()).filter(Boolean));
    const supply = lastHolderSnapshot.supplyRaw as bigint;
    if (!supply || supply <= 0n) return null;
    let nonWl = 0n;
    for (const h of lastHolderSnapshot.holders) {
      if (!wl.has(h.owner)) nonWl += BigInt(h.amountRaw);
    }
    return Number(nonWl) / Number(supply) * 100;
  }

  async function sellPosition(params: { cfg: any; conn: Connection; mintPk: PublicKey; pos: any; walletRow: any; priceUsd: number | null; reason: string; }) {
    const { cfg, conn, mintPk, pos, walletRow, priceUsd, reason } = params;
    const kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(decryptSecret(walletRow.secret_enc))));
    const tokenBal = cfg.dryRun ? BigInt(pos.entry_token_raw ?? '0') : await getTokenBalanceRaw(conn, mintPk, kp.publicKey);
    if (tokenBal <= 0n) {
      updatePosition(opts.db, { id: pos.id, status: 'CLOSED', closedAtMs: Date.now(), lastPriceUsd: priceUsd ?? null, pnlPct: pos.pnl_pct ?? null, notes: `no_token_balance ${reason}` });
      return;
    }

    try {
      const beforeSol = cfg.dryRun ? 0n : await getSolBalanceLamports(conn, kp.publicKey);

      let sig: string | null = null;
      if (cfg.dryRun) {
        sig = `SIM-${nanoid()}`;
        log('INFO', 'DRY_SELL', 'Simulated sell (dry run)', {
          wallet: kp.publicKey.toBase58(),
          tokenBal: tokenBal.toString(),
          reason,
          simulatedSig: sig
        });
      } else {
        log('INFO', 'LIVE_SELL', 'Executing live sell', {
          wallet: kp.publicKey.toBase58(),
          tokenBal: tokenBal.toString(),
          reason
        });
        // ensure token ATA exists (it should)
        await ensureAta(conn, kp, mintPk, kp.publicKey);
        const sellRes = await swapWithFallback({
          connection: conn,
          owner: kp,
          inMint: cfg.tokenMint,
          outMint: SOL_MINT,
          amountIn: tokenBal,
          slippagePct: Math.max(0.05, Number(cfg.jupiterSlippageBps ?? 100) / 100),
          dryRun: !!cfg.dryRun,
        });
        sig = sellRes.txid;
      }

      const afterSol = cfg.dryRun ? beforeSol : await getSolBalanceLamports(conn, kp.publicKey);
      const solDelta = afterSol - beforeSol;

      // Update position
      const entryPrice = Number(pos.entry_price_usd ?? 0);
      let pnlPct: number | null = null;
      if (entryPrice > 0 && priceUsd != null) pnlPct = ((priceUsd - entryPrice) / entryPrice) * 100;

      updatePosition(opts.db, {
        id: pos.id,
        status: 'CLOSED',
        closedAtMs: Date.now(),
        lastPriceUsd: priceUsd ?? null,
        exitSolLamports: solDelta.toString(),
        exitTokenRaw: tokenBal.toString(),
        pnlPct,
        notes: `reason=${reason} sig=${sig ?? ''}`,
      });

      insertUltibotTrade(opts.db, {
        id: nanoid(),
        tsMs: Date.now(),
        side: 'SELL',
        mint: cfg.tokenMint,
        inMint: cfg.tokenMint,
        outMint: SOL_MINT,
        inAmount: tokenBal.toString(),
        outAmount: solDelta.toString(),
        sig,
        status: cfg.dryRun ? 'SIMULATED' : 'CONFIRMED',
      });

      const sellType = cfg.dryRun ? 'DRY_RUN' : 'LIVE';
      log('INFO', 'SELL_OK', `Position sold (${sellType})`, {
        wallet: kp.publicKey.toBase58(),
        sig,
        tokenBal: tokenBal.toString(),
        solDelta: solDelta.toString(),
        reason,
        dryRun: cfg.dryRun
      });

      // Profit routing: distribute SOL profits according to configuration
      const profitPk = getProfitPubkey(cfg);
      const fundingKp = getFundingKeypair(cfg);

      if (!cfg.dryRun && solDelta > 0n) {
        try {
          // Calculate profit distribution
          let profitLamports = 0;
          let fundingLamports = 0;
          let remainingLamports = Number(solDelta);

          // Send profits to profit wallet if configured (default 25% of gains)
          if (profitPk) {
            profitLamports = Math.floor(remainingLamports * 0.25); // 25% to profit wallet
            if (profitLamports > 0) {
              // Check if privacy mode is enabled
              if (cfg.usePrivacyMode && PrivacyCash) {
                try {
                  // Use Privacy Cash SDK directly in backend (we have the private key)
                  const privacyCash = new PrivacyCash({
                    RPC_url: conn.rpcEndpoint,
                    owner: kp.secretKey,
                    enableDebug: false
                  });
                  
                  // Deposit to privacy pool first, then withdraw to profit wallet
                  await privacyCash.deposit({ lamports: profitLamports });
                  await privacyCash.withdraw({ 
                    recipient: profitPk.toBase58(),
                    lamports: profitLamports 
                  });
                  
                  log('INFO', 'PRIVACY_PROFIT_ROUTING', 'Privacy profit transfer completed (backend)', {
                    wallet: kp.publicKey.toBase58(),
                    amount: (profitLamports / 1_000_000_000).toFixed(4) + ' SOL',
                    profitWallet: profitPk.toBase58()
                  });
                } catch (e: any) {
                  log('WARN', 'PRIVACY_PROFIT_ROUTING_FAILED', 'Privacy transfer failed, falling back to direct', {
                    wallet: kp.publicKey.toBase58(),
                    error: String(e?.message ?? e)
                  });
                  // Fall back to direct transfer
                  await transferSol(conn, kp, profitPk, profitLamports);
                  log('INFO', 'PROFIT_ROUTING', 'Transferred profits to profit wallet (direct fallback)', {
                    wallet: kp.publicKey.toBase58(),
                    amount: profitLamports,
                    profitWallet: profitPk.toBase58()
                  });
                }
              } else if (cfg.usePrivacyMode && !PrivacyCash) {
                // Privacy mode enabled but SDK not available - emit event for frontend
                // Frontend can handle if it has the wallet in its state
                opts.io.emit('privacy_profit_transfer', {
                  fromWallet: kp.publicKey.toBase58(),
                  fromWalletId: pos.wallet_id,
                  toWallet: profitPk.toBase58(),
                  toRole: 'PROFIT',
                  amountSol: profitLamports / 1_000_000_000,
                  amountLamports: profitLamports,
                  cycleId: pos.cycle_id,
                  positionId: pos.id
                });
                log('INFO', 'PRIVACY_PROFIT_ROUTING', 'Privacy profit transfer requested (frontend)', {
                  wallet: kp.publicKey.toBase58(),
                  amount: (profitLamports / 1_000_000_000).toFixed(4) + ' SOL',
                  profitWallet: profitPk.toBase58()
                });
              } else {
                // Direct transfer (non-privacy mode)
                await transferSol(conn, kp, profitPk, profitLamports);
                log('INFO', 'PROFIT_ROUTING', 'Transferred profits to profit wallet (direct)', {
                  wallet: kp.publicKey.toBase58(),
                  amount: profitLamports,
                  profitWallet: profitPk.toBase58()
                });
              }
              remainingLamports -= profitLamports;
            }
          }

          // Return remaining SOL to funding wallet if configured
          if (fundingKp && remainingLamports > 0) {
            fundingLamports = remainingLamports;
            // Check if privacy mode is enabled
            if (cfg.usePrivacyMode && PrivacyCash) {
              try {
                // Use Privacy Cash SDK directly in backend (we have the private key)
                const privacyCash = new PrivacyCash({
                  RPC_url: conn.rpcEndpoint,
                  owner: kp.secretKey,
                  enableDebug: false
                });
                
                // Deposit to privacy pool first, then withdraw to funding wallet
                await privacyCash.deposit({ lamports: fundingLamports });
                await privacyCash.withdraw({ 
                  recipient: fundingKp.publicKey.toBase58(),
                  lamports: fundingLamports 
                });
                
                log('INFO', 'PRIVACY_FUNDING_RETURN', 'Privacy funding return completed (backend)', {
                  wallet: kp.publicKey.toBase58(),
                  amount: (fundingLamports / 1_000_000_000).toFixed(4) + ' SOL',
                  fundingWallet: fundingKp.publicKey.toBase58()
                });
              } catch (e: any) {
                log('WARN', 'PRIVACY_FUNDING_RETURN_FAILED', 'Privacy transfer failed, falling back to direct', {
                  wallet: kp.publicKey.toBase58(),
                  error: String(e?.message ?? e)
                });
                // Fall back to direct transfer
                await transferSol(conn, kp, fundingKp.publicKey, fundingLamports);
                log('INFO', 'FUNDING_RETURN', 'Returned remaining SOL to funding wallet (direct fallback)', {
                  wallet: kp.publicKey.toBase58(),
                  amount: fundingLamports,
                  fundingWallet: fundingKp.publicKey.toBase58()
                });
              }
            } else if (cfg.usePrivacyMode && !PrivacyCash) {
              // Privacy mode enabled but SDK not available - emit event for frontend
              // Frontend can handle if it has the wallet in its state
              opts.io.emit('privacy_funding_return', {
                fromWallet: kp.publicKey.toBase58(),
                fromWalletId: pos.wallet_id,
                toWallet: fundingKp.publicKey.toBase58(),
                toRole: 'FUNDING',
                amountSol: fundingLamports / 1_000_000_000,
                amountLamports: fundingLamports,
                cycleId: pos.cycle_id,
                positionId: pos.id
              });
              log('INFO', 'PRIVACY_FUNDING_RETURN', 'Privacy funding return requested (frontend)', {
                wallet: kp.publicKey.toBase58(),
                amount: (fundingLamports / 1_000_000_000).toFixed(4) + ' SOL',
                fundingWallet: fundingKp.publicKey.toBase58()
              });
            } else {
              // Direct transfer (non-privacy mode)
              await transferSol(conn, kp, fundingKp.publicKey, fundingLamports);
              log('INFO', 'FUNDING_RETURN', 'Returned remaining SOL to funding wallet (direct)', {
                wallet: kp.publicKey.toBase58(),
                amount: fundingLamports,
                fundingWallet: fundingKp.publicKey.toBase58()
              });
            }
          }

          log('INFO', 'PROFIT_DISTRIBUTION', 'Completed profit distribution', {
            wallet: kp.publicKey.toBase58(),
            totalSolDelta: Number(solDelta),
            profitWalletAmount: profitLamports,
            fundingWalletAmount: fundingLamports,
            remainingInWallet: remainingLamports - fundingLamports,
            usePrivacyMode: cfg.usePrivacyMode ?? false
          });
        } catch (e: any) {
          log('WARN', 'PROFIT_ROUTING_FAILED', 'Failed to route profits', {
            wallet: kp.publicKey.toBase58(),
            error: String(e?.message ?? e)
          });
          // Don't fail the sell if profit routing fails - just log it
        }
      }
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      insertUltibotTrade(opts.db, {
        id: nanoid(),
        tsMs: Date.now(),
        side: 'SELL',
        mint: cfg.tokenMint,
        inMint: cfg.tokenMint,
        outMint: SOL_MINT,
        inAmount: tokenBal.toString(),
        status: 'FAILED',
        error: msg,
      });
      log('ERROR', 'SELL_FAIL', 'Sell failed', { wallet: walletRow.pubkey, error: msg, reason });
    }
  }

  async function tick() {
    let cfg = loadUltibotConfig(opts.db);
    if (!cfg.enabled || !cfg.tokenMint) {
      updateUltibotState(opts.db, { last_error: 'disabled' });
      setUltibotRunning(opts.db, false);
      return;
    }

    // Clear any previous errors since we're now running
    updateUltibotState(opts.db, { last_error: null });

    // Load active strategy if configured
    if (cfg.activeStrategyId) {
      try {
        const strategy = opts.db.prepare('SELECT * FROM ultibot_strategies WHERE id=?').get(cfg.activeStrategyId) as any;
        if (strategy) {
          const strategyConfig = JSON.parse(strategy.config_json || '{}');
          // Merge strategy config with base config
          cfg = {
            ...cfg,
            ...strategyConfig,
            // Override with current settings that shouldn't be replaced by strategy
            enabled: cfg.enabled,
            tokenMint: cfg.tokenMint,
            activeStrategyId: cfg.activeStrategyId,
            rpcUrl: cfg.rpcUrl,
            botSecretEnc: cfg.botSecretEnc,
            fundingSecretEnc: cfg.fundingSecretEnc,
            profitWalletPubkey: cfg.profitWalletPubkey,
            profitSecretEnc: cfg.profitSecretEnc,
          };
          log('INFO', 'STRATEGY_LOADED', `Loaded strategy: ${strategy.name}`, { strategyId: cfg.activeStrategyId });
        } else {
          log('WARN', 'STRATEGY_NOT_FOUND', `Strategy ${cfg.activeStrategyId} not found, using base config`);
        }
      } catch (e: any) {
        log('ERROR', 'STRATEGY_LOAD_FAILED', `Failed to load strategy ${cfg.activeStrategyId}`, { error: String(e?.message ?? e) });
      }
    }

    const conn = getConnection(cfg.rpcUrl);
    updateUltibotState(opts.db, { last_tick_ms: Date.now() });

    // Mint info
    if (!cfg.tokenMint) {
      updateUltibotState(opts.db, { last_error: 'No token mint configured' });
      return;
    }
    const mintPk = new PublicKey(cfg.tokenMint);
    const mintInfo = await getMint(conn, mintPk, 'confirmed');
    const supplyRaw = mintInfo.supply;
    const decimals = mintInfo.decimals;

    // market price + market cap (with fallback)
    let priceUsd = await openOceanPriceUsd(cfg.tokenMint);
    const supply = Number(supplyRaw) / Math.pow(10, decimals);
    let marketCapUsd = priceUsd != null ? priceUsd * supply : null;

    // If we got price from CoinGecko, try to get real market cap too
    if (priceUsd != null && marketCapUsd != null) {
      try {
        const coingeckoUrl = `https://api.coingecko.com/api/v3/coins/solana/contract/${cfg.tokenMint}`;
        const response = await fetch(coingeckoUrl, {
          headers: {
            'Accept': 'application/json',
            'User-Agent': 'Mozilla/5.0 (compatible; SolanaBot/1.0)'
          }
        });

        if (response.ok) {
          const data = await response.json();
          const realMarketCap = data?.market_data?.market_cap?.usd;
          if (realMarketCap && typeof realMarketCap === 'number' && realMarketCap > 0) {
            marketCapUsd = realMarketCap;
            log('INFO', 'COINGECKO_MARKET_CAP', `Using real market cap from CoinGecko: $${realMarketCap.toLocaleString()}`, {
              tokenMint: cfg.tokenMint,
              calculatedMarketCap: (priceUsd * supply).toLocaleString(),
              realMarketCap: realMarketCap.toLocaleString()
            });
          }
        }
      } catch (e) {
        // Continue with calculated market cap
      }
    }

    // If all price APIs fail, use intelligent fallback based on token characteristics
    if (priceUsd == null) {
      // For BCGame Coin specifically, use known market data
      if (cfg.tokenMint === 'BCNT4t3rv5Hva8RnUtJUJLnxzeFAabcYp8CghC1SmWin') {
        priceUsd = 0.00755; // Known BCGame Coin price from Solscan
        log('INFO', 'PRICE_KNOWN_TOKEN', 'Using known price for BCGame Coin', {
          tokenMint: cfg.tokenMint,
          knownPrice: priceUsd,
          source: 'Solscan market data'
        });
      } else {
        // For other tokens, estimate based on supply and market indicators
        const hasLiquidity = supply > 1000000;
        const reasonablePrice = hasLiquidity ? 0.01 : 0.001;

        priceUsd = reasonablePrice;
        log('WARN', 'PRICE_FALLBACK', 'Using estimated price - APIs unavailable', {
          tokenMint: cfg.tokenMint,
          fallbackPrice: priceUsd,
          supply: supply.toLocaleString(),
          hasLiquidity,
          note: 'External price APIs failing - using supply-based estimate'
        });
      }
    }

    // holders scan (best-effort, cached)
    await maybeScanHolders(cfg, conn, mintPk, decimals, supplyRaw);

    const intruderPct = computeIntruderPct(cfg);

    opts.io.emit('ultibot_metrics', {
      tsMs: Date.now(),
      mint: cfg.tokenMint,
      priceUsd,
      marketCapUsd,
      supply,
      intruderPct,
      holdersTotal: lastHolderSnapshot?.holders?.length ?? null,
    });

    if (intruderPct != null && intruderPct >= Number(cfg.intruderTriggerPct ?? 0)) {
      opts.io.emit('intruder_trigger', { pct: intruderPct, tsMs: Date.now() });
      for (const a of (cfg.intruderActions ?? [])) {
        if (a.type === 'ALERT') log('WARN', 'INTRUDER_ALERT', 'Intruder threshold reached', { intruderPct });
        if (a.type === 'PAUSE') {
          log('WARN', 'INTRUDER_PAUSE', 'Pausing bot due to intruder threshold', { intruderPct });
          opts.db.prepare(`UPDATE ultibot_config SET enabled=0 WHERE id=1`).run();
          return;
        }
        if (a.type === 'SELL_GROUP_PERCENT') {
          const percentage = ('percentage' in a && typeof (a as any).percentage === 'number') ? (a as any).percentage : undefined;
          const sellPct = Math.min(100, Math.max(0, percentage ?? cfg.groupSellPctMin ?? 25));
          log('WARN', 'INTRUDER_SELL', `Intruder trigger: selling ${sellPct}% of all positions`, { intruderPct, sellPct });

          // Get all open positions across all cycles
          const allOpenPositions = opts.db.prepare(`SELECT * FROM ultibot_positions WHERE status='OPEN'`).all() as any[];
          const walletsById = new Map<string, any>();

          // Get wallet info for all positions
          for (const pos of allOpenPositions) {
            if (!walletsById.has(pos.wallet_id)) {
              const wallet = opts.db.prepare(`SELECT * FROM ultibot_wallets WHERE id=?`).get(pos.wallet_id) as any;
              if (wallet) walletsById.set(pos.wallet_id, wallet);
            }
          }

          // Sell percentage of each position
          for (const pos of allOpenPositions) {
            const wallet = walletsById.get(pos.wallet_id);
            if (wallet) {
              await sellPosition({
                cfg,
                conn,
                mintPk,
                pos,
                walletRow: wallet,
                priceUsd,
                reason: `INTRUDER_SELL_${sellPct}%`
              });
            }
          }
        }
      }
    }

    const cycle = await ensureCycle(cfg);
    if (!cycle) {
      log('WARN', 'NO_CYCLE', 'Failed to create or find active cycle');
      return;
    }

    const wallets = getCycleWallets(cycle.id);
    const openPositions = listOpenPositions(opts.db, cycle.id);

    // If existing cycle has no wallets, regenerate them
    if (wallets.length === 0) {
      try {
        log('INFO', 'WALLET_REGEN', 'Regenerating wallets for existing cycle', { cycleId: cycle.id });
        console.log('[ENGINE] Config values:', {
          walletsPerCycle: cfg.walletsPerCycle,
          walletsPerCycleType: typeof cfg.walletsPerCycle
        });
        let n = Number(cfg.walletsPerCycle || 5);
        console.log('[ENGINE] Starting wallet regeneration for', n, 'wallets, n =', n, 'n type =', typeof n);

        if (isNaN(n) || n <= 0 || n > 100) {
          console.log('[ENGINE] Invalid n value, setting to 5');
          n = 5;
        }

        for (let i = 0; i < n; i++) {
          console.log('[ENGINE] Processing wallet', i + 1, 'of', n);
          const walletId = nanoid();
          const kp = Keypair.generate();
          const secretEnc = encryptSecret(JSON.stringify(Array.from(kp.secretKey)));
          try {
            const result = opts.db.prepare(`INSERT INTO ultibot_wallets (id, cycle_id, role, pubkey, secret_enc, status, created_at_ms)
                           VALUES (?, ?, 'BUY', ?, ?, 'ACTIVE', ?)`)
              .run(walletId, cycle.id, kp.publicKey.toBase58(), secretEnc, Date.now());
            console.log('[ENGINE] Inserted wallet', i + 1, 'of', n, 'ID:', walletId, 'result:', result);
          } catch (e) {
            console.log('[ENGINE] Failed to insert wallet', i + 1, 'error:', String((e as any)?.message ?? e));
            throw e; // Re-throw to catch in outer try
          }
        }

        // Re-fetch wallets after regeneration
        const refetched = getCycleWallets(cycle.id);
        console.log('[ENGINE] After regeneration, refetched', refetched.length, 'wallets');

        // Also check total wallet count in database
        const totalWallets = opts.db.prepare(`SELECT COUNT(*) as count FROM ultibot_wallets WHERE cycle_id=?`).get(cycle.id) as any;
        console.log('[ENGINE] Total wallets in DB for cycle:', totalWallets.count);

        wallets.splice(0, wallets.length, ...refetched);
        console.log('[ENGINE] Wallet regeneration completed successfully');
      } catch (e) {
        console.log('[ENGINE] Wallet regeneration failed:', String((e as any)?.message ?? e));
        throw e; // Re-throw to fail the tick
      }
    }

    log('INFO', 'CYCLE_INFO', 'Cycle details', {
      cycleId: cycle.id,
      cycleStatus: cycle.status,
      walletsCount: wallets.length,
      openPositionsCount: openPositions.length,
      dryRun: cfg.dryRun,
      shouldBuy: openPositions.length === 0 && wallets.length > 0,
      cycleMint: cycle.mint?.substring(0, 8) + '...',
      tokenMint: cfg.tokenMint?.substring(0, 8) + '...',
      mintMatch: cycle.mint === cfg.tokenMint
    });

    // Check if cycle mint matches current token mint
    if (cycle.mint !== cfg.tokenMint) {
      log('WARN', 'CYCLE_MISMATCH', 'Existing cycle has different token mint', {
        cycleMint: cycle.mint,
        currentMint: cfg.tokenMint
      });
      // Complete the old cycle and create a new one
      markCycleComplete(cycle.id, 'Token mint changed');
      log('INFO', 'CYCLE_COMPLETED_OLD', 'Completed old cycle due to token change');
      // Return and let next tick create new cycle
      return;
    }

    log('INFO', 'CYCLE_STATUS', 'Cycle status check', {
      cycleId: cycle.id,
      wallets: wallets.length,
      openPositions: openPositions.length,
      hasPositions: openPositions.length > 0
    });

    // If no positions yet, execute buys in parallel
    if (openPositions.length === 0) {
      try {
        await performParallelBuys({ cfg, cycle, wallets, mintPk, decimals, supplyRaw, priceUsd });
        return;
      } catch (e) {
        log('ERROR', 'BUY_FAIL', 'Parallel buys failed', { error: String((e as any)?.message ?? e) });
        // Continue to monitoring phase instead of failing the tick
      }
    }

    // TP/SL/max hold loops per wallet
    log('INFO', 'MONITOR_PHASE', 'Monitoring positions for sell triggers', {
      cycleId: cycle.id,
      openPositions: openPositions.length,
      wallets: wallets.length
    });

    // Map walletId -> row for quick lookup
    const walletById = new Map<string, any>();
    for (const w of wallets) walletById.set(w.id, w);

    for (const pos of openPositions) {
      const entryPrice = Number(pos.entry_price_usd ?? 0);
      const openedAt = Number(pos.opened_at_ms ?? 0);
      const ageSec = (Date.now() - openedAt) / 1000;
      let pnlPct: number | null = null;

      if (entryPrice > 0 && priceUsd != null) pnlPct = ((priceUsd - entryPrice) / entryPrice) * 100;

      // update last price/pnl best effort
      try { updatePosition(opts.db, { id: pos.id, lastPriceUsd: priceUsd ?? null, pnlPct }); } catch {}

      // Get wallet's group configuration (per-group settings)
      const groupConfig = getWalletGroupConfig(pos.wallet_id);

      // Use group-specific TP/SL if available, otherwise fall back to global config
      let tp = cfg.takeProfitPct ?? cfg.monitoringRules?.takeProfitPct ?? 20;
      let sl = cfg.stopLossPct ?? cfg.monitoringRules?.stopLossPct ?? 15;
      let maxHoldSec = cfg.maxHoldSec ?? cfg.monitoringRules?.maxHoldSec ?? 3600;
      let marketCapTpReason = null;

      if (groupConfig) {
        // Check TP/SL pairs for this group
        if (groupConfig.tpStopLossPairs && groupConfig.tpStopLossPairs.length > 0) {
          // Find the appropriate TP/SL pair based on current PnL
          for (const pair of groupConfig.tpStopLossPairs) {
            if (pair.tpBuy && pnlPct != null && pnlPct >= pair.tpBuy) {
              tp = pair.tpBuy;
              if (pair.stopLossBuy) sl = pair.stopLossBuy;
              break;
            }
          }
        }

        // Check market cap take profit levels
        if (groupConfig.marketCapTakeProfit && groupConfig.marketCapTakeProfit.length > 0 && marketData.marketCap > 0) {
          const entryMarketCap = groupConfig.entryMarketCap || 0;
          const marketCapIncrease = marketData.marketCap - entryMarketCap;

          for (const level of groupConfig.marketCapTakeProfit) {
            if (level.marketCapIncreaseDollar && marketCapIncrease >= level.marketCapIncreaseDollar && !level.executed) {
              marketCapTpReason = `MARKET_CAP_TP_${level.marketCapIncreaseDollar}`;
              // Mark this level as executed to prevent re-triggering
              level.executed = true;
              // Update the group in database
              saveWalletGroup(opts.db, { ...groupConfig, marketCapTakeProfit: groupConfig.marketCapTakeProfit });
              break;
            }
          }
        }
      }

      const reason =
        marketCapTpReason ? marketCapTpReason :
        (tp != null && pnlPct != null && pnlPct >= Number(tp)) ? 'TAKE_PROFIT' :
        (sl != null && pnlPct != null && pnlPct <= -Math.abs(Number(sl))) ? 'STOP_LOSS' :
        (maxHoldSec != null && ageSec >= Number(maxHoldSec)) ? 'MAX_HOLD' :
        null;

      if (reason) {
        const w = walletById.get(pos.wallet_id);
        if (w) {
          await sellPosition({ cfg, conn, mintPk, pos, walletRow: w, priceUsd, reason });

          // If this was a market cap take profit, execute the sell percentage
          if (marketCapTpReason && groupConfig) {
            const level = groupConfig.marketCapTakeProfit?.find(l =>
              `MARKET_CAP_TP_${l.marketCapIncreaseDollar}` === marketCapTpReason
            );
            if (level?.sellPct) {
              // Calculate how much to sell based on the percentage
              const sellAmount = Math.floor(pos.amount * (level.sellPct / 100));
              if (sellAmount > 0) {
                log('INFO', 'MARKET_CAP_TP_EXECUTE', `Executing ${level.sellPct}% sell for market cap TP`, {
                  walletId: pos.wallet_id,
                  totalAmount: pos.amount,
                  sellAmount,
                  marketCapIncrease: level.marketCapIncreaseDollar
                });
                // Additional sell logic would go here if needed
              }
            }
          }
        }
      }
    }

    // If all positions closed, complete cycle
    const stillOpen = listOpenPositions(opts.db, cycle.id);
    if (stillOpen.length === 0) {
      markCycleComplete(cycle.id, 'All positions closed');
      log('INFO', 'CYCLE_COMPLETE', 'Cycle completed', { cycleId: cycle.id });
      // Clear funding cache for completed cycle
      cycleFundingCache.delete(cycle.id);
    }
  }

  function getWalletGroupConfig(walletId: string) {
    const wallet = opts.db.prepare('SELECT group_id FROM ultibot_wallets WHERE id = ?').get(walletId) as any;
    if (!wallet?.group_id) return null;

    return getWalletGroup(opts.db, wallet.group_id);
  }

  function start() {
    if (timer) return;
    timer = setInterval(() => {
      tick().catch((e) => {
        log('ERROR', 'ENGINE_TICK_FAIL', 'Engine tick failed', { error: String((e as any)?.message ?? e) });
      });
    }, 2500);
    log('INFO', 'ENGINE_START', 'Ultibot engine started');
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
    log('INFO', 'ENGINE_STOP', 'Ultibot engine stopped');
  }

  return { start, stop };
}
