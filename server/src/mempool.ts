/**
 * Mempool / program-log parsing notes (Solana):
 *
 * Solana does not expose an EVM-style public mempool with pending transactions in the same way.
 * What you can do instead:
 * - Subscribe to program logs (websocket) for relevant programs (Token, Raydium, Orca, etc.)
 * - Subscribe to account changes (e.g., token accounts, pool accounts)
 * - Poll signatures for addresses you're monitoring
 *
 * If you want true “pending tx” visibility on Solana, you generally need:
 * - a specialized RPC provider (e.g., private/priority channels)
 * - or validator-level plugins / streaming services.
 *
 * This file is a placeholder to keep the architecture explicit.
 */
export const MEMPOOL_NOTES = true;
