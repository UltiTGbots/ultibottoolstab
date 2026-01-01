/**
 * RPC retry wrapper with exponential backoff for rate limiting
 */

import { Connection } from '@solana/web3.js';
import { rpcThrottle } from './rpc-throttle';

export interface RetryOptions {
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
}

const DEFAULT_OPTIONS: Required<RetryOptions> = {
  maxRetries: 2, // Reduced retries since we have throttling
  baseDelayMs: 5000, // Start with 5s delay for rate limits
  maxDelayMs: 60000, // Max 60s delay
};

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isRateLimitError(error: any): boolean {
  if (!error) return false;
  const msg = String(error?.message || error || '').toLowerCase();
  const code = error?.code;
  return (
    msg.includes('429') ||
    msg.includes('too many requests') ||
    msg.includes('rate limit') ||
    code === 429 ||
    code === -32029 // RPC rate limit error code
  );
}

/**
 * Retry wrapper for async functions with exponential backoff
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  let lastError: any = null;

  for (let attempt = 0; attempt <= opts.maxRetries; attempt++) {
    try {
      // Throttle all RPC requests to prevent rate limiting
      return await rpcThrottle.throttle(fn);
    } catch (error: any) {
      lastError = error;

      // Only retry on rate limit errors
      if (!isRateLimitError(error)) {
        throw error;
      }

      // Don't retry on last attempt
      if (attempt >= opts.maxRetries) {
        break;
      }

      // Exponential backoff with jitter (longer delays for rate limits)
      const delay = Math.min(
        opts.baseDelayMs * Math.pow(2, attempt) + Math.random() * 2000,
        opts.maxDelayMs
      );
      
      // Don't log retry attempts - they're expected
      await sleep(delay);
    }
  }

  throw lastError;
}

/**
 * Wrapper for Connection methods with retry logic
 */
export function createRetryConnection(connection: Connection): Connection {
  const retryConnection = new Proxy(connection, {
    get(target, prop) {
      const value = (target as any)[prop];
      
      // Wrap async methods that make RPC calls
      if (typeof value === 'function' && ['getBalance', 'getMint', 'getTokenLargestAccounts', 'getAccount', 'sendTransaction', 'confirmTransaction', 'getLatestBlockhash'].includes(prop as string)) {
        return function(...args: any[]) {
          return withRetry(() => value.apply(target, args), {
            maxRetries: 2, // Reduced since throttling handles most cases
            baseDelayMs: 5000, // Longer initial delay
            maxDelayMs: 60000,
          });
        };
      }
      
      return value;
    },
  });

  return retryConnection as Connection;
}

