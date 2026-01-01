
export enum AppState {
  IDLE = 'IDLE',
  RUNNING = 'RUNNING',
  PAUSED_SAFETY = 'PAUSED_SAFETY',
  RESTARTING = 'RESTARTING',
}

export type AppTab = 'ULTIBOT' | 'ANONPAY' | 'ULTICLEANER' | 'ADMIN' | 'MARKETMAKER';

export type UserRole = 'OWNER' | 'ADMIN' | 'USER';

export type AuthProvider = 'GOOGLE' | 'TWITTER' | 'EMAIL';
export type WalletProvider = 'PHANTOM' | 'SOLFLARE' | 'NONE';

export interface UserProfile {
  id: string;
  email: string;
  name: string;
  username?: string;
  avatarUrl?: string;
  provider: AuthProvider;
  role: UserRole;
  wallet?: string;
  promoCode?: string;
  referredBy?: string;
  twitterHandle?: string;
  tiktokHandle?: string;
  facebookHandle?: string;
  createdAt?: number;
  lastLogin?: number;
  loginCount?: number;
}

export enum CyclePhase {
  PENDING = 'PENDING',
  INITIAL_BUY = 'INITIAL_BUY', 
  MONITORING = 'MONITORING',   
  DEFENDING = 'DEFENDING',     
  WAITING_FOR_EXIT = 'WAITING_FOR_EXIT', 
  COMPLETE = 'COMPLETE'
}

export enum DefensiveActionType {
  PAUSE = 'PAUSE',
  SELL_PCT = 'SELL_PCT',
  BUY_PCT = 'BUY_PCT',
  IGNORE = 'IGNORE',
}

export interface ActionConfig {
  type: DefensiveActionType;
  percentage: number;
}

export type WalletStatus = 'ACTIVE' | 'EXITED' | 'RETIRED' | 'HOLDING';
export type SpecialRole = 'FUNDING' | 'PROFIT' | 'DEVELOPER';

export interface SpecialWallet {
  role: SpecialRole;
  address: string;
  balanceSol: number;
  privateKey?: string; // For real production usage
}

export interface Wallet {
  id: string;
  groupId: string;
  address: string;
  label: string;
  isWhitelisted: boolean;
  balanceSol: number;
  balanceTokens: number;
  initialBalanceSol: number; 
  status: WalletStatus;
}

export interface WalletGroup {
  id: string;
  name: string;
  cycleNumber: number;
  isActive: boolean;
  phase: CyclePhase;
  hasDefended: boolean;
  entryPriceUsd?: number; // NEW: used for monitoring rules
  entryMarketCap?: number; // Market cap when group started (for take profit calculations)
  startTime?: number; // NEW: cycle start timestamp
  wallets: Wallet[];
  // Per-group strategy configuration
  initialBuySolPct?: number;
  intruderTriggerPct?: number;
  groupSellPctMin?: number;
  groupSellPctMax?: number;
  walletsPerGroup?: number; // Target number of wallets for this group
  tpStopLossPairs?: Array<{
    tpBuy?: number;
    stopLossBuy?: number;
    tpSell?: number;
    stopLossSell?: number;
  }>; // TP and Stop Loss pairs for buying and selling criteria
  marketCapTakeProfit?: Array<{
    marketCapIncreaseDollar?: number; // $ increase in market cap (e.g., 10000 = $10,000 increase)
    sellPct?: number; // % of holdings to sell at this level (e.g., 25 = sell 25%)
    executed?: boolean; // Track if this level has been executed
  }>; // Market cap-based take profit schedule
}

export type PauseMode = 'FIXED' | 'WAIT_FOR_EXIT';

export type IntruderAction =
  | { type: 'ALERT' }
  | { type: 'PAUSE' }
  | { type: 'SELL_GROUP_PERCENT'; percentage: number };

export interface MonitoringRules {
  takeProfitPct?: number; // +% from avg entry
  stopLossPct?: number;   // -% from avg entry
  maxHoldSec?: number;    // time-based exit
}

export interface StrategyConfig {
  name?: string;
  description?: string;
  initialBuySolPct: number; 
  intruderTriggerPct: number; 
  intruderActions?: IntruderAction[]; // NEW: actions to take on trigger
  groupSellPctMin: number; 
  groupSellPctMax: number; 
  targetSupplyBuyMin: number; 
  targetSupplyBuyMax: number;
  cyclePauseTimeSec: number; // Delay before starting next cycle
  pauseMode: PauseMode; // Logic for restarting
  usePrivacyMode: boolean; // Enable unlinked transfers
  monitoringRules?: MonitoringRules; // NEW: trade actions while monitoring
}


export interface TradeConfig {
  targetMarketCapSell: number;
  monitoredTokenAddress: string;
  walletsPerCycle?: number; // NEW: default 5
  strategy: StrategyConfig;
}


export interface Transaction {
  id: string;
  hash: string;
  sender: string;
  receiver?: string; // Added for privacy logic
  type: 'BUY' | 'SELL' | 'SWEEP' | 'MIXER_DEPOSIT' | 'RELAY_WITHDRAW' | 'DIRECT_TRANSFER';
  amountSol: number;
  assetSymbol?: string; // 'SOL' or Token Symbol
  timestamp: number;
  isIntruder: boolean;
  isStrategyAction?: boolean;
  isPrivacyAction?: boolean;
}

export interface MarketData {
  marketCap: number;
  priceUsd: number;
  totalSupply: number;
  intruderHoldings: number; // % of supply
  bondingCurveProgress: number;
  tokenName?: string;
  tokenTicker?: string;
}

// Privacy specific types
export interface PrivacyQueueItem {
  id: string;
  fromRole?: SpecialRole; // If coming from a special wallet
  fromWalletId?: string; // If coming from a generated wallet
  toRole?: SpecialRole;
  toWalletId?: string;
  toAddress?: string; // External address support (AnonPay)
  amount: number;
  assetType: 'SOL' | 'TOKEN';
  tokenSymbol?: string; // For SPL tokens
  status: 'QUEUED' | 'MIXING' | 'RELAYING' | 'COMPLETED';
  depositTxHash?: string;
  relayTxHash?: string;
  zkProofNote?: string;
  releaseTime: number; // Timestamp when it can be relayed
}

export interface PrivacyState {
  shadowPoolBalanceSol: number;
  shadowPoolBalanceTokens: number;
  totalVolumeAnonymized: number;
  queue: PrivacyQueueItem[];
}

// Preset definition for the UI selector
export interface StrategyPreset {
  id: string;
  name: string;
  description: string;
  config: StrategyConfig;
}

// AnonPay Types
export interface AnonPayRecipient {
  id: string;
  address: string;
  amount: number;
  status: 'PENDING' | 'QUEUED' | 'COMPLETED';
}

export interface TokenBalance {
  mint: string;
  symbol: string;
  balance: number;
  decimals: number;
}

// Ulti Cleaner Types
export type CleanerStage = 'IDLE' | 'DISTRIBUTING' | 'SELLING' | 'CONSOLIDATING' | 'FINAL_BUY' | 'COMPLETE';

export interface CleanerDestination {
    id: string;
    address: string;
    privateKey?: string; // Optional: If present, automated buy triggers
    status: 'PENDING' | 'FUNDED' | 'BOUGHT' | 'COMPLETE';
}

// Market Maker Types
export type MarketMakerMode = 'CONTINUOUS' | 'CYCLE' | 'MANUAL';
export type MarketMakerStrategy = 'TREND_FOLLOWING' | 'MEAN_REVERSION' | 'MOMENTUM' | 'ARBITRAGE' | 'CUSTOM';

export interface MarketMakerWallet {
  id: string;
  address: string;
  label: string;
  privateKey?: string; // Encrypted in production
  balanceSol: number;
  balanceTokens: number;
  entryPrice?: number;
  totalBought: number;
  totalSold: number;
  isWhitelisted: boolean;
  groupId?: string;
  buyPct?: number; // Percentage of group allocation for buys
  sellPct?: number; // Percentage of holdings to sell
  status: 'ACTIVE' | 'PAUSED' | 'EXHAUSTED';
}

export interface MarketMakerGroup {
  id: string;
  name: string;
  wallets: string[]; // Wallet IDs
  buyPct?: number; // Group-level buy percentage
  sellPct?: number; // Group-level sell percentage
  rotationEnabled: boolean;
}

export interface MarketMakerConfig {
  mode: MarketMakerMode;
  strategy: MarketMakerStrategy;
  tokenMint: string;
  minTradeAmount: number;
  maxTradeAmount: number;
  tradeDelayMs: number;
  cycleCount?: number; // For CYCLE mode
  targetPriceMin?: number;
  targetPriceMax?: number;
  spreadPct: number; // Bid-ask spread
  marketProtectionEnabled: boolean;
  marketProtectionTriggerPct: number; // Price dip % to trigger protection
  profitTakingEnabled: boolean;
  profitTargetPct: number;
  volumeStabilizationEnabled: boolean;
  usePrivacyMode: boolean; // Use privacy transfers for SOL
  whitelist: string[]; // Whitelisted wallet addresses
  waitForUnwhitelistedExit: boolean; // Wait for UWW to exit before next cycle
}

export interface MarketMakerOrder {
  id: string;
  walletId: string;
  type: 'BUY' | 'SELL';
  amount: number;
  price?: number; // Limit price (optional)
  status: 'PENDING' | 'EXECUTING' | 'COMPLETED' | 'FAILED' | 'CANCELLED';
  txHash?: string;
  timestamp: number;
  isManual: boolean;
}

export interface MarketMakerTransfer {
  id: string;
  type: 'DEPOSIT' | 'WITHDRAW' | 'REBALANCE' | 'CONSOLIDATE';
  fromWallet?: string;
  toWallet?: string;
  amount: number;
  status: 'PENDING' | 'COMPLETED' | 'FAILED';
  txHash?: string;
  timestamp: number;
  fees?: number;
}

export interface MarketMakerEvent {
  id: string;
  type: 'PRICE_CHANGE' | 'VOLUME_SPIKE' | 'LARGE_SELL' | 'WALLET_LOW_BALANCE' | 'TRADE' | 'TRANSFER';
  data: any;
  timestamp: number;
  wallet?: string;
  isUnwhitelisted?: boolean;
}

export interface MarketMakerStats {
  totalTrades: number;
  totalVolume: number;
  totalProfit: number;
  activeWallets: number;
  averageEntryPrice: number;
  currentPrice: number;
  priceChange24h: number;
  unwhitelistedHoldingsPct: number;
}

// --- Window Augmentation for Wallet & Google ---
declare global {
  interface Window {
    phantom?: {
        solana?: {
            isPhantom?: boolean;
            connect: (opts?: { onlyIfTrusted?: boolean }) => Promise<{ publicKey: { toString: () => string } }>;
            disconnect: () => Promise<void>;
            on: (event: string, callback: (args: any) => void) => void;
        }
    };
    solana?: {
      isPhantom?: boolean;
      connect: (opts?: { onlyIfTrusted?: boolean }) => Promise<{ publicKey: { toString: () => string } }>;
      disconnect: () => Promise<void>;
      on: (event: string, callback: (args: any) => void) => void;
    };
    solflare?: {
      connect: () => Promise<void>;
      publicKey: { toString: () => string };
      disconnect: () => Promise<void>;
    };
    google?: {
      accounts: {
        id: {
          initialize: (config: { client_id: string; callback: (response: any) => void; auto_select?: boolean }) => void;
          prompt: (notification?: (notification: any) => void) => void;
          renderButton: (parent: HTMLElement, options: any) => void;
        };
      };
    };
  }
}
