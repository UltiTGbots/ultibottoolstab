/**
 * Privacy Cash SDK wrapper for direct wallet providers (Phantom/Solflare)
 * 
 * This adapts the Privacy Cash SDK to work with direct wallet providers
 * instead of wallet adapters.
 */

import { Connection, PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';
import BN from 'bn.js';
import { WasmFactory } from '@lightprotocol/hasher.rs';

// Import from local SDK (using relative paths)
import { EncryptionService } from '..//../utils/encryption.js';
import { deposit } from '../../src/deposit.js';
import { withdraw } from '../../src/withdraw.js';
import { getUtxos, getBalanceFromUtxos, localstorageKey } from '../../src/getUtxos.js';
import { logger, setLogger } from '../../utils/logger.js';
import { VersionedTransaction } from '@solana/web3.js';

/**
 * Browser-compatible storage adapter
 */
class BrowserStorage {
  getItem(key: string): string | null {
    if (typeof window === 'undefined') return null;
    try {
      return window.localStorage.getItem(key);
    } catch (error) {
      console.error('localStorage.getItem error:', error);
      return null;
    }
  }

  setItem(key: string, value: string): void {
    if (typeof window === 'undefined') return;
    try {
      window.localStorage.setItem(key, value);
    } catch (error) {
      console.error('localStorage.setItem error:', error);
      if (error instanceof DOMException && error.code === 22) {
        throw new Error('Storage quota exceeded. Please clear some data.');
      }
    }
  }

  removeItem(key: string): void {
    if (typeof window === 'undefined') return;
    try {
      window.localStorage.removeItem(key);
    } catch (error) {
      console.error('localStorage.removeItem error:', error);
    }
  }
}

/**
 * Wallet provider interface for direct wallet access
 */
interface DirectWalletProvider {
  publicKey: PublicKey;
  signMessage(message: Uint8Array): Promise<{ signature: Uint8Array }>;
  signTransaction(transaction: any): Promise<any>;
  signAllTransactions(transactions: any[]): Promise<any[]>;
}

/**
 * Privacy Cash wrapper for direct wallet providers
 */
export class PrivacyCashDirect {
  private connection: Connection;
  public publicKey: PublicKey;
  private encryptionService: EncryptionService | null = null;
  private wallet: DirectWalletProvider;
  private storage: BrowserStorage;
  private circuitBaseUrl: string;
  private initialized: boolean = false;

  constructor({
    connection,
    wallet,
    circuitBaseUrl = '/circuit2',
    enableDebug = false,
  }: {
    connection: Connection;
    wallet: DirectWalletProvider;
    circuitBaseUrl?: string;
    enableDebug?: boolean;
  }) {
    this.connection = connection;
    this.wallet = wallet;
    this.publicKey = wallet.publicKey;
    this.storage = new BrowserStorage();
    this.circuitBaseUrl = circuitBaseUrl;

    // Set up logger
    if (enableDebug) {
      setLogger((level: string, message: string) => {
        if (level === 'error') console.error('[PrivacyCash]', message);
        else if (level === 'warn') console.warn('[PrivacyCash]', message);
        else if (level === 'info') console.log('[PrivacyCash]', message);
        else if (level === 'debug') console.debug('[PrivacyCash]', message);
      });
    } else {
      setLogger((level: string, message: string) => {
        if (level === 'error') console.error('[PrivacyCash]', message);
        else if (level === 'warn') console.warn('[PrivacyCash]', message);
      });
    }
  }

  /**
   * Initialize encryption service (required before any operations)
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    try {
      // Create encryption service instance
      this.encryptionService = new EncryptionService();
      
      // Sign a message to derive encryption key
      const message = new TextEncoder().encode('Privacy Cash encryption key derivation');
      const signedMessage = await this.wallet.signMessage(message);
      
      // Derive encryption key from signature
      this.encryptionService.deriveEncryptionKeyFromSignature(signedMessage.signature);

      this.initialized = true;
      logger.info('Privacy Cash initialized successfully');
    } catch (error: any) {
      logger.error(`Failed to initialize encryption: ${error.message}`);
      throw new Error(`Failed to initialize encryption: ${error.message}`);
    }
  }

  /**
   * Check if Privacy Cash is initialized
   */
  isInitialized(): boolean {
    return this.initialized && this.encryptionService !== null;
  }

  /**
   * Ensure Privacy Cash is initialized
   */
  private async ensureInitialized(): Promise<void> {
    if (!this.isInitialized()) {
      await this.initialize();
    }
  }

  /**
   * Get circuit file path
   */
  private getCircuitPath(filename: string): string {
    return `${this.circuitBaseUrl}/${filename}`;
  }

  /**
   * Get private SOL balance
   */
  async getPrivateBalance(): Promise<{ lamports: number; sol: number }> {
    await this.ensureInitialized();
    
    const unspentUtxos = await getUtxos({
      connection: this.connection,
      publicKey: this.publicKey,
      encryptionService: this.encryptionService!,
      storage: this.storage as any,
    });

    const balance = getBalanceFromUtxos(unspentUtxos);
    return {
      lamports: balance.lamports,
      sol: balance.lamports / LAMPORTS_PER_SOL,
    };
  }

  /**
   * Withdraw SOL from Privacy Cash pool
   */
  async withdraw({ lamports, recipientAddress }: { lamports: number; recipientAddress?: string }): Promise<any> {
    await this.ensureInitialized();

    if (lamports <= 0) {
      throw new Error('Withdrawal amount must be greater than 0');
    }

    // Check minimum amount (fees require at least ~0.001 SOL)
    const requestedInSol = lamports / LAMPORTS_PER_SOL;
    if (requestedInSol < 0.001) {
      throw new Error('Minimum withdrawal amount is 0.001 SOL (fees require this minimum)');
    }

    logger.info(`Starting withdrawal: ${requestedInSol} SOL`);

    const lightWasm = await WasmFactory.getInstance();
    const recipient = recipientAddress ? new PublicKey(recipientAddress) : this.publicKey;

    try {
      const res = await withdraw({
        lightWasm,
        amount_in_lamports: lamports,
        connection: this.connection,
        encryptionService: this.encryptionService!,
        publicKey: this.publicKey,
        recipient,
        keyBasePath: this.getCircuitPath('transaction2'),
        storage: this.storage as any,
      });

      const solAmount = res.amount_in_lamports / LAMPORTS_PER_SOL;
      logger.info(`Withdraw successful. Recipient ${recipient} received ${solAmount} SOL`);
      return res;
    } catch (error: any) {
      logger.error(`Withdrawal failed: ${error.message}`);
      
      // Provide more helpful error messages
      if (error.message.includes('no balance') || 
          error.message.includes('No enough balance') || 
          error.message.includes('Insufficient')) {
        try {
          const balance = await this.getPrivateBalance();
          const balanceInSol = balance.lamports / LAMPORTS_PER_SOL;
          const suggestedAmount = (balanceInSol * 0.8).toFixed(6);
          
          throw new Error(
            `Insufficient UTXOs for withdrawal. ` +
            `Your total balance is ${balanceInSol.toFixed(6)} SOL, but UTXOs may be split into smaller amounts. ` +
            `The withdrawal uses only the 2 largest UTXOs. ` +
            `Try withdrawing ${suggestedAmount} SOL or less to account for fees. ` +
            `Or make another small deposit to consolidate UTXOs.`
          );
        } catch (balanceError) {
          throw new Error(`Insufficient balance. Please refresh your balance and try a smaller amount.`);
        }
      }
      
      throw error;
    }
  }

  /**
   * Deposit SOL into Privacy Cash pool
   */
  async deposit({ lamports }: { lamports: number }): Promise<any> {
    await this.ensureInitialized();

    if (lamports <= 0) {
      throw new Error('Deposit amount must be greater than 0');
    }

    logger.info(`Starting deposit: ${lamports / LAMPORTS_PER_SOL} SOL`);

    const lightWasm = await WasmFactory.getInstance();

    try {
      // Create transaction signer function
      const transactionSigner = async (transaction: VersionedTransaction): Promise<VersionedTransaction> => {
        const signed = await this.wallet.signTransaction(transaction);
        return signed;
      };

      const res = await deposit({
        lightWasm,
        amount_in_lamports: lamports,
        connection: this.connection,
        encryptionService: this.encryptionService!,
        publicKey: this.publicKey,
        keyBasePath: this.getCircuitPath('transaction2'),
        storage: this.storage as any,
        transactionSigner,
      });

      logger.info(`Deposit successful. ${lamports / LAMPORTS_PER_SOL} SOL deposited into Privacy Cash pool`);
      return res;
    } catch (error: any) {
      logger.error(`Deposit failed: ${error.message}`);
      throw error;
    }
  }

  /**
   * Automatic private transfer: Deposit + Withdraw in one flow
   * This is what Privacy Shield uses - automatically deposits then withdraws
   */
  async privateTransfer({ lamports, recipientAddress }: { lamports: number; recipientAddress: string }): Promise<any> {
    await this.ensureInitialized();

    if (lamports <= 0) {
      throw new Error('Transfer amount must be greater than 0');
    }

    const amountInSol = lamports / LAMPORTS_PER_SOL;
    logger.info(`Starting automatic private transfer: ${amountInSol} SOL to ${recipientAddress}`);

    try {
      // Step 1: Check current Privacy Cash balance
      const balance = await this.getPrivateBalance();
      const balanceLamports = balance.lamports;
      const balanceInSol = balanceLamports / LAMPORTS_PER_SOL;
      
      logger.info(`Current Privacy Cash balance: ${balanceInSol.toFixed(6)} SOL`);

      // Step 2: If balance is insufficient, automatically deposit
      // We need a bit more than the transfer amount to account for fees
      const requiredBalance = lamports * 1.02; // Add 2% buffer for fees
      
      if (balanceLamports < requiredBalance) {
        const depositAmount = Math.ceil(requiredBalance - balanceLamports);
        const depositAmountInSol = depositAmount / LAMPORTS_PER_SOL;
        
        logger.info(`Insufficient balance. Auto-depositing ${depositAmountInSol.toFixed(6)} SOL...`);
        
        await this.deposit({ lamports: depositAmount });
        
        // Wait a moment for the deposit to be processed
        await new Promise(resolve => setTimeout(resolve, 2000));
        
        logger.info(`Auto-deposit completed`);
      }

      // Step 3: Withdraw to recipient
      logger.info(`Withdrawing ${amountInSol} SOL to ${recipientAddress}...`);
      const withdrawResult = await this.withdraw({
        lamports,
        recipientAddress,
      });

      logger.info(`Automatic private transfer completed successfully`);
      return withdrawResult;
    } catch (error: any) {
      logger.error(`Automatic private transfer failed: ${error.message}`);
      throw error;
    }
  }

  /**
   * Get maximum withdrawable amount based on available UTXOs
   */
  async getMaxWithdrawalAmount(): Promise<number> {
    await this.ensureInitialized();
    
    const unspentUtxos = await getUtxos({
      connection: this.connection,
      publicKey: this.publicKey,
      encryptionService: this.encryptionService!,
      storage: this.storage as any,
    });

    if (unspentUtxos.length === 0) {
      return 0;
    }

    // Sort UTXOs by amount in descending order
    unspentUtxos.sort((a, b) => b.amount.cmp(a.amount));

    // Consider the top 2 UTXOs for withdrawal
    const firstInputAmount = unspentUtxos[0].amount.toNumber();
    const secondInputAmount = unspentUtxos.length > 1 ? unspentUtxos[1].amount.toNumber() : 0;
    const totalInputAmount = firstInputAmount + secondInputAmount;

    // Estimate fees (approximate - actual fees may vary)
    // withdraw_fee_rate is typically around 0.01 (1%)
    // withdraw_rent_fee is typically around 0.0001 (0.01%)
    const estimatedFeeRate = 0.01;
    const estimatedRentFee = 0.0001 * LAMPORTS_PER_SOL;
    
    // Estimate max possible withdrawal
    // X + (X * feeRate) + fixedFee <= totalInputAmount
    // X * (1 + feeRate) <= totalInputAmount - fixedFee
    // X <= (totalInputAmount - fixedFee) / (1 + feeRate)
    const maxWithdrawableLamports = (totalInputAmount - estimatedRentFee) / (1 + estimatedFeeRate);

    return Math.max(0, Math.floor(maxWithdrawableLamports));
  }
}

