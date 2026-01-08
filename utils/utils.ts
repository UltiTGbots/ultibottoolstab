/**
 * Utility functions for ZK Cash
 * 
 * Provides common utility functions for the ZK Cash system
 * Based on: https://github.com/tornadocash/tornado-nova
 */

import BN from 'bn.js';
import { Utxo } from '../models/utxo.js';
import { sha256 } from '@ethersproject/sha2';
import { PublicKey } from '@solana/web3.js';
import { RELAYER_API_URL, PROGRAM_ID } from './constants.js';
import { logger } from './logger.js';
import { getConfig } from '../src/config.js';

/**
 * Browser-compatible Borsh serialization
 * Manually serializes data according to Borsh format
 */
function serializeBorsh(schema: any, value: any): Buffer {
  const buffers: Buffer[] = [];
  
  function serializeValue(fieldSchema: any, fieldValue: any) {
    if (typeof fieldSchema === 'string') {
      // Primitive type
      if (fieldSchema === 'i64' || fieldSchema === 'u64') {
        // BN instance - serialize as little-endian 8-byte integer
        const bn = fieldValue instanceof BN ? fieldValue : new BN(fieldValue.toString());
        const buffer = Buffer.allocUnsafe(8);
        if (fieldSchema === 'i64') {
          // Signed 64-bit integer (two's complement)
          const isNegative = bn.isNeg();
          const absValue = bn.abs();
          for (let i = 0; i < 8; i++) {
            buffer[i] = (absValue.shrn(i * 8).toNumber() & 0xff);
          }
          if (isNegative) {
            // Two's complement for negative numbers
            let carry = 1;
            for (let i = 0; i < 8; i++) {
              const byte = (~buffer[i] & 0xff) + carry;
              buffer[i] = byte & 0xff;
              carry = byte >> 8;
            }
          }
        } else {
          // Unsigned 64-bit integer
          for (let i = 0; i < 8; i++) {
            buffer[i] = (bn.shrn(i * 8).toNumber() & 0xff);
          }
        }
        buffers.push(buffer);
      } else if (fieldSchema === 'u8') {
        buffers.push(Buffer.from([fieldValue & 0xff]));
      } else if (fieldSchema === 'u16') {
        const buffer = Buffer.allocUnsafe(2);
        buffer.writeUInt16LE(fieldValue, 0);
        buffers.push(buffer);
      } else if (fieldSchema === 'u32') {
        const buffer = Buffer.allocUnsafe(4);
        buffer.writeUInt32LE(fieldValue, 0);
        buffers.push(buffer);
      }
    } else if (fieldSchema && fieldSchema.array) {
      // Array type
      if (fieldSchema.array.len !== undefined) {
        // Fixed-length array
        if (fieldSchema.array.type === 'u8') {
          // For u8 arrays, directly use the buffer/bytes
          const buffer = Buffer.isBuffer(fieldValue) ? fieldValue :
                        fieldValue instanceof Uint8Array ? Buffer.from(fieldValue) :
                        Buffer.from(fieldValue);
          // Ensure it's exactly the required length
          if (buffer.length !== fieldSchema.array.len) {
            const padded = Buffer.alloc(fieldSchema.array.len);
            buffer.copy(padded, 0, 0, Math.min(buffer.length, fieldSchema.array.len));
            buffers.push(padded);
          } else {
            buffers.push(buffer);
          }
        } else {
          // For other types, serialize each element
          const arr = Array.isArray(fieldValue) ? fieldValue : Array.from(fieldValue);
          for (let i = 0; i < fieldSchema.array.len; i++) {
            serializeValue(fieldSchema.array.type, arr[i] || 0);
          }
        }
      } else {
        // Variable-length array - write length first (u32)
        const arr = Buffer.isBuffer(fieldValue) ? Array.from(fieldValue) : 
                   Array.isArray(fieldValue) ? fieldValue : 
                   fieldValue instanceof Uint8Array ? Array.from(fieldValue) :
                   Array.from(fieldValue);
        const lenBuffer = Buffer.allocUnsafe(4);
        lenBuffer.writeUInt32LE(arr.length, 0);
        buffers.push(lenBuffer);
        for (const item of arr) {
          serializeValue(fieldSchema.array.type, item);
        }
      }
    }
  }
  
  // Serialize struct fields in order
  if (schema.struct) {
    for (const [fieldName, fieldSchema] of Object.entries(schema.struct)) {
      serializeValue(fieldSchema, value[fieldName]);
    }
  }
  
  return Buffer.concat(buffers);
}

/**
 * Calculate deposit fee based on deposit amount and fee rate
 * @param depositAmount Amount being deposited in lamports
 * @returns Fee amount in lamports
 */
export async function calculateDepositFee(depositAmount: number) {
  return Math.floor(depositAmount * (await getConfig('deposit_fee_rate')) / 10000);
}

/**
 * Calculate withdrawal fee based on withdrawal amount and fee rate
 * @param withdrawalAmount Amount being withdrawn in lamports
 * @returns Fee amount in lamports
 */
export async function calculateWithdrawalFee(withdrawalAmount: number) {
  return Math.floor(withdrawalAmount * (await getConfig('withdraw_fee_rate')) / 10000);
}

/**
 * Mock encryption function - in real implementation this would be proper encryption
 * For testing, we just return a fixed prefix to ensure consistent extDataHash
 * @param value Value to encrypt
 * @returns Encrypted string representation
 */
export function mockEncrypt(value: Utxo): string {
  return JSON.stringify(value);
}

/**
 * Calculates the hash of ext data using Borsh serialization
 * @param extData External data object containing recipient, amount, encrypted outputs, fee, fee recipient, and mint address
 * @returns The hash as a Uint8Array (32 bytes)
 */
export function getExtDataHash(extData: {
  recipient: string | PublicKey;
  extAmount: string | number | BN;
  encryptedOutput1?: string | Uint8Array;  // Optional for Account Data Separation
  encryptedOutput2?: string | Uint8Array;  // Optional for Account Data Separation
  fee: string | number | BN;
  feeRecipient: string | PublicKey;
  mintAddress: string | PublicKey;
}): Uint8Array {
  // Convert all inputs to their appropriate types
  const recipient = extData.recipient instanceof PublicKey
    ? extData.recipient
    : new PublicKey(extData.recipient);

  const feeRecipient = extData.feeRecipient instanceof PublicKey
    ? extData.feeRecipient
    : new PublicKey(extData.feeRecipient);

  const mintAddress = extData.mintAddress instanceof PublicKey
    ? extData.mintAddress
    : new PublicKey(extData.mintAddress);

  // Convert to BN for proper i64/u64 handling
  const extAmount = new BN(extData.extAmount.toString());
  const fee = new BN(extData.fee.toString());

  // Handle encrypted outputs - they might not be present in Account Data Separation approach
  const encryptedOutput1 = extData.encryptedOutput1
    ? Buffer.from(extData.encryptedOutput1 as any)
    : Buffer.alloc(0); // Empty buffer if not provided
  const encryptedOutput2 = extData.encryptedOutput2
    ? Buffer.from(extData.encryptedOutput2 as any)
    : Buffer.alloc(0); // Empty buffer if not provided

  // Define the borsh schema matching the Rust struct
  const schema = {
    struct: {
      recipient: { array: { type: 'u8', len: 32 } },
      extAmount: 'i64',
      encryptedOutput1: { array: { type: 'u8' } },
      encryptedOutput2: { array: { type: 'u8' } },
      fee: 'u64',
      feeRecipient: { array: { type: 'u8', len: 32 } },
      mintAddress: { array: { type: 'u8', len: 32 } },
    }
  };

  const value = {
    recipient: recipient.toBytes(),
    extAmount: extAmount,  // BN instance - Borsh handles it correctly with i64 type
    encryptedOutput1: encryptedOutput1,
    encryptedOutput2: encryptedOutput2,
    fee: fee,  // BN instance - Borsh handles it correctly with u64 type
    feeRecipient: feeRecipient.toBytes(),
    mintAddress: mintAddress.toBytes(),
  };

  // Serialize with browser-compatible Borsh
  const serializedData = serializeBorsh(schema, value);

  // Calculate the SHA-256 hash
  const hashHex = sha256(serializedData);
  // Convert from hex string to Uint8Array
  return Buffer.from(hashHex.slice(2), 'hex');
}


// Function to fetch Merkle proof from API for a given commitment
export async function fetchMerkleProof(commitment: string, tokenName?: string): Promise<{ pathElements: string[], pathIndices: number[] }> {
  try {
    logger.debug(`Fetching Merkle proof for commitment: ${commitment}`);
    let url = `${RELAYER_API_URL}/merkle/proof/${commitment}`
    if (tokenName) {
      url += '?token=' + tokenName
    }
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to fetch Merkle proof: ${url}`);
    }
    const data = await response.json() as { pathElements: string[], pathIndices: number[] };
    logger.debug(`✓ Fetched Merkle proof with ${data.pathElements.length} elements`);
    return data;
  } catch (error) {
    console.error(`Failed to fetch Merkle proof for commitment ${commitment}:`, error);
    throw error;
  }
}

// Find nullifier PDAs for the given proof
export function findNullifierPDAs(proof: any) {
  const [nullifier0PDA] = PublicKey.findProgramAddressSync(
    [Buffer.from("nullifier0"), Buffer.from(proof.inputNullifiers[0])],
    PROGRAM_ID
  );

  const [nullifier1PDA] = PublicKey.findProgramAddressSync(
    [Buffer.from("nullifier1"), Buffer.from(proof.inputNullifiers[1])],
    PROGRAM_ID
  );

  return { nullifier0PDA, nullifier1PDA };
}

// Function to query remote tree state from indexer API
export async function queryRemoteTreeState(tokenName?: string): Promise<{ root: string, nextIndex: number }> {
  try {
    logger.debug('Fetching Merkle root and nextIndex from API...');
    let url = `${RELAYER_API_URL}/merkle/root`
    if (tokenName) {
      url += '?token=' + tokenName
    }
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to fetch Merkle root and nextIndex: ${response.status} ${response.statusText}`);
    }
    const data = await response.json() as { root: string, nextIndex: number };
    logger.debug(`Fetched root from API: ${data.root}`);
    logger.debug(`Fetched nextIndex from API: ${data.nextIndex}`);
    return data;
  } catch (error) {
    console.error('Failed to fetch root and nextIndex from API:', error);
    throw error;
  }
}

export function getProgramAccounts() {
  // Derive PDA (Program Derived Addresses) for the tree account and other required accounts
  const [treeAccount] = PublicKey.findProgramAddressSync(
    [Buffer.from('merkle_tree')],
    PROGRAM_ID
  );

  const [treeTokenAccount] = PublicKey.findProgramAddressSync(
    [Buffer.from('tree_token')],
    PROGRAM_ID
  );

  const [globalConfigAccount] = PublicKey.findProgramAddressSync(
    [Buffer.from('global_config')],
    PROGRAM_ID
  );
  return { treeAccount, treeTokenAccount, globalConfigAccount }
}


export function findCrossCheckNullifierPDAs(proof: any) {
  const [nullifier2PDA] = PublicKey.findProgramAddressSync(
    [Buffer.from("nullifier0"), Buffer.from(proof.inputNullifiers[1])],
    PROGRAM_ID
  );

  const [nullifier3PDA] = PublicKey.findProgramAddressSync(
    [Buffer.from("nullifier1"), Buffer.from(proof.inputNullifiers[0])],
    PROGRAM_ID
  );

  return { nullifier2PDA, nullifier3PDA };
}

export function getMintAddressField(mint: PublicKey): string {
  const mintStr = mint.toString();

  // Special case for SOL (system program)
  if (mintStr === '11111111111111111111111111111112') {
    return mintStr;
  }

  // For SPL tokens (USDC, USDT, etc): use first 31 bytes (248 bits)
  // This provides better collision resistance than 8 bytes while still fitting in the field
  // We will only suppport private SOL, USDC and USDT send, so there won't be any collision.
  const mintBytes = mint.toBytes();
  return new BN(mintBytes.slice(0, 31), 'be').toString();
}