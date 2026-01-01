
export type RpcClientOptions = {
  endpoint: string;
  timeoutMs?: number;
  maxRetries?: number;
  baseDelayMs?: number;
};

export class RpcClient {
  endpoint: string;
  timeoutMs: number;
  maxRetries: number;
  baseDelayMs: number;

  constructor(opts: RpcClientOptions) {
    this.endpoint = opts.endpoint;
    this.timeoutMs = opts.timeoutMs ?? 20_000;
    this.maxRetries = opts.maxRetries ?? 5;
    this.baseDelayMs = opts.baseDelayMs ?? 350;
  }

  setEndpoint(endpoint: string) {
    this.endpoint = endpoint;
  }

  private async sleep(ms: number) {
    await new Promise(r => setTimeout(r, ms));
  }

  async call<T = any>(method: string, params: any[] = []): Promise<T> {
    const body = { jsonrpc: '2.0', id: 1, method, params };
    let lastErr: any = null;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), this.timeoutMs);

      try {
        const resp = await fetch(this.endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
          signal: ctrl.signal as any,
        } as any);

        // Handle explicit rate limiting
        if (resp.status === 429) {
          const ra = resp.headers.get('retry-after');
          const waitMs = ra ? Number(ra) * 1000 : (this.baseDelayMs * (2 ** attempt)) + Math.floor(Math.random() * 250);
          await this.sleep(waitMs);
          continue;
        }

        if (!resp.ok) {
          const text = await resp.text().catch(() => '');
          throw new Error(`RPC ${method} HTTP ${resp.status} ${text}`.trim());
        }

        const json = await resp.json() as any;
        if (json.error) {
          // Some RPC errors are transient; retry on those.
          const msg = String(json.error.message || '');
          const code = json.error.code;
          const transient =
            msg.includes('Too many requests') ||
            msg.includes('rate limit') ||
            msg.includes('timed out') ||
            msg.includes('Node is behind') ||
            msg.includes('Blockhash not found') ||
            code === -32005; // e.g. "Node is behind"
          if (transient && attempt < this.maxRetries) {
            const waitMs = (this.baseDelayMs * (2 ** attempt)) + Math.floor(Math.random() * 250);
            await this.sleep(waitMs);
            continue;
          }
          throw new Error(`RPC ${method} error ${code}: ${msg}`);
        }
        return json.result as T;
      } catch (e: any) {
        lastErr = e;
        if (attempt >= this.maxRetries) break;
        const waitMs = (this.baseDelayMs * (2 ** attempt)) + Math.floor(Math.random() * 250);
        await this.sleep(waitMs);
      } finally {
        clearTimeout(t);
      }
    }

    throw lastErr ?? new Error(`RPC ${method} failed`);
  }
}
