import { Connection, PublicKey } from '@solana/web3.js';
import { getMint } from '@solana/spl-token';

/**
 * Calculate funding amount for a wallet based on its tier and target supply percentage
 * 
 * Tier System:
 * - First 20 wallets: 1-2.5% of supply
 * - Next 40 wallets: 0.5-1% of supply  
 * - All others: <0.5% of supply
 */
export function calculateWalletFundingAmount(params: {
  walletIndex: number; // 0-based index of wallet in cycle
  totalSupply: bigint;
  decimals: number;
  priceUsd: number;
  slippageBuffer?: number; // Additional buffer for slippage (default 5%)
}): {
  targetSupplyPct: number;
  targetTokens: bigint;
  requiredSolLamports: number;
  requiredSol: number;
} {
  const { walletIndex, totalSupply, decimals, priceUsd, slippageBuffer = 0.05 } = params;
  
  // Determine target supply percentage based on wallet tier
  let minPct: number;
  let maxPct: number;
  
  if (walletIndex < 20) {
    // First 20 wallets: 1-2.5%
    minPct = 1.0;
    maxPct = 2.5;
  } else if (walletIndex < 60) {
    // Next 40 wallets: 0.5-1%
    minPct = 0.5;
    maxPct = 1.0;
  } else {
    // All others: <0.5% (random between 0.1-0.5%)
    minPct = 0.1;
    maxPct = 0.5;
  }
  
  // Random percentage within tier range
  const randomFactor = Math.random();
  const targetSupplyPct = minPct + (maxPct - minPct) * randomFactor;
  
  // Calculate target token amount
  const targetTokensRaw = (totalSupply * BigInt(Math.floor(targetSupplyPct * 1_000_000))) / BigInt(1_000_000_000);
  const targetTokens = targetTokensRaw;
  
  // Calculate required SOL (with slippage buffer)
  const targetTokensUi = Number(targetTokens) / Math.pow(10, decimals);
  const requiredSol = targetTokensUi * priceUsd * (1 + slippageBuffer);
  const requiredSolLamports = Math.ceil(requiredSol * 1_000_000_000);
  
  return {
    targetSupplyPct,
    targetTokens,
    requiredSolLamports,
    requiredSol
  };
}

/**
 * Calculate total funding needed for a cycle
 */
export function calculateCycleFunding(params: {
  walletsPerCycle: number;
  totalSupply: bigint;
  decimals: number;
  priceUsd: number;
  slippageBuffer?: number;
}): {
  totalSolNeeded: number;
  totalSolLamports: number;
  walletFunding: Array<{
    walletIndex: number;
    targetSupplyPct: number;
    requiredSol: number;
    requiredSolLamports: number;
  }>;
} {
  const { walletsPerCycle, totalSupply, decimals, priceUsd, slippageBuffer = 0.05 } = params;
  
  const walletFunding = [];
  let totalSolNeeded = 0;
  
  for (let i = 0; i < walletsPerCycle; i++) {
    const funding = calculateWalletFundingAmount({
      walletIndex: i,
      totalSupply,
      decimals,
      priceUsd,
      slippageBuffer
    });
    
    walletFunding.push({
      walletIndex: i,
      targetSupplyPct: funding.targetSupplyPct,
      requiredSol: funding.requiredSol,
      requiredSolLamports: funding.requiredSolLamports
    });
    
    totalSolNeeded += funding.requiredSol;
  }
  
  return {
    totalSolNeeded,
    totalSolLamports: Math.ceil(totalSolNeeded * 1_000_000_000),
    walletFunding
  };
}

