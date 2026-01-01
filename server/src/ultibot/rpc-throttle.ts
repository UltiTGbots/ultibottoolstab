/**
 * RPC request throttling to prevent rate limit errors
 * Limits concurrent requests and adds delays between requests
 */

class RequestThrottle {
  private queue: Array<() => void> = [];
  private active = 0;
  private readonly maxConcurrent: number;
  private readonly minDelayMs: number;
  private lastRequestTime = 0;

  constructor(maxConcurrent: number = 3, minDelayMs: number = 500) {
    this.maxConcurrent = maxConcurrent;
    this.minDelayMs = minDelayMs;
  }

  async throttle<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      const execute = async () => {
        // Wait for minimum delay between requests
        const now = Date.now();
        const timeSinceLastRequest = now - this.lastRequestTime;
        if (timeSinceLastRequest < this.minDelayMs) {
          await new Promise(resolve => setTimeout(resolve, this.minDelayMs - timeSinceLastRequest));
        }

        this.active++;
        this.lastRequestTime = Date.now();

        try {
          const result = await fn();
          resolve(result);
        } catch (error) {
          reject(error);
        } finally {
          this.active--;
          if (this.queue.length > 0) {
            const next = this.queue.shift();
            if (next) next();
          }
        }
      };

      if (this.active < this.maxConcurrent) {
        execute();
      } else {
        this.queue.push(execute);
      }
    });
  }
}

// Global throttle instance - limits to 3 concurrent requests with 500ms minimum delay
export const rpcThrottle = new RequestThrottle(3, 500);

