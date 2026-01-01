/**
 * Utility function to fetch wallet balance
 * Can be called from anywhere in the app
 */
export async function fetchWalletBalance(
  privateKey: string,
  rpcUrl?: string,
  authFetch?: (path: string, init?: RequestInit) => Promise<Response>
): Promise<{ balance: number; publicKey: string } | null> {
  if (!authFetch) return null;
  
  try {
    const res = await authFetch('/api/wallet/balance', {
      method: 'POST',
      body: JSON.stringify({
        privateKey,
        rpcUrl: rpcUrl || undefined
      })
    });
    
    if (res.ok) {
      const data = await res.json();
      return {
        balance: data.balance || 0,
        publicKey: data.publicKey
      };
    }
  } catch (e) {
    console.error('Balance fetch error:', e);
  }
  
  return null;
}

