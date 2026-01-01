import { Connection, PublicKey, Keypair } from '@solana/web3.js';
import { getAccount, getAssociatedTokenAddress } from '@solana/spl-token';
import bs58 from 'bs58';

/**
 * Get SOL balance for a wallet (by public key or private key)
 */
export async function getWalletBalance(
  connection: Connection,
  publicKeyOrPrivateKey: string
): Promise<{ sol: number; publicKey: string }> {
  let publicKey: PublicKey;
  const trimmed = publicKeyOrPrivateKey.trim();
  
  // Try parsing as public key first (most common case)
  try {
    publicKey = new PublicKey(trimmed);
    // If successful, fetch balance and return
    const balance = await connection.getBalance(publicKey, 'confirmed');
    return {
      sol: balance / 1_000_000_000,
      publicKey: publicKey.toBase58()
    };
  } catch (publicKeyError: any) {
    // If public key parsing fails, try parsing as private key
    try {
      const keypair = parsePrivateKey(trimmed);
      publicKey = keypair.publicKey;
      const balance = await connection.getBalance(publicKey, 'confirmed');
      return {
        sol: balance / 1_000_000_000,
        publicKey: publicKey.toBase58()
      };
    } catch (privateKeyError: any) {
      // Both failed - provide helpful error message
      const isPublicKeyLength = trimmed.length >= 32 && trimmed.length <= 44;
      const isPrivateKeyLength = trimmed.length === 64 || trimmed.length === 88 || trimmed.length === 128;
      
      let errorMsg = '';
      if (isPublicKeyLength) {
        errorMsg = `Invalid public key format. Error: ${publicKeyError?.message || 'unknown'}`;
      } else if (isPrivateKeyLength) {
        errorMsg = `Invalid private key format (length ${trimmed.length}). This might be a public key. Public key error: ${publicKeyError?.message || 'unknown'}. Private key error: ${privateKeyError?.message || 'unknown'}`;
      } else {
        errorMsg = `Invalid key format. Length: ${trimmed.length}. Expected: public key (32-44 chars), private key hex (64/128 chars), or private key base58 (88 chars). Public key error: ${publicKeyError?.message || 'unknown'}, Private key error: ${privateKeyError?.message || 'unknown'}`;
      }
      throw new Error(errorMsg);
    }
  }
}

/**
 * Get token balance for a wallet
 */
export async function getWalletTokenBalance(
  connection: Connection,
  publicKeyOrPrivateKey: string,
  tokenMint: string
): Promise<{ balance: number; decimals: number }> {
  let publicKey: PublicKey;
  const trimmed = publicKeyOrPrivateKey.trim();
  
  try {
    publicKey = new PublicKey(trimmed);
  } catch (publicKeyError: any) {
    try {
      const keypair = parsePrivateKey(trimmed);
      publicKey = keypair.publicKey;
    } catch (privateKeyError: any) {
      throw new Error(`Invalid public key or private key. Public key error: ${publicKeyError?.message || 'unknown'}, Private key error: ${privateKeyError?.message || 'unknown'}`);
    }
  }
  
  const mintPk = new PublicKey(tokenMint);
  const ata = await getAssociatedTokenAddress(mintPk, publicKey, false);
  
  try {
    const account = await getAccount(connection, ata, 'confirmed');
    return {
      balance: Number(account.amount) / Math.pow(10, account.mint.toString() === tokenMint ? account.mint.toString() : 9),
      decimals: 9 // Default, should get from mint
    };
  } catch {
    return { balance: 0, decimals: 9 };
  }
}

/**
 * Parse private key from various formats
 */
function parsePrivateKey(input: string): Keypair {
  // Remove whitespace
  const cleaned = input.trim();
  
  // Try JSON array format first
  try {
    const arr = JSON.parse(cleaned);
    if (Array.isArray(arr)) {
      const bytes = Uint8Array.from(arr);
      if (arr.length === 64) {
        // 64-element array = full keypair (secret + public seed)
        // Keypair.fromSecretKey accepts both 32 and 64 byte arrays
        return Keypair.fromSecretKey(bytes);
      } else if (arr.length === 32) {
        // 32-element array = just the secret key
        return Keypair.fromSecretKey(bytes);
      }
    }
  } catch {}
  
  // Try hex format FIRST (check before base58 since hex is more common for private keys)
  // Hex strings contain only 0-9, a-f, A-F characters (no base58 characters like I, O, l, 0)
  const hexInput = cleaned.startsWith('0x') ? cleaned.slice(2) : cleaned;
  
  // Check if it's a valid hex string (only contains 0-9, a-f, A-F)
  // This must come BEFORE base58 because hex strings will fail base58 decode
  if (/^[0-9a-fA-F]+$/.test(hexInput)) {
    // Valid hex string - parse it
    if (hexInput.length === 64) {
      // 64 hex chars = 32 bytes (secret key)
      try {
        const bytes = new Uint8Array(32);
        for (let i = 0; i < 64; i += 2) {
          const hexByte = hexInput.substring(i, i + 2);
          const byteValue = parseInt(hexByte, 16);
          if (isNaN(byteValue)) throw new Error('Invalid hex byte');
          bytes[i / 2] = byteValue;
        }
        return Keypair.fromSecretKey(bytes);
      } catch (e: any) {
        // Fallback to Buffer if available
        try {
          const bytes = Buffer.from(hexInput, 'hex');
          if (bytes.length === 32) {
            return Keypair.fromSecretKey(new Uint8Array(bytes));
          }
        } catch {}
        // If both methods fail, throw the error
        throw new Error(`Hex parsing failed: ${e?.message || 'unknown error'}`);
      }
    } else if (hexInput.length === 128) {
      // 128 hex chars = 64 bytes (full keypair) - try full array first, then first 32 bytes
      try {
        // Parse full 64-byte keypair
        const fullBytes = Buffer.from(hexInput, 'hex');
        if (fullBytes.length === 64) {
          // Try full 64-byte array first (keypair format)
          try {
            return Keypair.fromSecretKey(new Uint8Array(fullBytes));
          } catch {
            // If full array fails, try first 32 bytes (secret key only)
            return Keypair.fromSecretKey(new Uint8Array(fullBytes.slice(0, 32)));
          }
        }
        throw new Error('Invalid hex length after parsing');
      } catch (e: any) {
        throw new Error(`Hex parsing failed for 128-char keypair: ${e?.message || 'unknown error'}`);
      }
    } else {
      // Hex string but wrong length - don't try base58, throw error
      throw new Error(`Hex string has invalid length: ${hexInput.length} (expected 64 or 128 characters)`);
    }
  }
  
  // Try base58 format (common for Solana private keys)
  // 88 characters is typical for base58-encoded 64-byte keypair secret key
  // 44 characters is typical for base58-encoded 32-byte public key
  // But we're parsing private keys, so we expect 64 bytes (88 chars) or 32 bytes (44 chars)
  try {
    const decoded = bs58.decode(cleaned);
    // bs58.decode returns a Buffer in Node.js, convert to Uint8Array
    // Buffer is a subclass of Uint8Array, but Keypair.fromSecretKey might be strict
    const decodedBytes = Buffer.isBuffer(decoded) 
      ? new Uint8Array(decoded) 
      : decoded instanceof Uint8Array 
        ? decoded 
        : new Uint8Array(decoded);
    
    // Keypair.fromSecretKey expects exactly 32 bytes (the secret key)
    // If we have 64 bytes, it's the full keypair (secret + public seed), use first 32
    // If we have 32 bytes, use it directly
    // If we have something else, try to extract 32 bytes
    
    // Keypair.fromSecretKey accepts:
    // - 32-byte Uint8Array (just the secret key)
    // - 64-byte Uint8Array (secret key + public key seed)
    // For Phantom and other wallets, the 88-char base58 decodes to 64 bytes (full keypair)
    
    if (decodedBytes.length === 64) {
      // Full keypair format (secret + public seed) - Keypair.fromSecretKey accepts 64-byte arrays directly
      // This is the format Phantom and most Solana wallets export
      // The 64-byte format is: [32-byte secret key][32-byte public key seed]
      // Keypair.fromSecretKey can accept both 32 and 64 byte arrays
      try {
        // Try the full 64-byte array first (this is what Phantom exports)
        return Keypair.fromSecretKey(decodedBytes);
      } catch (keypairError: any) {
        // If full array fails, try using just the first 32 bytes (secret key only)
        // Some formats might require just the secret key
        try {
          const secretKeyOnly = decodedBytes.slice(0, 32);
          return Keypair.fromSecretKey(secretKeyOnly);
        } catch (fallbackError: any) {
          // Both methods failed - the key is likely invalid
          throw new Error(`Failed to create keypair from 64-byte array (Phantom format). Full array error: ${keypairError?.message || 'bad secret key size'}. Secret key only error: ${fallbackError?.message || 'bad secret key size'}. Decoded length: ${decodedBytes.length} bytes. This might indicate an invalid or corrupted private key.`);
        }
      }
    } else if (decodedBytes.length === 32) {
      // Just the secret key
      try {
        return Keypair.fromSecretKey(decodedBytes);
      } catch (keypairError: any) {
        throw new Error(`Failed to create keypair from 32-byte secret key: ${keypairError?.message || 'bad secret key size'}`);
      }
    } else if (decodedBytes.length > 32) {
      // Longer than expected - try full array first, then first 32 bytes
      try {
        return Keypair.fromSecretKey(decodedBytes);
      } catch {
        try {
          return Keypair.fromSecretKey(decodedBytes.slice(0, 32));
        } catch (keypairError: any) {
          throw new Error(`Failed to create keypair: ${keypairError?.message || 'bad secret key size'}. Decoded length: ${decodedBytes.length} bytes`);
        }
      }
    } else if (decodedBytes.length > 0 && decodedBytes.length < 32) {
      // Shorter than expected - pad with zeros (not ideal but might work for some formats)
      const padded = new Uint8Array(32);
      padded.set(decodedBytes, 0);
      try {
        return Keypair.fromSecretKey(padded);
      } catch (keypairError: any) {
        throw new Error(`Failed to create keypair from padded key: ${keypairError?.message || 'bad secret key size'}. Original length: ${decodedBytes.length} bytes`);
      }
    } else {
      throw new Error(`Base58 decoded to invalid length: ${decodedBytes.length} bytes`);
    }
  } catch (e: any) {
    // Not valid base58 or keypair creation failed - include error in final message
    const base58Error = e?.message || 'base58 decode failed';
    throw new Error(`Invalid private key format. Length: ${cleaned.length}, Base58 decode error: ${base58Error}, Format: ${cleaned.substring(0, 20)}...`);
  }
}

