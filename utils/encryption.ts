import { Keypair, PublicKey } from '@solana/web3.js';
import nacl from 'tweetnacl';
import { Utxo } from '../models/utxo.js';
import { WasmFactory } from '@lightprotocol/hasher.rs';
import { Keypair as UtxoKeypair } from '../models/keypair.js';
import { keccak256 } from '@ethersproject/keccak256';
import { PROGRAM_ID, TRANSACT_IX_DISCRIMINATOR, TRANSACT_SPL_IX_DISCRIMINATOR } from './constants.js';
import BN from 'bn.js';

/**
 * Browser-compatible crypto utilities using Web Crypto API
 */
const browserCrypto = {
  /**
   * Create SHA-256 hash (browser-compatible)
   */
  async createHash(algorithm: string, data: Uint8Array): Promise<Uint8Array> {
    if (algorithm !== 'sha256') {
      throw new Error(`Unsupported algorithm: ${algorithm}`);
    }
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    return new Uint8Array(hashBuffer);
  },

  /**
   * Generate random bytes (browser-compatible)
   */
  randomBytes(length: number): Uint8Array {
    const array = new Uint8Array(length);
    crypto.getRandomValues(array);
    return array;
  },

  /**
   * Create HMAC (browser-compatible)
   */
  async createHmac(algorithm: string, key: Uint8Array): Promise<{
    update: (data: Uint8Array) => any;
    digest: () => Promise<Uint8Array>;
  }> {
    if (algorithm !== 'sha256') {
      throw new Error(`Unsupported HMAC algorithm: ${algorithm}`);
    }
    
    const cryptoKey = await crypto.subtle.importKey(
      'raw',
      key,
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );

    let dataToSign: Uint8Array[] = [];

    const hmacObject = {
      update: (data: Uint8Array) => {
        dataToSign.push(data);
        return hmacObject; // Return self for chaining
      },
      digest: async () => {
        const combined = new Uint8Array(dataToSign.reduce((acc, arr) => acc + arr.length, 0));
        let offset = 0;
        for (const arr of dataToSign) {
          combined.set(arr, offset);
          offset += arr.length;
        }
        const signature = await crypto.subtle.sign('HMAC', cryptoKey, combined);
        return new Uint8Array(signature);
      }
    };

    return hmacObject;
  },

  /**
   * Create cipher for encryption (browser-compatible)
   */
  async createCipheriv(algorithm: string, key: Uint8Array, iv: Uint8Array): Promise<{
    update: (data: Uint8Array) => void;
    final: () => Promise<Uint8Array>;
    getAuthTag: () => Uint8Array;
  }> {
    const cryptoKey = await crypto.subtle.importKey(
      'raw',
      key,
      { name: algorithm === 'aes-256-gcm' ? 'AES-GCM' : 'AES-CTR', length: key.length * 8 },
      false,
      ['encrypt']
    );

    let encryptedData: Uint8Array[] = [];
    let authTag: Uint8Array | null = null;

    return {
      update: (data: Uint8Array) => {
        encryptedData.push(data);
      },
      final: async () => {
        const combined = new Uint8Array(encryptedData.reduce((acc, arr) => acc + arr.length, 0));
        let offset = 0;
        for (const arr of encryptedData) {
          combined.set(arr, offset);
          offset += arr.length;
        }

        if (algorithm === 'aes-256-gcm') {
          const encrypted = await crypto.subtle.encrypt(
            { name: 'AES-GCM', iv },
            cryptoKey,
            combined
          );
          const encryptedArray = new Uint8Array(encrypted);
          // GCM auth tag is appended to the encrypted data
          authTag = encryptedArray.slice(-16);
          return encryptedArray.slice(0, -16);
        } else {
          // AES-CTR
          const encrypted = await crypto.subtle.encrypt(
            { name: 'AES-CTR', counter: iv, length: 128 },
            cryptoKey,
            combined
          );
          return new Uint8Array(encrypted);
        }
      },
      getAuthTag: () => {
        if (!authTag) {
          throw new Error('Auth tag not available');
        }
        return authTag;
      }
    };
  },

  /**
   * Create decipher for decryption (browser-compatible)
   */
  async createDecipheriv(algorithm: string, key: Uint8Array, iv: Uint8Array): Promise<{
    update: (data: Uint8Array) => void;
    final: () => Promise<Uint8Array>;
    setAuthTag: (tag: Uint8Array) => void;
  }> {
    const cryptoKey = await crypto.subtle.importKey(
      'raw',
      key,
      { name: algorithm === 'aes-256-gcm' ? 'AES-GCM' : 'AES-CTR', length: key.length * 8 },
      false,
      ['decrypt']
    );

    let encryptedData: Uint8Array[] = [];
    let authTag: Uint8Array | null = null;

    return {
      update: (data: Uint8Array) => {
        encryptedData.push(data);
      },
      final: async () => {
        const combined = new Uint8Array(encryptedData.reduce((acc, arr) => acc + arr.length, 0));
        let offset = 0;
        for (const arr of encryptedData) {
          combined.set(arr, offset);
          offset += arr.length;
        }

        if (algorithm === 'aes-256-gcm') {
          if (!authTag) {
            throw new Error('Auth tag must be set before final()');
          }
          // Combine encrypted data with auth tag for GCM
          const encryptedWithTag = new Uint8Array(combined.length + authTag.length);
          encryptedWithTag.set(combined, 0);
          encryptedWithTag.set(authTag, combined.length);
          
          const decrypted = await crypto.subtle.decrypt(
            { name: 'AES-GCM', iv },
            cryptoKey,
            encryptedWithTag
          );
          return new Uint8Array(decrypted);
        } else {
          // AES-CTR
          const decrypted = await crypto.subtle.decrypt(
            { name: 'AES-CTR', counter: iv, length: 128 },
            cryptoKey,
            combined
          );
          return new Uint8Array(decrypted);
        }
      },
      setAuthTag: (tag: Uint8Array) => {
        authTag = tag;
      }
    };
  }
};


/**
 * Represents a UTXO with minimal required fields
 */
export interface UtxoData {
  amount: string;
  blinding: string;
  index: number | string;
  // Optional additional fields
  [key: string]: any;
}

export interface EncryptionKey {
  v1: Uint8Array;
  v2: Uint8Array;
}

/**
 * Service for handling encryption and decryption of UTXO data
 */
export class EncryptionService {// Version identifier for encryption scheme (8-byte version)
  public static readonly ENCRYPTION_VERSION_V2 = Buffer.from([0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x02]); // Version 2

  private encryptionKeyV1: Uint8Array | null = null;
  private encryptionKeyV2: Uint8Array | null = null;
  private utxoPrivateKeyV1: string | null = null;
  private utxoPrivateKeyV2: string | null = null;

  /**
 * Generate an encryption key from a signature
 * @param signature The user's signature
 * @returns The generated encryption key
 */
  public async deriveEncryptionKeyFromSignature(signature: Uint8Array): Promise<EncryptionKey> {
    // Extract the first 31 bytes of the signature to create a deterministic key (legacy method)
    const encryptionKeyV1 = signature.slice(0, 31);

    // Store the V1 key in the service
    this.encryptionKeyV1 = encryptionKeyV1;

    // Precompute and cache the UTXO private key
    const hashedSeedV1 = await browserCrypto.createHash('sha256', encryptionKeyV1);
    this.utxoPrivateKeyV1 = '0x' + Buffer.from(hashedSeedV1).toString('hex');

    // Use Keccak256 to derive a full 32-byte encryption key from the signature
    const encryptionKeyV2 = Buffer.from(keccak256(signature).slice(2), 'hex');

    // Store the V2 key in the service
    this.encryptionKeyV2 = encryptionKeyV2;

    // Precompute and cache the UTXO private key
    const hashedSeedV2 = Buffer.from(keccak256(encryptionKeyV2).slice(2), 'hex');
    this.utxoPrivateKeyV2 = '0x' + hashedSeedV2.toString('hex');

    return {
      v1: this.encryptionKeyV1,
      v2: this.encryptionKeyV2
    };

  }

  /**
   * Generate an encryption key from a wallet keypair (V2 format)
   * @param keypair The Solana keypair to derive the encryption key from
   * @returns The generated encryption key
   */
  public async deriveEncryptionKeyFromWallet(keypair: Keypair): Promise<EncryptionKey> {
    // Sign a constant message with the keypair
    const message = Buffer.from('Privacy Money account sign in');
    const signature = nacl.sign.detached(message, keypair.secretKey);
    return await this.deriveEncryptionKeyFromSignature(signature)
  }

  /**
   * Encrypt data with the stored encryption key
   * @param data The data to encrypt
   * @returns The encrypted data as a Buffer
   * @throws Error if the encryption key has not been generated
   */
  public async encrypt(data: Buffer | string): Promise<Buffer> {
    if (!this.encryptionKeyV2) {
      throw new Error('Encryption key not set. Call setEncryptionKey or deriveEncryptionKeyFromWallet first.');
    }

    // Convert string to Buffer if needed
    const dataBuffer = typeof data === 'string' ? Buffer.from(data) : data;

    // Generate a standard initialization vector (12 bytes for GCM)
    const iv = browserCrypto.randomBytes(12);

    // Use the full 32-byte V2 encryption key for AES-256
    const key = Buffer.from(this.encryptionKeyV2);

    // Use AES-256-GCM for authenticated encryption
    const cipher = await browserCrypto.createCipheriv('aes-256-gcm', new Uint8Array(key), iv);
    cipher.update(new Uint8Array(dataBuffer));
    const encryptedData = await cipher.final();

    // Get the authentication tag from GCM (16 bytes)
    const authTag = cipher.getAuthTag();

    // Version 2 format: [version(8)] + [IV(12)] + [authTag(16)] + [encryptedData]
    return Buffer.concat([
      EncryptionService.ENCRYPTION_VERSION_V2,
      Buffer.from(iv),
      Buffer.from(authTag),
      Buffer.from(encryptedData)
    ]);
  }

  // v1 encryption, only used for testing now
  public async encryptDecryptedDoNotUse(data: Buffer | string): Promise<Buffer> {
    if (!this.encryptionKeyV1) {
      throw new Error('Encryption key not set. Call setEncryptionKey or deriveEncryptionKeyFromWallet first.');
    }

    // Convert string to Buffer if needed
    const dataBuffer = typeof data === 'string' ? Buffer.from(data) : data;

    // Generate a standard initialization vector (16 bytes)
    const iv = browserCrypto.randomBytes(16);

    // Create a key from our encryption key (using only first 16 bytes for AES-128)
    const key = Buffer.from(this.encryptionKeyV1).slice(0, 16);

    // Use a more compact encryption algorithm (aes-128-ctr)
    const cipher = await browserCrypto.createCipheriv('aes-128-ctr', new Uint8Array(key), iv);
    cipher.update(new Uint8Array(dataBuffer));
    const encryptedData = await cipher.final();

    // Create an authentication tag (HMAC) to verify decryption with correct key
    const hmacKey = Buffer.from(this.encryptionKeyV1).slice(16, 31);
    const hmac = await browserCrypto.createHmac('sha256', new Uint8Array(hmacKey));
    hmac.update(new Uint8Array(iv));
    hmac.update(new Uint8Array(encryptedData));
    const authTag = (await hmac.digest()).slice(0, 16); // Use first 16 bytes of HMAC as auth tag

    // Combine IV, auth tag and encrypted data
    return Buffer.concat([Buffer.from(iv), Buffer.from(authTag), Buffer.from(encryptedData)]);
  }

  /**
   * Decrypt data with the stored encryption key
   * @param encryptedData The encrypted data to decrypt
   * @returns The decrypted data as a Buffer
   * @throws Error if the encryption key has not been generated or if the wrong key is used
   */
  public async decrypt(encryptedData: Buffer): Promise<Buffer> {
    // Check if this is the new version format (starts with 8-byte version identifier)
    if (encryptedData.length >= 8 && encryptedData.subarray(0, 8).equals(EncryptionService.ENCRYPTION_VERSION_V2)) {
      if (!this.encryptionKeyV2) {
        throw new Error('Encryption key not set. Call setEncryptionKey or deriveEncryptionKeyFromWallet first.');
      }
      return await this.decryptV2(encryptedData);
    } else {
      // V1 format - need V1 key or keypair to derive it
      if (!this.encryptionKeyV1) {
        throw new Error('Encryption key not set. Call setEncryptionKey or deriveEncryptionKeyFromWallet first.');
      }
      return await this.decryptV1(encryptedData);
    }
  }

  /**
   * Decrypt data using the old V1 format (120-bit HMAC with SHA256)
   * @param encryptedData The encrypted data to decrypt
   * @param keypair Optional keypair to derive V1 key for backward compatibility
   * @returns The decrypted data as a Buffer
   */
  private async decryptV1(encryptedData: Buffer): Promise<Buffer> {
    if (!this.encryptionKeyV1) {
      throw new Error('Encryption key not set. Call setEncryptionKey or deriveEncryptionKeyFromWallet first.');
    }

    // Extract the IV from the first 16 bytes
    const iv = encryptedData.slice(0, 16);
    // Extract the auth tag from the next 16 bytes
    const authTag = encryptedData.slice(16, 32);
    // The rest is the actual encrypted data
    const data = encryptedData.slice(32);

    // Verify the authentication tag
    const hmacKey = Buffer.from(this.encryptionKeyV1).slice(16, 31);
    const hmac = await browserCrypto.createHmac('sha256', new Uint8Array(hmacKey));
    hmac.update(new Uint8Array(iv));
    hmac.update(new Uint8Array(data));
    const calculatedTag = (await hmac.digest()).slice(0, 16);

    // Compare tags - if they don't match, the key is wrong
    if (!this.timingSafeEqual(new Uint8Array(authTag), calculatedTag)) {
      throw new Error('Failed to decrypt data. Invalid encryption key or corrupted data.');
    }

    // Create a key from our encryption key (using only first 16 bytes for AES-128)
    const key = Buffer.from(this.encryptionKeyV1).slice(0, 16);

    // Use the same algorithm as in encrypt
    const decipher = await browserCrypto.createDecipheriv('aes-128-ctr', new Uint8Array(key), new Uint8Array(iv));

    try {
      decipher.update(new Uint8Array(data));
      const decrypted = await decipher.final();
      return Buffer.from(decrypted);
    } catch (error) {
      throw new Error('Failed to decrypt data. Invalid encryption key or corrupted data.');
    }
  }
  
  // Custom timingSafeEqual for browser compatibility
  private timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
    if (a.length !== b.length) {
      return false;
    }
    let diff = 0;
    for (let i = 0; i < a.length; i++) {
      diff |= a[i] ^ b[i];
    }
    return diff === 0;
  }

  /**
   * Decrypt data using the new V2 format (256-bit Keccak HMAC)
   * @param encryptedData The encrypted data to decrypt
   * @returns The decrypted data as a Buffer
   */
  private async decryptV2(encryptedData: Buffer): Promise<Buffer> {
    if (!this.encryptionKeyV2) {
      throw new Error('encryptionKeyV2 not set. Call setEncryptionKey or deriveEncryptionKeyFromWallet first.');
    }

    // Skip 8-byte version identifier and extract components for GCM format
    const iv = encryptedData.slice(8, 20);           // bytes 8-19 (12 bytes for GCM)
    const authTag = encryptedData.slice(20, 36);     // bytes 20-35 (16 bytes for GCM)
    const data = encryptedData.slice(36);            // remaining bytes

    // Use the full 32-byte V2 encryption key for AES-256
    const key = Buffer.from(this.encryptionKeyV2!);

    // Use AES-256-GCM for authenticated decryption
    const decipher = await browserCrypto.createDecipheriv('aes-256-gcm', new Uint8Array(key), new Uint8Array(iv));
    decipher.setAuthTag(new Uint8Array(authTag));

    try {
      decipher.update(new Uint8Array(data));
      const decrypted = await decipher.final();
      return Buffer.from(decrypted);
    } catch (error) {
      throw new Error('Failed to decrypt data. Invalid encryption key or corrupted data.');
    }
  }

  /**
   * Reset the encryption keys (mainly for testing purposes)
   */
  public resetEncryptionKey(): void {
    this.encryptionKeyV1 = null;
    this.encryptionKeyV2 = null;
    this.utxoPrivateKeyV1 = null;
    this.utxoPrivateKeyV2 = null;
  }

  /**
   * Encrypt a UTXO using a compact pipe-delimited format
   * Always uses V2 encryption format. The UTXO's version property is used only for key derivation.
   * @param utxo The UTXO to encrypt (includes version property)
   * @returns The encrypted UTXO data as a Buffer
   * @throws Error if the V2 encryption key has not been set
   */
  public async encryptUtxo(utxo: Utxo): Promise<Buffer> {
    if (!this.encryptionKeyV2) {
      throw new Error('Encryption key not set. Call setEncryptionKey or deriveEncryptionKeyFromWallet first.');
    }

    // Create a compact string representation using pipe delimiter
    // Version is stored in the UTXO model, not in the encrypted content
    const utxoString = `${utxo.amount.toString()}|${utxo.blinding.toString()}|${utxo.index}|${utxo.mintAddress}`;

    // Always use V2 encryption format (which adds version byte 0x02 at the beginning)
    return await this.encrypt(utxoString);
  }

  // Deprecated, only used for testing now
  public encryptUtxoDecryptedDoNotUse(utxo: Utxo): Buffer {
    if (!this.encryptionKeyV2) {
      throw new Error('Encryption key not set. Call setEncryptionKey or deriveEncryptionKeyFromWallet first.');
    }

    const utxoString = `${utxo.amount.toString()}|${utxo.blinding.toString()}|${utxo.index}|${utxo.mintAddress}`;

    return this.encryptDecryptedDoNotUse(utxoString);
  }

  public getEncryptionKeyVersion(encryptedData: Buffer | string): 'v1' | 'v2' {
    const buffer = typeof encryptedData === 'string' ? Buffer.from(encryptedData, 'hex') : encryptedData;

    if (buffer.length >= 8 && buffer.subarray(0, 8).equals(EncryptionService.ENCRYPTION_VERSION_V2)) {
      // V2 encryption format → V2 UTXO
      return 'v2';
    } else {
      // V1 encryption format → UTXO
      return 'v1';
    }
  }

  /**
   * Decrypt an encrypted UTXO and parse it to a Utxo instance
   * Automatically detects the UTXO version based on the encryption format
   * @param encryptedData The encrypted UTXO data
   * @param keypair The UTXO keypair to use for the decrypted UTXO
   * @param lightWasm Optional LightWasm instance. If not provided, a new one will be created
   * @param walletKeypair Optional wallet keypair for V1 backward compatibility
   * @returns Promise resolving to the decrypted Utxo instance
   * @throws Error if the encryption key has not been set or if decryption fails
   */
  public async decryptUtxo(
    encryptedData: Buffer | string,
    lightWasm?: any
  ): Promise<Utxo> {
    // Convert hex string to Buffer if needed
    const encryptedBuffer = typeof encryptedData === 'string'
      ? Buffer.from(encryptedData, 'hex')
      : encryptedData;

    // Detect UTXO version based on encryption format
    let utxoVersion = this.getEncryptionKeyVersion(encryptedBuffer)

    // The decrypt() method already handles encryption format version detection (V1 vs V2)
    // It checks the first byte to determine whether to use decryptV1() or decryptV2()
    const decrypted = await this.decrypt(encryptedBuffer);

    // Parse the pipe-delimited format: amount|blinding|index|mintAddress
    const decryptedStr = decrypted.toString();
    const parts = decryptedStr.split('|');

    if (parts.length !== 4) {
      throw new Error('Invalid UTXO format after decryption');
    }

    const [amount, blinding, index, mintAddress] = parts;

    if (!amount || !blinding || index === undefined || mintAddress === undefined) {
      throw new Error('Invalid UTXO format after decryption');
    }

    // Get or create a LightWasm instance
    const wasmInstance = lightWasm || await WasmFactory.getInstance();

    const privateKey = this.getUtxoPrivateKeyWithVersion(utxoVersion);

    // Create a Utxo instance with the detected version
    const utxo = new Utxo({
      lightWasm: wasmInstance,
      amount: amount,
      blinding: blinding,
      keypair: new UtxoKeypair(privateKey, wasmInstance),
      index: Number(index),
      mintAddress: mintAddress,
      version: utxoVersion
    });

    return utxo;
  }

  public getUtxoPrivateKeyWithVersion(version: 'v1' | 'v2'): string {
    if (version === 'v1') {
      return this.getUtxoPrivateKeyV1();
    }

    return this.getUtxoPrivateKeyV2();
  }

  public deriveUtxoPrivateKey(encryptedData?: Buffer | string): string {
    if (encryptedData && this.getEncryptionKeyVersion(encryptedData) === 'v2') {
      return this.getUtxoPrivateKeyWithVersion('v2');
    }

    return this.getUtxoPrivateKeyWithVersion('v1');
  }

  public hasUtxoPrivateKeyWithVersion(version: 'v1' | 'v2'): boolean {
    if (version === 'v1') {
      return !!this.utxoPrivateKeyV1;
    }

    return !!this.utxoPrivateKeyV2;
  }

  /**
   * Get the cached V1 UTXO private key
   * @returns A private key in hex format that can be used to create a UTXO keypair
   * @throws Error if V1 encryption key has not been set
   */
  public getUtxoPrivateKeyV1(): string {
    if (!this.utxoPrivateKeyV1) {
      throw new Error('Encryption key not set. Call setEncryptionKey or deriveEncryptionKeyFromWallet first.');
    }
    return this.utxoPrivateKeyV1;
  }

  /**
   * Get the cached V2 UTXO private key
   * @returns A private key in hex format that can be used to create a UTXO keypair
   * @throws Error if V2 encryption key has not been set
   */
  public getUtxoPrivateKeyV2(): string {
    if (!this.utxoPrivateKeyV2) {
      throw new Error('Encryption key not set. Call setEncryptionKey or deriveEncryptionKeyFromWallet first.');
    }
    return this.utxoPrivateKeyV2;
  }
}

export function serializeProofAndExtData(proof: any, extData: any, isSpl: boolean = false) {
  // Create the ExtDataMinified object for the program call (only extAmount and fee)
  const extDataMinified = {
    extAmount: extData.extAmount,
    fee: extData.fee
  };

  // Use the appropriate discriminator based on whether this is SPL or native SOL
  const discriminator = isSpl ? TRANSACT_SPL_IX_DISCRIMINATOR : TRANSACT_IX_DISCRIMINATOR;

  // Use the same serialization approach as deposit script
  const instructionData = Buffer.concat([
    discriminator,
    // Serialize proof
    Buffer.from(proof.proofA),
    Buffer.from(proof.proofB),
    Buffer.from(proof.proofC),
    Buffer.from(proof.root),
    Buffer.from(proof.publicAmount),
    Buffer.from(proof.extDataHash),
    Buffer.from(proof.inputNullifiers[0]),
    Buffer.from(proof.inputNullifiers[1]),
    Buffer.from(proof.outputCommitments[0]),
    Buffer.from(proof.outputCommitments[1]),
    // Serialize ExtDataMinified (only extAmount and fee)
    Buffer.from(new BN(extDataMinified.extAmount).toTwos(64).toArray('le', 8)),
    Buffer.from(new BN(extDataMinified.fee).toArray('le', 8)),
    // Serialize encrypted outputs as separate parameters
    Buffer.from(new BN(extData.encryptedOutput1.length).toArray('le', 4)),
    extData.encryptedOutput1,
    Buffer.from(new BN(extData.encryptedOutput2.length).toArray('le', 4)),
    extData.encryptedOutput2,
  ]);

  return instructionData;
}