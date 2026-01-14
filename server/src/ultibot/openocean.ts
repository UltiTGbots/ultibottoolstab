import {
  Connection,
  Keypair,
  PublicKey,
  VersionedTransaction,
} from '@solana/web3.js';
import bs58 from 'bs58';

type SwapResult = {
  txid: string;
  inputAmount: string;
  outputAmount: string;
  routeLabel?: string;
};

function getOpenOceanBaseUrl(): string {
  // OpenOcean Swap API base URL as per docs.
  return process.env.OPENOCEAN_BASE_URL || 'https://open-api.openocean.finance';
}

function getOpenOceanApiKey(): string | undefined {
  const k = process.env.OPENOCEAN_API_KEY;
  return k && k.trim().length ? k.trim() : undefined;
}

function pickFirst<T>(...candidates: Array<T | undefined | null>): T | undefined {
  for (const c of candidates) {
    if (c !== undefined && c !== null) return c as T;
  }
  return undefined;
}

function extractSwapTxBase64(resp: any): string | undefined {
  // OpenOcean responses vary by chain/version. Try common fields.
  const d = resp?.data ?? resp;
  return pickFirst<string>(
    d?.tx,
    d?.transaction,
    d?.swapTransaction,
    d?.data?.tx,
    d?.data?.transaction,
    d?.data?.swapTransaction,
    d?.result?.tx,
    d?.result?.transaction,
    d?.result?.swapTransaction,
  );
}

function extractQuoteAmounts(resp: any): { inAmount?: string; outAmount?: string } {
  const d = resp?.data ?? resp;
  const inAmount = pickFirst<string>(d?.inAmount, d?.data?.inAmount, d?.result?.inAmount);
  const outAmount = pickFirst<string>(d?.outAmount, d?.data?.outAmount, d?.result?.outAmount);
  return { inAmount, outAmount };
}

async function ooFetchJson(url: string): Promise<any> {
  const apiKey = getOpenOceanApiKey();
  const res = await fetch(url, {
    headers: {
      ...(apiKey ? { apikey: apiKey } : {}),
      // Some gateways use x-api-key
      ...(apiKey ? { 'x-api-key': apiKey } : {}),
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`OpenOcean HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
  return res.json();
}

export async function openOceanQuote(params: {
  inMint: string;
  outMint: string;
  amountIn: string; // token-base units
  slippagePct: number; // e.g. 1 = 1%
}): Promise<{ inAmount: string; outAmount: string; raw: any }> {
  const base = getOpenOceanBaseUrl();
  // Docs show /v4/:chain/quote. For Solana we use chain=solana.
  const url = new URL(`${base}/v4/solana/quote`);
  url.searchParams.set('inTokenAddress', params.inMint);
  url.searchParams.set('outTokenAddress', params.outMint);
  url.searchParams.set('amountDecimals', params.amountIn);
  // gasPriceDecimals is required by generic v4; for Solana it is ignored but some gateways still validate.
  url.searchParams.set('gasPriceDecimals', '0');
  url.searchParams.set('slippage', String(params.slippagePct));

  const json = await ooFetchJson(url.toString());
  const { inAmount, outAmount } = extractQuoteAmounts(json);
  if (!inAmount || !outAmount) {
    throw new Error(`OpenOcean quote missing amounts. Response keys: ${Object.keys(json || {}).join(',')}`);
  }
  return { inAmount, outAmount, raw: json };
}

export async function openOceanSwap(params: {
  connection: Connection;
  owner: Keypair;
  inMint: string;
  outMint: string;
  amountIn: string; // token-base units
  slippagePct: number;
  dryRun?: boolean;
}): Promise<SwapResult> {
  const base = getOpenOceanBaseUrl();
  const url = new URL(`${base}/v4/solana/swap`);
  url.searchParams.set('inTokenAddress', params.inMint);
  url.searchParams.set('outTokenAddress', params.outMint);
  url.searchParams.set('amountDecimals', params.amountIn);
  url.searchParams.set('gasPriceDecimals', '0');
  url.searchParams.set('slippage', String(params.slippagePct));
  url.searchParams.set('account', params.owner.publicKey.toBase58());

  const json = await ooFetchJson(url.toString());
  const txB64 = extractSwapTxBase64(json);
  const { inAmount, outAmount } = extractQuoteAmounts(json);
  if (!txB64) {
    throw new Error(`OpenOcean swap response missing transaction body. Response keys: ${Object.keys(json || {}).join(',')}`);
  }

  if (params.dryRun) {
    return {
      txid: `SIMULATED_${Date.now()}`,
      inputAmount: inAmount || params.amountIn,
      outputAmount: outAmount || '0',
      routeLabel: 'openocean',
    };
  }

  const tx = VersionedTransaction.deserialize(Buffer.from(txB64, 'base64'));
  tx.sign([params.owner]);

  const sig = await params.connection.sendRawTransaction(tx.serialize(), {
    skipPreflight: false,
    maxRetries: 3,
  });

  const latest = await params.connection.getLatestBlockhash('confirmed');
  await params.connection.confirmTransaction(
    {
      signature: sig,
      blockhash: latest.blockhash,
      lastValidBlockHeight: latest.lastValidBlockHeight,
    },
    'confirmed',
  );

  return {
    txid: sig,
    inputAmount: inAmount || params.amountIn,
    outputAmount: outAmount || '0',
    routeLabel: 'openocean',
  };
}

export async function openOceanPriceUsd(mint: string): Promise<number | null> {
  // Best-effort price discovery:
  // 1) Try CoinGecko API (most accurate for listed tokens)
  // 2) Try Jupiter price API
  // 3) Try OpenOcean token list endpoint
  // 4) Try Raydium pool price calculation
  // 5) If all fail, return null

  // Try CoinGecko API first (most accurate for real market data)
  try {
    const coingeckoUrl = `https://api.coingecko.com/api/v3/coins/solana/contract/${mint}`;
    const response = await fetch(coingeckoUrl, {
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'Mozilla/5.0 (compatible; SolanaBot/1.0)'
      }
    });

    if (response.ok) {
      const data = await response.json();
      const price = data?.market_data?.current_price?.usd;
      if (price && typeof price === 'number' && price > 0) {
        const marketCap = data?.market_data?.market_cap?.usd;
        console.log(`CoinGecko: Found price for ${mint}: $${price.toFixed(6)}, Market Cap: $${marketCap?.toLocaleString() || 'N/A'}`);
        return price;
      }
    }
  } catch (e) {
    console.warn('CoinGecko API failed:', e.message);
  }

  // Try Jupiter API
  try {
    const jupiterUrl = `https://price.jup.ag/v4/price?ids=${mint}`;
    const response = await fetch(jupiterUrl);
    if (response.ok) {
      const data = await response.json();
      const price = data?.data?.[mint]?.price;
      if (price && typeof price === 'number' && price > 0) {
        console.log(`Jupiter: Found price for ${mint}: $${price.toFixed(6)}`);
        return price;
      }
    }
  } catch (e) {
    console.warn('Jupiter price API failed:', e.message);
  }

  // Try OpenOcean
  try {
    const base = getOpenOceanBaseUrl();
    const url = new URL(`${base}/v4/solana/tokenList`);
    const json = await ooFetchJson(url.toString());
    const list: any[] = json?.data ?? json?.result ?? [];
    const hit = list.find((t) => String(t?.address).toLowerCase() === mint.toLowerCase());
    const usd = hit?.usd;
    const n = usd !== undefined ? Number(usd) : NaN;
    if (Number.isFinite(n)) return n;
  } catch (e) {
    // OpenOcean failed, continue to Raydium fallback
  }

  // Try Raydium price calculation
  try {
    return await raydiumPriceUsd(mint);
  } catch (e) {
    // All price discovery methods failed
    console.warn(`All price discovery methods failed for token ${mint}`);
    return null;
  }
}

export async function raydiumPriceUsd(mint: string): Promise<number | null> {
  try {
    const SOL_MINT = 'So11111111111111111111111111111111111111112';

    const poolsJson = await getRaydiumPools();
    if (!poolsJson) return null;

    const pools = [...(poolsJson?.official ?? []), ...(poolsJson?.unOfficial ?? [])];
    if (!pools || pools.length === 0) return null;

    const solLower = SOL_MINT.toLowerCase();
    const tokenLower = mint.toLowerCase();

    // Find pool with SOL-token pair
    const poolInfo = pools.find((p: any) => {
      if (!p || !p.baseMint || !p.quoteMint) return false;
      const a = String(p.baseMint).toLowerCase();
      const b = String(p.quoteMint).toLowerCase();
      return (a === solLower && b === tokenLower) || (a === tokenLower && b === solLower);
    });

    if (!poolInfo) {
      console.log(`Raydium: No pool found for token ${mint}`);
      return null;
    }

    // Calculate price from pool reserves
    const solReserve = poolInfo.baseMint.toLowerCase() === solLower ? Number(poolInfo.baseReserve) : Number(poolInfo.quoteReserve);
    const tokenReserve = poolInfo.baseMint.toLowerCase() === tokenLower ? Number(poolInfo.baseReserve) : Number(poolInfo.quoteReserve);

    const solDecimals = poolInfo.baseMint.toLowerCase() === solLower ? poolInfo.baseDecimals : poolInfo.quoteDecimals;
    const tokenDecimals = poolInfo.baseMint.toLowerCase() === tokenLower ? poolInfo.baseDecimals : poolInfo.quoteDecimals;

    if (solReserve <= 0 || tokenReserve <= 0 || !solDecimals || !tokenDecimals) {
      console.log(`Raydium: Invalid reserves for token ${mint}:`, { solReserve, tokenReserve, solDecimals, tokenDecimals });
      return null;
    }

    // Normalize reserves to same decimal places
    const solAmount = solReserve / Math.pow(10, solDecimals);
    const tokenAmount = tokenReserve / Math.pow(10, tokenDecimals);

    if (tokenAmount === 0) return null;

    // Price = SOL amount / Token amount (SOL per token)
    const solPerToken = solAmount / tokenAmount;

    // Get SOL USD price (use a reasonable current price)
    const solPriceUsd = 124; // Current SOL price, can be improved

    // Token price in USD = SOL per token * SOL price in USD
    const tokenPriceUsd = solPerToken * solPriceUsd;

    console.log(`Raydium: Found price for ${mint}: $${tokenPriceUsd.toFixed(6)} (${solPerToken.toFixed(8)} SOL per token)`);

    return tokenPriceUsd > 0 ? tokenPriceUsd : null;

  } catch (error) {
    console.warn('Raydium price discovery failed:', error.message);
    return null;
  }
}

/**
 * Minimal "on-chain SDK" fallback
 *
 * If OpenOcean API is unavailable, we attempt a direct Raydium swap using @raydium-io/raydium-sdk
 * for SOL <-> Token pairs when a matching pool can be found from Raydium public pool list.
 *
 * This fallback is best-effort and intentionally limited to keep complexity and cost low.
 */

let raydiumPoolsCache: { ts: number; pools: any } | null = null;

async function getRaydiumPools(): Promise<any> {
  const now = Date.now();
  if (raydiumPoolsCache && now - raydiumPoolsCache.ts < 60_000) return raydiumPoolsCache.pools;
  const res = await fetch('https://api.raydium.io/v2/sdk/liquidity/mainnet.json');
  if (!res.ok) throw new Error(`Raydium poollist HTTP ${res.status}`);
  const json = await res.json();
  raydiumPoolsCache = { ts: now, pools: json };
  return json;
}

export async function raydiumFallbackSwap(params: {
  connection: Connection;
  owner: Keypair;
  inMint: string;
  outMint: string;
  amountIn: bigint;
  slippagePct: number;
  dryRun?: boolean;
}): Promise<SwapResult> {
  // Lazy import to avoid requiring raydium sdk unless fallback is used.
  const raydium = await import('@raydium-io/raydium-sdk');
  const { Liquidity, Percent, Token, TokenAmount, TOKEN_PROGRAM_ID, jsonInfo2PoolKeys } = raydium as any;

  const poolsJson = await getRaydiumPools();
  const pools = [...(poolsJson?.official ?? []), ...(poolsJson?.unOfficial ?? [])];

  const inLower = params.inMint.toLowerCase();
  const outLower = params.outMint.toLowerCase();
  const poolInfo = pools.find((p: any) => {
    const a = String(p.baseMint).toLowerCase();
    const b = String(p.quoteMint).toLowerCase();
    return (a === inLower && b === outLower) || (a === outLower && b === inLower);
  });

  if (!poolInfo) throw new Error('Raydium fallback: no matching pool found');
  const poolKeys = jsonInfo2PoolKeys(poolInfo);

  // Fetch minimal pool state
  const poolState = await Liquidity.fetchInfo({ connection: params.connection, poolKeys });

  const inDecimals = poolInfo.baseMint.toLowerCase() === inLower ? poolInfo.baseDecimals : poolInfo.quoteDecimals;
  const outDecimals = poolInfo.baseMint.toLowerCase() === outLower ? poolInfo.baseDecimals : poolInfo.quoteDecimals;

  const inToken = new Token(TOKEN_PROGRAM_ID, new PublicKey(params.inMint), inDecimals);
  const outToken = new Token(TOKEN_PROGRAM_ID, new PublicKey(params.outMint), outDecimals);

  const amountIn = new TokenAmount(inToken, params.amountIn.toString());
  const slippage = new Percent(Math.round(params.slippagePct * 100), 10000); // pct to basis

  const { amountOut } = Liquidity.computeAmountOut({ poolKeys, poolInfo: poolState, amountIn, currencyOut: outToken, slippage });

  if (params.dryRun) {
    return {
      txid: `SIMULATED_RAYDIUM_${Date.now()}`,
      inputAmount: amountIn.raw.toString(),
      outputAmount: amountOut.raw.toString(),
      routeLabel: 'raydium_fallback',
    };
  }

  const { innerTransactions } = await Liquidity.makeSwapInstructionSimple({
    connection: params.connection,
    poolKeys,
    userKeys: {
      tokenAccounts: await raydium.Token.getAssociatedTokenAddress({
        mint: inToken.mint,
        owner: params.owner.publicKey,
      }).then((ata: any) => [{ pubkey: ata, mint: inToken.mint }]).catch(() => []),
      owner: params.owner.publicKey,
    },
    amountIn,
    amountOut,
    fixedSide: 'in',
  });

  // Build + send (single tx)
  const tx = new raydium.Transaction();
  for (const itx of innerTransactions) {
    for (const ix of itx.instructions) tx.add(ix);
  }
  tx.feePayer = params.owner.publicKey;
  const latest = await params.connection.getLatestBlockhash('confirmed');
  tx.recentBlockhash = latest.blockhash;
  tx.sign(params.owner);

  const sig = await params.connection.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 3 });
  await params.connection.confirmTransaction({ signature: sig, blockhash: latest.blockhash, lastValidBlockHeight: latest.lastValidBlockHeight }, 'confirmed');

  return {
    txid: sig,
    inputAmount: amountIn.raw.toString(),
    outputAmount: amountOut.raw.toString(),
    routeLabel: 'raydium_fallback',
  };
}

export async function swapWithFallback(params: {
  connection: Connection;
  owner: Keypair;
  inMint: string;
  outMint: string;
  amountIn: bigint;
  slippagePct: number;
  dryRun?: boolean;
}): Promise<SwapResult> {
  // 1) OpenOcean (preferred)
  let openOceanError: any = null;
  try {
    return await openOceanSwap({
      connection: params.connection,
      owner: params.owner,
      inMint: params.inMint,
      outMint: params.outMint,
      amountIn: params.amountIn.toString(),
      slippagePct: params.slippagePct,
      dryRun: params.dryRun,
    });
  } catch (e) {
    openOceanError = e;
    console.warn(`[swapWithFallback] OpenOcean swap failed, trying Raydium fallback:`, {
      error: String(e?.message || e),
      inMint: params.inMint,
      outMint: params.outMint,
      amountIn: params.amountIn.toString(),
    });
  }
  
  // 2) Raydium on-chain SDK fallback (limited)
  try {
    return await raydiumFallbackSwap({
      connection: params.connection,
      owner: params.owner,
      inMint: params.inMint,
      outMint: params.outMint,
      amountIn: params.amountIn,
      slippagePct: params.slippagePct,
      dryRun: params.dryRun,
    });
  } catch (e) {
    const errorMsg = `Both OpenOcean and Raydium swaps failed. OpenOcean: ${String(openOceanError?.message || openOceanError)}, Raydium: ${String(e?.message || e)}`;
    console.error(`[swapWithFallback] All swap methods failed:`, errorMsg);
    throw new Error(errorMsg);
  }
}
