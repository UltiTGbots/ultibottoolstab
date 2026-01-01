
import { Connection, PublicKey } from '@solana/web3.js';

export type HolderBalance = { owner: string; amountRaw: bigint; pct?: number };
export type HolderSnapshot = {
  mint: string;
  decimals: number;
  supplyRaw: bigint;
  tsMs: number;
  holders: HolderBalance[]; // sorted desc by amount
};

/**
 * As accurate as possible without external indexing:
 * - Uses getProgramAccounts with a memcmp filter on mint (Token Program)
 * - dataSlice reads only owner(32) + amount(8) to reduce payload
 *
 * This can still be heavy for very popular mints; use with a longer interval and a timeout.
 */
export async function scanAllTokenHolders(params: {
  connection: Connection;
  mint: string;
  tokenProgramId?: string;
  decimals: number;
  supplyRaw: bigint;
  timeoutMs?: number;
}): Promise<HolderSnapshot> {
  const { connection, mint, decimals, supplyRaw } = params;
  const tokenProgram = new PublicKey(params.tokenProgramId ?? 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
  const mintPk = new PublicKey(mint);

  const start = Date.now();
  const timeoutMs = params.timeoutMs ?? 15000;

  const p = connection.getProgramAccounts(tokenProgram, {
    commitment: 'confirmed',
    filters: [{ memcmp: { offset: 0, bytes: mintPk.toBase58() } }],
    dataSlice: { offset: 32, length: 40 }, // owner(32) + amount(8)
  });

  const accounts = await promiseWithTimeout(p, timeoutMs, new Error('Holder scan timed out'));

  const byOwner = new Map<string, bigint>();
  for (const a of accounts) {
    // data = owner(32) + amount(u64 LE)
    const data = a.account.data as Buffer;
    if (!Buffer.isBuffer(data) || data.length < 40) continue;
    const owner = new PublicKey(data.subarray(0, 32)).toBase58();
    const amt = readU64LE(data.subarray(32, 40));
    if (amt === 0n) continue;
    byOwner.set(owner, (byOwner.get(owner) ?? 0n) + amt);
  }

  const holders: HolderBalance[] = Array.from(byOwner.entries())
    .map(([owner, amountRaw]) => ({ owner, amountRaw }))
    .sort((a, b) => (a.amountRaw > b.amountRaw ? -1 : a.amountRaw < b.amountRaw ? 1 : 0));

  // add pct if supply known
  if (supplyRaw > 0n) {
    for (const h of holders) {
      h.pct = Number(h.amountRaw) / Number(supplyRaw) * 100;
    }
  }

  return {
    mint,
    decimals,
    supplyRaw,
    tsMs: Date.now(),
    holders,
  };
}

function readU64LE(buf: Buffer): bigint {
  // buf length must be 8
  let x = 0n;
  for (let i = 0; i < 8; i++) {
    x |= BigInt(buf[i]) << (8n * BigInt(i));
  }
  return x;
}

async function promiseWithTimeout<T>(p: Promise<T>, ms: number, err: Error): Promise<T> {
  let t: any;
  const timeout = new Promise<T>((_, reject) => {
    t = setTimeout(() => reject(err), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    clearTimeout(t);
  }
}
