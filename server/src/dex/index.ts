/**
 * DEX integration layer (skeleton).
 *
 * This repo originally had only a simulator. The server now provides:
 * - on-chain monitoring via websocket logs (mentions) + transaction parsing
 * - an extension point for real swap execution.
 *
 * IMPORTANT:
 * - Real swapping requires wallet private keys, slippage config, priority fees, and pool routing.
 * - Raydium/Orca/Pump are each different. Implement the adapter you need and wire it to bot actions.
 *
 * Production recommendation: use a reputable router (e.g., Jupiter) for swaps unless you have a specific reason
 * to hit a single DEX directly.
 */

export type SwapSide = 'BUY' | 'SELL';

export interface SwapParams {
  owner: string;
  mint: string; // token mint
  side: SwapSide;
  amountIn: number; // SOL for BUY, token amount for SELL
  slippageBps: number;
}

export interface DexAdapter {
  name: string;
  swap(params: SwapParams): Promise<{ signature: string }>;
}

/** TODO: implement with raydium-sdk v2 */
export class RaydiumAdapter implements DexAdapter {
  name = 'Raydium';
  async swap(_params: SwapParams): Promise<{ signature: string }> {
    throw new Error('RaydiumAdapter.swap not implemented. See README for wiring.');
  }
}

/** TODO: implement with Orca Whirlpool SDK */
export class OrcaAdapter implements DexAdapter {
  name = 'Orca';
  async swap(_params: SwapParams): Promise<{ signature: string }> {
    throw new Error('OrcaAdapter.swap not implemented. See README for wiring.');
  }
}

/** TODO: implement Pump.fun swap program flow (when applicable) */
export class PumpSwapAdapter implements DexAdapter {
  name = 'PumpSwap';
  async swap(_params: SwapParams): Promise<{ signature: string }> {
    throw new Error('PumpSwapAdapter.swap not implemented. See README for wiring.');
  }
}
