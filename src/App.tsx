
import React, { useState, useEffect, useRef } from 'react';
import { io as socketIOClient, Socket } from 'socket.io-client';
import {
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  AreaChart,
  Area,
  ReferenceLine,
  Line,
  LineChart,
  Scatter,
  ScatterChart,
  Bar,
  BarChart,
  ComposedChart,
  Legend
} from 'recharts';
import { Shield, WalletIcon, Activity, Play, Pause, Settings, Upload, X, Plus, RefreshCw, Users, ArrowRight, Key, Save, Ghost, CreditCard, Layers, CheckCircle, Lock, EyeOff, Sparkles, Trash2, Globe, BookOpen, ChevronDown, ChevronUp, Phantom, Solflare } from './components/Icons';
import StatsCard from './components/StatsCard';
import { Leaderboard } from './components/Leaderboard';
import MarketMaker from './components/MarketMaker';
import { parseWalletCSV, parseAnonPayCSV } from './services/csvService';
import { AppState, Wallet, WalletGroup, TradeConfig, Transaction, MarketData, SpecialWallet, CyclePhase, StrategyPreset, SpecialRole, StrategyConfig, PrivacyState, PrivacyQueueItem, AppTab, AnonPayRecipient, UserRole, UserProfile, WalletProvider, CleanerDestination, CleanerStage, TokenBalance, PauseMode } from './types';
import * as solanaWeb3 from "@solana/web3.js";
import {
  getAssociatedTokenAddress,
  createTransferInstruction,
  createAssociatedTokenAccountInstruction,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { PrivacyCashDirect } from "./lib/privacyCashDirect";

// --- Helpers ---
const generateAddress = () => `Sol${Math.random().toString(36).substring(2, 8)}...${Math.random().toString(36).substring(2, 6)}`;
const generateRelayerAddress = () => `Relay${Math.random().toString(36).substring(2, 6)}...${Math.random().toString(36).substring(2, 4)}`;
const generateMixerAddress = () => `Mix${Math.random().toString(36).substring(2, 6)}...Shield`;
const generatePrivateKey = () => Array.from({length: 64}, () => Math.floor(Math.random() * 16).toString(16)).join('');
const generateZKProof = () => `zk-snark-${Math.random().toString(36).substring(2)}`;
const randRange = (min: number, max: number) => Math.random() * (max - min) + min;

// --- Constants ---
const BONDING_CURVE_LIMIT = 69000; // $69k MC standard pump.fun limit
const ANON_PAY_FEE_PER_TX = 0.001;
const FEE_COLLECTOR_WALLET = "OIURTHIU*&5r,a.kea;oijsdpoi]aYTUYQPUHb12";
const DEFAULT_ACCESS_PASSWORD = "321$nimda"; 
const DEFAULT_ADMIN_PASSWORD = "321$nimda"; // Known mints for display
const API_BASE = '';  // Use relative paths - works on both localhost and production
const KNOWN_MINTS: Record<string, string> = {
  "So11111111111111111111111111111111111111112": "SOL",
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v": "USDC",
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB": "USDT",
  "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263": "BONK",
};

// --- Strategies ---
const INITIAL_STRATEGIES: StrategyPreset[] = [
  {
    id: 'CYCLE_1_AGGRESSIVE',
    name: 'Cycle 1: Aggressive Volume',
    description: '5 Wallets. Buy 98% upfront. Sell 20-30% on Intruder detection.',
    config: {
      initialBuySolPct: 98,
      intruderTriggerPct: 0.5,
      intruderActions: [{ type: 'ALERT' }, { type: 'SELL_GROUP_PERCENT', percentage: 25 }],
      groupSellPctMin: 20,
      groupSellPctMax: 30,
      targetSupplyBuyMin: 0.5,
      targetSupplyBuyMax: 1.5,
      cyclePauseTimeSec: 5,
      pauseMode: 'FIXED',
      usePrivacyMode: true,
      monitoringRules: { takeProfitPct: 25, stopLossPct: 15, maxHoldSec: 3600 }
    }
  },
  {
    id: 'PROFIT_BUILDER',
    name: 'Profit Builder (Tiered)',
    description: 'Slow accumulation. Buys 40%. Strict 10% sells on intrusion.',
    config: {
      initialBuySolPct: 40,
      intruderTriggerPct: 1.0,
      intruderActions: [{ type: 'ALERT' }, { type: 'SELL_GROUP_PERCENT', percentage: 12 }],
      groupSellPctMin: 10,
      groupSellPctMax: 15,
      targetSupplyBuyMin: 0.2,
      targetSupplyBuyMax: 0.8,
      cyclePauseTimeSec: 10,
      pauseMode: 'WAIT_FOR_EXIT',
      usePrivacyMode: true,
      monitoringRules: { takeProfitPct: 25, stopLossPct: 15, maxHoldSec: 3600 }
    }
  },
  {
    id: 'SCALP_DEFENSE',
    name: 'Scalp & Defense',
    description: 'Buy 60%. High sensitivity trigger (0.2%). Fast exits.',
    config: {
      initialBuySolPct: 60,
      intruderTriggerPct: 0.2,
      intruderActions: [{ type: 'ALERT' }, { type: 'SELL_GROUP_PERCENT', percentage: 45 }],
      groupSellPctMin: 40,
      groupSellPctMax: 50,
      targetSupplyBuyMin: 0.5,
      targetSupplyBuyMax: 1.0,
      cyclePauseTimeSec: 2,
      pauseMode: 'FIXED',
      usePrivacyMode: false
    }
  }
];

// --- Initial State ---
const INITIAL_SPECIAL_WALLETS: SpecialWallet[] = [
  { role: 'FUNDING', address: 'FUND_Main...Xy9', balanceSol: 0.0, privateKey: '' },
  { role: 'PROFIT', address: 'PROF_Vault...8pK', balanceSol: 0.0, privateKey: '' },
  { role: 'DEVELOPER', address: 'DEV_Ops...3mQ', balanceSol: 0.0, privateKey: '' },
];

const INITIAL_MARKET_DATA: MarketData = {
  marketCap: 42000,
  priceUsd: 0.000042,
  totalSupply: 1_000_000_000, // 1 Billion
  bondingCurveProgress: 0,
  intruderHoldings: 0
};

const INITIAL_PRIVACY_STATE: PrivacyState = {
  shadowPoolBalanceSol: 0,
  shadowPoolBalanceTokens: 0,
  totalVolumeAnonymized: 0,
  queue: []
};

// --- Sub-Components ---
const InfoPanel = ({ title, children }: { title: string, children?: React.ReactNode }) => {
    const [isOpen, setIsOpen] = useState(false);
    return (
        <div className="bg-surface border border-gray-700 rounded-xl overflow-hidden mb-6">
            <button 
                onClick={() => setIsOpen(!isOpen)}
                className="w-full flex items-center justify-between p-4 bg-gray-800/50 hover:bg-gray-800 transition-colors"
            >
                <div className="flex items-center gap-2 text-primary font-bold">
                    <BookOpen className="w-4 h-4"/> {title}
                </div>
                {isOpen ? <ChevronUp className="w-4 h-4 text-gray-400"/> : <ChevronDown className="w-4 h-4 text-gray-400"/>}
            </button>
            {isOpen && (
                <div className="p-5 border-t border-gray-700 text-sm text-gray-300 leading-relaxed space-y-4">
                    {children}
                </div>
            )}
        </div>
    );
};

const App: React.FC = () => {
  // --- Auth State ---
  const [userProfile, setUserProfile] = useState<UserProfile | null>(null);
  const [showLoginModal, setShowLoginModal] = useState(false);
  
const [showProfileModal, setShowProfileModal] = useState(false);
  const [profileWallet, setProfileWallet] = useState('');
  const [profileUsername, setProfileUsername] = useState('');
  const [profileReferral, setProfileReferral] = useState('');
  const [profileTwitter, setProfileTwitter] = useState('');
  const [profileTikTok, setProfileTikTok] = useState('');
  const [profileFacebook, setProfileFacebook] = useState('');

  const [loginPasswordInput, setLoginPasswordInput] = useState('');
    const [loginError, setLoginError] = useState('');
  const isLoggedIn = !!userProfile;


const loadUltibotConfig = async () => {
  try {
    console.log('Loading ultibot config...');
    const token = getToken();
    console.log('Current token:', token ? 'present' : 'missing');
    const res = await authFetch('/api/ultibot/config', { method: 'GET' });
    console.log('Config response status:', res.status);
    if (!res.ok) {
      const errorText = await res.text();
      console.error('Config load failed:', res.status, errorText);
      return;
    }
    const j = await res.json();
    console.log('Config loaded:', j);
    const cfg = j.botConfig || {};
    if (cfg.rpcUrl) setRpcUrl(cfg.rpcUrl);
    if (cfg.intruderTriggerPct != null) setIntruderTriggerPct(cfg.intruderTriggerPct);
    if (cfg.groupSellPctMin != null) setGroupSellPctMin(cfg.groupSellPctMin);
    if (cfg.groupSellPctMax != null) setGroupSellPctMax(cfg.groupSellPctMax);
    if (cfg.whitelist) setWhitelist(cfg.whitelist);
    if (cfg.intruderActions) setIntruderActions(cfg.intruderActions);
    if (cfg.monitoringRules) setMonitoringRules(cfg.monitoringRules);
    if (cfg.tokenMint) setMonitoredTokenAddress(cfg.tokenMint);
    if (cfg.enabled != null) {
      setBotEnabled(cfg.enabled);
      console.log('Bot enabled status set to:', cfg.enabled);
    }
  } catch (error) {
    console.error('Config load error:', error);
  }
};

useEffect(() => {
  if (getToken()) {
    loadUltibotConfig();
    
    // Refresh balances for wallets that have private keys saved (after config loads)
    const refreshWalletBalances = async () => {
      // Wait a bit for config to load
      await new Promise(resolve => setTimeout(resolve, 500));
      
      for (const wallet of specialWallets) {
        if (wallet.privateKey) {
          try {
            const res = await authFetch('/api/wallet/balance', {
              method: 'POST',
              body: JSON.stringify({
                privateKey: wallet.privateKey,
                rpcUrl: rpcUrl || undefined
              })
            });
            
            if (res.ok) {
              const data = await res.json();
              setSpecialWallets(prev => prev.map(w => {
                if (w.role === wallet.role) {
                  return {
                    ...w,
                    address: data.publicKey,
                    balanceSol: data.balance || 0
                  };
                }
                return w;
              }));
            }
          } catch (e) {
            console.error(`Failed to refresh balance for ${wallet.role}:`, e);
          }
        }
      }
    };
    
    setTimeout(refreshWalletBalances, 1000);
  }
}, [isLoggedIn]);

  // --- View Mode (Landing vs App) ---
  const [viewMode, setViewMode] = useState<'LANDING' | 'APP'>('LANDING');

  // --- Admin Gate State ---
  const [adminPassword, setAdminPassword] = useState(DEFAULT_ADMIN_PASSWORD);
  const [globalAccessPassword, setGlobalAccessPassword] = useState(DEFAULT_ACCESS_PASSWORD);
  const [showAdminGateModal, setShowAdminGateModal] = useState(false);
  const [adminGateInput, setAdminGateInput] = useState('');
  const [adminGateError, setAdminGateError] = useState('');
  const [pendingAdminTab, setPendingAdminTab] = useState<AppTab | null>(null);

  // --- State ---
  const [currentUserRole, setCurrentUserRole] = useState<UserRole>('USER');
  const [activeTab, setActiveTab] = useState<AppTab>('ANONPAY'); 
  
  const [appState, setAppState] = useState<AppState>(AppState.IDLE);
  const [cycleCount, setCycleCount] = useState(1);
  const [marketData, setMarketData] = useState<MarketData>(INITIAL_MARKET_DATA);
  
  // Strategy State
  const [strategies, setStrategies] = useState<StrategyPreset[]>(INITIAL_STRATEGIES);
  const [selectedStrategyId, setSelectedStrategyId] = useState<string>(INITIAL_STRATEGIES[0].id);
  const [config, setConfig] = useState<TradeConfig>({
    targetMarketCapSell: 200000, 
    monitoredTokenAddress: '',
    walletsPerCycle: 5,
    strategy: INITIAL_STRATEGIES[0].config
  });
  
  
const [unwhitelistedPct, setUnwhitelistedPct] = useState<number>(0);
const socketRef = useRef<Socket | null>(null);
const walletGroupsRef = useRef<WalletGroup[]>([]);
const [walletGroups, setWalletGroups] = useState<WalletGroup[]>([]);
  const [specialWallets, setSpecialWallets] = useState<SpecialWallet[]>(INITIAL_SPECIAL_WALLETS);
  const [privacyState, setPrivacyState] = useState<PrivacyState>(INITIAL_PRIVACY_STATE);
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [chartData, setChartData] = useState<{ time: string; marketCap: number; price: number }[]>([]);
  const [tradingChartData, setTradingChartData] = useState<Array<{
    time: string;
    price: number;
    marketCap: number;
    buyVolume?: number;
    sellVolume?: number;
    buyCount?: number;
    sellCount?: number;
    buys?: Array<{ price: number; volume: number }>;
    sells?: Array<{ price: number; volume: number }>;
  }>>([]);
  const [logs, setLogs] = useState<string[]>(["System initialized.", "Login to access Ultibot Tools."]);

  // Fetch wallet groups from backend
  const fetchWalletGroups = async () => {
    try {
      const response = await authFetch('/api/ultibot/wallet-groups');
      if (response.ok) {
        const data = await response.json();
        setWalletGroups(data.groups || []);
      }
    } catch (e) {
      console.error('Failed to fetch wallet groups:', e);
    }
  };

  // Save wallet group to backend
  const saveWalletGroupToBackend = async (group: WalletGroup) => {
    try {
      await authFetch('/api/ultibot/wallet-groups', {
        method: 'POST',
        body: JSON.stringify({
          id: group.id,
          name: group.name,
          cycleNumber: group.cycleNumber,
          isActive: group.isActive,
          phase: group.phase,
          hasDefended: group.hasDefended,
          entryPriceUsd: group.entryPriceUsd,
          entryMarketCap: group.entryMarketCap,
          startTime: group.startTime,
          initialBuySolPct: group.initialBuySolPct,
          intruderTriggerPct: group.intruderTriggerPct,
          groupSellPctMin: group.groupSellPctMin,
          groupSellPctMax: group.groupSellPctMax,
          walletsPerGroup: group.walletsPerGroup,
          tpStopLossPairs: group.tpStopLossPairs,
          marketCapTakeProfit: group.marketCapTakeProfit,
        }),
      });
    } catch (e) {
      console.error('Failed to save wallet group:', e);
    }
  };

  // Auto-save wallet groups with debouncing
  useEffect(() => {
    const timeoutId = setTimeout(() => {
      walletGroups.forEach(group => {
        // Only save groups that have been modified (not just loaded from backend)
        if (group.id && (group.initialBuySolPct !== undefined || group.intruderTriggerPct !== undefined || 
            group.tpStopLossPairs || group.marketCapTakeProfit)) {
          saveWalletGroupToBackend(group).catch(console.error);
        }
      });
    }, 2000); // Debounce 2 seconds

    return () => clearTimeout(timeoutId);
  }, [walletGroups]);
  
  // AnonPay State
  const [anonPayRecipients, setAnonPayRecipients] = useState<AnonPayRecipient[]>([]);
  const [anonPayRecipientInput, setAnonPayRecipientInput] = useState('');
  const [anonPayAmountMode, setAnonPayAmountMode] = useState<'FIXED' | 'PERCENTAGE'>('FIXED');
  const [anonPayMinAmount, setAnonPayMinAmount] = useState(0.1);
  const [anonPayMaxAmount, setAnonPayMaxAmount] = useState(0.5);
  const [anonPayMinPct, setAnonPayMinPct] = useState(1);
  const [anonPayMaxPct, setAnonPayMaxPct] = useState(5);
  const [anonPayDelaySeconds, setAnonPayDelaySeconds] = useState(0);
  const [anonPayPrivacyEnabled, setAnonPayPrivacyEnabled] = useState(true);
  
  // Wallet Connection State
  const [showWalletModal, setShowWalletModal] = useState(false);
  const [showPromoCodeModal, setShowPromoCodeModal] = useState(false);
  const [pendingWalletAddress, setPendingWalletAddress] = useState<string>('');
  const [promoCodeInput, setPromoCodeInput] = useState('');
  const [userWalletConnected, setUserWalletConnected] = useState(false);
  const [connectedProvider, setConnectedProvider] = useState<WalletProvider>('NONE');
  const [connectedAddress, setConnectedAddress] = useState<string>('');
  const [userWalletBalance, setUserWalletBalance] = useState(0);
  const [userTokens, setUserTokens] = useState<TokenBalance[]>([]);
  const [userPromoCode, setUserPromoCode] = useState<string>('');
  
  // AnonPay Asset Config
  const [anonPaySelectedAssetMint, setAnonPaySelectedAssetMint] = useState<string>('SOL'); // 'SOL' or mint address

  // Ulti Cleaner State
  const [cleanerDestinations, setCleanerDestinations] = useState<CleanerDestination[]>([]);
  const [cleanerInput, setCleanerInput] = useState('');
  const [ultiCleanerFee, setUltiCleanerFee] = useState(0.001);
  const [cleanerStage, setCleanerStage] = useState<CleanerStage>('IDLE');
  const [cleanerLogs, setCleanerLogs] = useState<string[]>([]);
  const [cleanerTokenMint, setCleanerTokenMint] = useState('');

  const fileInputRef = useRef<HTMLInputElement>(null);

  // Modal States
  const [showKeyModal, setShowKeyModal] = useState(false);
  const [editingWalletRole, setEditingWalletRole] = useState<SpecialRole | null>(null);
  const [tempPrivateKey, setTempPrivateKey] = useState('');
  
  // Pause Logic
  const nextCycleTimeoutRef = useRef<number | null>(null);
  const intervalRef = useRef<number | null>(null);

  // Mock Users for Admin Panel
  const [adminUsers, setAdminUsers] = useState<{id: string, role: UserRole, email: string}[]>([
      { id: '1', role: 'OWNER', email: 'owner@ultibots.xyz' },
  ]);
  const [newAdminEmail, setNewAdminEmail] = useState('');
  const [newPasswordInput, setNewPasswordInput] = useState('');
  const [newAdminPasswordInput, setNewAdminPasswordInput] = useState('');
  
  // Profile Management State
  const [adminProfiles, setAdminProfiles] = useState<any[]>([]);
  const [profileSearchTerm, setProfileSearchTerm] = useState('');
  const [editingProfile, setEditingProfile] = useState<any | null>(null);
  const [editProfileTwitter, setEditProfileTwitter] = useState('');
  const [editProfileTikTok, setEditProfileTikTok] = useState('');
  const [editProfileFacebook, setEditProfileFacebook] = useState('');

  // --- Profile Management Functions ---
  const handleEditProfile = (profile: any) => {
    setEditingProfile(profile);
    setEditProfileTwitter(profile.twitter_handle || '');
    setEditProfileTikTok(profile.tiktok_handle || '');
    setEditProfileFacebook(profile.facebook_handle || '');
  };

  const handleDeleteProfile = async (walletAddress: string) => {
    if (!confirm(`Are you sure you want to delete profile for wallet ${walletAddress}?`)) return;

    try {
      const res = await fetch('/api/admin/profiles/' + encodeURIComponent(walletAddress), {
        method: 'DELETE'
      });
      if (res.ok) {
        setAdminProfiles(prev => prev.filter(p => p.wallet !== walletAddress));
        addLog(`🗑️ Profile deleted: ${walletAddress}`);
      } else {
        alert('Failed to delete profile');
      }
    } catch (e) {
      alert('Error deleting profile');
    }
  };

  const handleSaveProfile = async () => {
    if (!editingProfile) return;

    try {
      const res = await fetch('/api/admin/profiles/' + encodeURIComponent(editingProfile.wallet), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          twitter_handle: editProfileTwitter.trim() || null,
          tiktok_handle: editProfileTikTok.trim() || null,
          facebook_handle: editProfileFacebook.trim() || null
        })
      });
      if (res.ok) {
        setAdminProfiles(prev => prev.map(p =>
          p.wallet === editingProfile.wallet ? {
            ...p,
            twitter_handle: editProfileTwitter.trim() || null,
            tiktok_handle: editProfileTikTok.trim() || null,
            facebook_handle: editProfileFacebook.trim() || null
          } : p
        ));
        setEditingProfile(null);
        addLog(`💾 Profile updated: ${editingProfile.wallet}`);
      } else {
        alert('Failed to update profile');
      }
    } catch (e) {
      alert('Error updating profile');
    }
  };

  // Site Fee Management
  const [siteFees, setSiteFees] = useState({
    anonPayFee: 0.001,
    cleanerFee: 0.001,
    marketMakerFee: 0.001,
    defaultFee: 0.001,
  });

  // Market Maker State
  const [mmWallets, setMmWallets] = useState<any[]>([]);
  const [mmGroups, setMmGroups] = useState<any[]>([]);
  const [mmConfig, setMmConfig] = useState<any>(null);
  const [mmOrders, setMmOrders] = useState<any[]>([]);
  const [mmTransfers, setMmTransfers] = useState<any[]>([]);
  const [mmStats, setMmStats] = useState<any>(null);
  const [mmEvents, setMmEvents] = useState<any[]>([]);
  const [mmChartData, setMmChartData] = useState<any[]>([]);
  const [mmIsRunning, setMmIsRunning] = useState(false);
  const [showMmWalletModal, setShowMmWalletModal] = useState(false);
  const [showMmOrderModal, setShowMmOrderModal] = useState(false);
  const [showMmTransferModal, setShowMmTransferModal] = useState(false);
  const [mmNewWalletAddress, setMmNewWalletAddress] = useState('');
  const [mmNewWalletLabel, setMmNewWalletLabel] = useState('');
  const [mmNewWalletPrivateKey, setMmNewWalletPrivateKey] = useState('');
  const [mmSelectedWallets, setMmSelectedWallets] = useState<string[]>([]);

  // --- ULTIBOT CONFIG STATE ---
  const [rpcUrl, setRpcUrl] = useState<string>('');
  const [botSecretKeyInput, setBotSecretKeyInput] = useState<string>('');
  const [intruderTriggerPct, setIntruderTriggerPct] = useState(0.5);
  const [groupSellPctMin, setGroupSellPctMin] = useState(10);
  const [groupSellPctMax, setGroupSellPctMax] = useState(50);
  const [whitelist, setWhitelist] = useState<string[]>([]);
  const [intruderActions, setIntruderActions] = useState<any[]>([]);
  const [monitoringRules, setMonitoringRules] = useState<any[]>([]);
  const [monitoredTokenAddress, setMonitoredTokenAddress] = useState('');
  const [botEnabled, setBotEnabled] = useState(false);
  const [botStatus, setBotStatus] = useState('Idle');
  const [walletsPerCycle, setWalletsPerCycle] = useState(5);

  // --- SAFETY: HTTPS ENFORCEMENT ---
  useEffect(() => {
    if (window.location.hostname !== 'localhost' && window.location.protocol !== 'https:') {
        window.location.href = window.location.href.replace('http:', 'https:');
    }
  }, []);

  // Helper functions for intruder handling (defined early for socket use)
  const randInt = (min: number, max: number) => Math.floor(randRange(min, max+1));

  // Update ref whenever walletGroups changes
  useEffect(() => {
    walletGroupsRef.current = walletGroups;
  }, [walletGroups]);

  const executeGroupSell = async (groupId: string, sellPct: number, reason: string) => {
    try {
      addLog(`💰 Executing group sell ${sellPct.toFixed(1)}% (${reason}) on ${groupId}...`);
      const res = await authFetch(`/api/ultibot/groups/${groupId}/sell`, {
        method: 'POST',
        body: JSON.stringify({ sellPct, reason }),
      });
      
      if (res.ok) {
        const data = await res.json();
        addLog(`✅ Group sell completed: ${data.sold} positions sold`);
        if (data.errors && data.errors.length > 0) {
          data.errors.forEach((err: string) => addLog(`⚠️ ${err}`));
        }
        // Refresh wallet groups
        fetchWalletGroups();
      } else {
        const error = await res.text();
        addLog(`❌ Group sell failed: ${error}`);
      }
    } catch (e: any) {
      addLog(`❌ Error executing group sell: ${String(e?.message || e)}`);
    }
  };

  const executeUnwhitelistedSellFromActiveGroup = async () => {
    if (!walletGroups.some(g => g.isActive)) {
      addLog('⚠️ No active wallet group to sell unwhitelisted from.');
      return;
    }

    try {
      addLog(`💰 Executing unwhitelisted sell from active group...`);
      const res = await authFetch('/api/ultibot/sell-unwhitelisted', {
        method: 'POST',
      });
      
      if (res.ok) {
        const data = await res.json();
        addLog(`✅ Unwhitelisted sell completed: ${data.sold} positions sold`);
        if (data.errors && data.errors.length > 0) {
          data.errors.forEach((err: string) => addLog(`⚠️ ${err}`));
        }
        // Refresh wallet groups
        fetchWalletGroups();
      } else {
        const error = await res.text();
        addLog(`❌ Unwhitelisted sell failed: ${error}`);
      }
    } catch (e: any) {
      addLog(`❌ Error executing unwhitelisted sell: ${String(e?.message || e)}`);
    }
  };

  const maybeCompleteGroup = (groupId: string) => {
    setWalletGroups(prev => prev.map(g => {
      if (g.id !== groupId) return g;
      const allExited = g.wallets.every(w => w.balanceTokens <= 0.00000001 || w.status === 'EXITED');
      if (!allExited) return g;
      addLog(`✅ Cycle COMPLETE for ${groupId}`);
      return { ...g, phase: CyclePhase.COMPLETE, isActive: false };
    }));
  };

  const handleIntruderTrigger = (evt: any) => {
    const actions = (config.strategy.intruderActions ?? [{ type: 'ALERT' }]) as any[];
    const activeGroup = walletGroupsRef.current.find(g => g.isActive);
    const groupId = activeGroup?.id;
    
    if (!groupId) return;
    
    actions.forEach(a => {
      if (a.type === 'PAUSE') {
        setAppState(AppState.PAUSED_SAFETY);
        addLog('⏸️ Paused (Intruder action)');
      }
      if (a.type === 'SELL_GROUP_PERCENT' && groupId) {
        const pct = Number(a.percentage ?? randInt(config.strategy.groupSellPctMin, config.strategy.groupSellPctMax));
        executeGroupSell(groupId, pct, 'intruder trigger');
        maybeCompleteGroup(groupId);
      }
      if (a.type === 'ALERT') {
        addLog(`🚨 Intruder Alert: ${evt.pct?.toFixed(2)}% unwhitelisted holdings detected`);
      }
    });
  };

  // Fetch admin profiles
  const fetchAdminProfiles = async () => {
    try {
      const res = await fetch('/api/admin/profiles');
      if (res.ok) {
        const data = await res.json();
        setAdminProfiles(data);
      } else {
        console.error('Failed to fetch admin profiles');
      }
    } catch (e) {
      console.error('Error fetching admin profiles:', e);
    }
  };

  // Fetch admin profiles when admin tab is active
  useEffect(() => {
    if (activeTab === 'ADMIN' && (currentUserRole === 'ADMIN' || currentUserRole === 'OWNER')) {
      fetchAdminProfiles();
    }
  }, [activeTab, currentUserRole]);

  // --- Socket.IO Connection for Real-time Updates ---
  useEffect(() => {
    console.log('Initializing Socket.IO connection...');
    // Use window.location.origin for Vite proxy, or direct connection in production
    // Use window.location.origin for Vite proxy (works in dev)
    // The proxy in vite.config.ts routes /socket.io to backend
    const socket = socketIOClient(window.location.origin, {
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionAttempts: Infinity,
      timeout: 20000
    });
    socketRef.current = socket;

    socket.on('connect', () => {
      console.log('Socket.IO connected successfully');
      addLog('🔌 Connected to server');
    });

    socket.on('disconnect', () => {
      console.log('Socket.IO disconnected');
      addLog('🔌 Disconnected from server');
    });

    socket.on('connect_error', (error) => {
      console.error('Socket.IO connection error:', error);
      addLog(`🔌 Connection error: ${error.message}`);
    });

    socket.on('unwhitelisted_pct', (data: { unwhitelistedPctTopAccounts: number; ts: number }) => {
      setUnwhitelistedPct(data.unwhitelistedPctTopAccounts);
    });

    // Wallet group updates
    socket.on('wallet_group_updated', (data: any) => {
      fetchWalletGroups();
    });

    socket.on('wallet_group_deleted', (data: { groupId: string }) => {
      setWalletGroups(prev => prev.filter(g => g.id !== data.groupId));
    });

    socket.on('position_sold', (data: any) => {
      fetchWalletGroups();
      addLog(`💰 Position sold: ${data.positionId.substring(0, 8)}... (${data.sellPct}%)`);
    });

    socket.on('wallets_imported', (data: { cycleId: string; count: number }) => {
      fetchWalletGroups();
      addLog(`✅ Imported ${data.count} wallets to cycle ${data.cycleId.substring(0, 8)}...`);
    });

    socket.on('intruder_trigger', (data: any) => {
      addLog(`🚨 Intruder Trigger: ${data.pct?.toFixed(2)}% unwhitelisted holdings (threshold: ${data.trigger}%)`);
      handleIntruderTrigger(data);
    });

    socket.on('trade_event', (event: any) => {
      if (event.type === 'BUY' || event.type === 'SELL') {
        addLog(`📊 ${event.type}: ${event.wallet?.substring(0, 8)}... ${event.deltaTokenUi?.toFixed(2) || ''} tokens, ${event.deltaSol?.toFixed(4) || ''} SOL`);
        setTransactions(prev => {
          // Access current config state via setConfig callback pattern
          return [{
            id: event.signature,
            hash: event.signature,
            sender: event.wallet,
            type: event.type,
            amountSol: Math.abs(event.deltaSol || 0),
            timestamp: event.timestamp || Date.now(),
            isIntruder: false, // Will be determined by current whitelist state
          }, ...prev].slice(0, 50);
        });

        // Update trading chart with buy/sell events
        const currentPrice = event.priceUsd || marketData.priceUsd;
        const currentMC = event.marketCapUsd || marketData.marketCap;
        const time = new Date().toLocaleTimeString();
        
        setTradingChartData(prev => {
          const last = prev[prev.length - 1];
          const newData = {
            time,
            price: currentPrice,
            marketCap: currentMC,
            buyVolume: event.type === 'BUY' ? (last?.buyVolume || 0) + Math.abs(event.deltaSol || 0) : last?.buyVolume || 0,
            sellVolume: event.type === 'SELL' ? (last?.sellVolume || 0) + Math.abs(event.deltaSol || 0) : last?.sellVolume || 0,
            buyCount: event.type === 'BUY' ? (last?.buyCount || 0) + 1 : last?.buyCount || 0,
            sellCount: event.type === 'SELL' ? (last?.sellCount || 0) + 1 : last?.sellCount || 0,
            buys: event.type === 'BUY' ? [...(last?.buys || []), { price: currentPrice, volume: Math.abs(event.deltaSol || 0) }].slice(-10) : last?.buys || [],
            sells: event.type === 'SELL' ? [...(last?.sells || []), { price: currentPrice, volume: Math.abs(event.deltaSol || 0) }].slice(-10) : last?.sells || [],
          };
          return [...prev, newData].slice(-100); // Keep last 100 data points
        });
      }
    });

    socket.on('server_error', (data: { message: string }) => {
      addLog(`⚠️ Server Error: ${data.message}`);
    });

    socket.on('ultibot_event', (event: any) => {
      const levelEmoji = {
        'INFO': 'ℹ️',
        'WARN': '⚠️',
        'ERROR': '❌'
      }[event.level] || '📝';

      const logMsg = `${levelEmoji} [${event.type}] ${event.message}`;
      addLog(logMsg);

      // Update bot status based on events
      if (event.type === 'ENGINE_START') {
        setAppState(AppState.RUNNING);
      } else if (event.type === 'ENGINE_STOP') {
        setAppState(AppState.IDLE);
      } else if (event.type === 'CYCLE_COMPLETE') {
        addLog(`🔄 Cycle completed - ready for next cycle`);
        setCycleCount(prev => prev + 1);
      }
    });

    socket.on('ultibot_metrics', (data: any) => {
      // Update market data with real-time metrics
      setMarketData(prev => ({
        ...prev,
        marketCap: data.marketCapUsd || prev.marketCap,
        price: data.priceUsd || prev.price,
        bondingCurveProgress: data.intruderPct ? Math.min(100, data.intruderPct * 2) : prev.bondingCurveProgress
      }));

      setUnwhitelistedPct(data.intruderPct || 0);
    });

    socket.on('bot_config', (config: any) => {
      console.log('Received bot_config:', config);
      // Update bot configuration when server broadcasts changes
      if (config.enabled !== undefined) {
        setBotEnabled(config.enabled);
        setBotStatus(config.enabled ? 'Running (server-side)' : 'Stopped');
        console.log('Bot status updated:', config.enabled ? 'running' : 'stopped');
        // Refresh wallet groups when bot state changes
        fetchWalletGroups();
      }
      if (config.monitoringRules) {
        setConfig(prev => ({
          ...prev,
          strategy: {
            ...prev.strategy,
            monitoringRules: config.monitoringRules
          }
        }));
      }
      if (config.tokenMint) {
        setMonitoredTokenAddress(config.tokenMint);
      }
    });

    // Listen for privacy funding requests from backend
    // Use state setter to access current values
    socket.on('privacy_funding_request', (data: any) => {
      console.log('Privacy funding request:', data);
      setSpecialWallets(current => {
        const fundingWallet = current.find(w => w.role === 'FUNDING');
        if (fundingWallet && fundingWallet.privateKey) {
          // Use existing privacy transfer system
          queuePrivacyTransfer(
            'FUNDING',
            undefined,
            undefined,
            data.walletId,
            data.amountSol,
            1000 + (data.walletIndex * 800), // Stagger delays
            data.walletPubkey
          );
          addLog(`🛡️ Privacy funding queued: ${data.amountSol.toFixed(4)} SOL → Wallet ${data.walletIndex + 1}`);
        } else {
          addLog(`⚠️ Privacy funding requested but FUNDING wallet key not set`);
        }
        return current; // Return unchanged
      });
    });

    // Listen for privacy profit transfers
    socket.on('privacy_profit_transfer', (data: any) => {
      console.log('Privacy profit transfer:', data);
      setSpecialWallets(current => {
        const profitWallet = current.find(w => w.role === 'PROFIT');
        if (profitWallet && profitWallet.privateKey) {
          // Queue transfer from cycle wallet to profit wallet via Shadow Pool
          queuePrivacyTransfer(
            undefined,
            undefined, // fromWalletId - will be set by backend
            'PROFIT',
            undefined,
            data.amountSol,
            2000,
            data.toWallet
          );
          addLog(`💰 Privacy profit transfer queued: ${data.amountSol.toFixed(4)} SOL → Profit Wallet`);
        }
        return current;
      });
    });

    // Listen for privacy funding returns
    socket.on('privacy_funding_return', (data: any) => {
      console.log('Privacy funding return:', data);
      setSpecialWallets(current => {
        const fundingWallet = current.find(w => w.role === 'FUNDING');
        if (fundingWallet && fundingWallet.privateKey) {
          // Queue transfer from cycle wallet back to funding wallet via Shadow Pool
          queuePrivacyTransfer(
            undefined,
            undefined, // fromWalletId - will be set by backend
            'FUNDING',
            undefined,
            data.amountSol,
            2000,
            data.toWallet
          );
          addLog(`🔄 Privacy funding return queued: ${data.amountSol.toFixed(4)} SOL → Funding Wallet`);
        }
        return current;
      });
    });

    return () => {
      // Clean up all event listeners properly
      socket.off('connect');
      socket.off('disconnect');
      socket.off('connect_error');
      socket.off('unwhitelisted_pct');
      socket.off('intruder_trigger');
      socket.off('trade_event');
      socket.off('server_error');
      socket.off('ultibot_event');
      socket.off('ultibot_metrics');
      socket.off('bot_config');
      socket.off('privacy_funding_request');
      socket.off('privacy_profit_transfer');
      socket.off('privacy_funding_return');
      socket.disconnect();
    };
  }, []); // Empty deps - only initialize once on mount

  const addLog = (msg: string) => {
    setLogs(prev => [ `[${new Date().toLocaleTimeString()}] ${msg}`, ...prev].slice(0, 50));
  };

  const addCleanerLog = (msg: string) => {
      setCleanerLogs(prev => [ `> ${msg}`, ...prev]);
  };

  // --- REAL RPC FETCHING ---
  const fetchWalletBalances = async (publicKey: string) => {
      addLog(`🔄 Fetching real balances for ${publicKey.substring(0,6)}...`);
      
      try {
          // 1. Fetch SOL Balance
          const solResponse = await fetch('/api/solana/token-info?mint=' + encodeURIComponent(monitoredTokenAddress), {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                  jsonrpc: "2.0",
                  id: 1,
                  method: "getBalance",
                  params: [publicKey]
              })
          });
          const solData = await solResponse.json();
          const solBalance = (solData.result?.value || 0) / 1_000_000_000;
          setUserWalletBalance(solBalance);

          // 2. Fetch Token Accounts
          const tokenResponse = await fetch('/api/solana/token-info?mint=' + encodeURIComponent(monitoredTokenAddress), {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                  jsonrpc: "2.0",
                  id: 2,
                  method: "getTokenAccountsByOwner",
                  params: [
                      publicKey,
                      { programId: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" },
                      { encoding: "jsonParsed" }
                  ]
              })
          });
          const tokenData = await tokenResponse.json();
          const accounts = tokenData.result?.value || [];
          
          const parsedTokens: TokenBalance[] = accounts.map((acc: any) => {
              const info = acc.account.data.parsed.info;
              const mint = info.mint;
              const amount = info.tokenAmount.uiAmount;
              const decimals = info.tokenAmount.decimals;
              
              // Determine symbol
              const symbol = KNOWN_MINTS[mint] || `${mint.substring(0,4)}...${mint.substring(mint.length-4)}`;

              return { mint, symbol, balance: amount, decimals };
          }).filter((t: TokenBalance) => t.balance > 0); // Only show non-zero balances

          setUserTokens(parsedTokens);
          addLog(`✅ Balances Updated: ${solBalance.toFixed(3)} SOL, ${parsedTokens.length} Tokens found.`);

      } catch (err) {
          console.error("RPC Fetch Error:", err);
          addLog("⚠️ Failed to fetch real balances. Using cached/simulated data.");
          // Fallback for demo if RPC fails
          setUserWalletBalance(1.5); 
      }
  };


  // --- AUTH Handlers ---
  const handlePasswordLogin = async () => {
  setLoginError('');
  try {
    const res = await fetch(`${API_BASE}/api/admin/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: loginPasswordInput }),
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      setLoginError(j.error || 'Login failed');
      return;
    }
    const j = await res.json();
    localStorage.setItem('admin_token', j.token);
    const profile: UserProfile = {
      id: 'admin',
      email: 'admin',
      name: 'Administrator',
      username: 'admin',
      provider: 'EMAIL',
      role: 'OWNER',
      wallet: '',
      promoCode: 'ADMIN',
      referredBy: null,
      twitterHandle: null,
      tiktokHandle: null,
      facebookHandle: null,
      createdAt: Date.now(),
      lastLogin: Date.now(),
      loginCount: 1,
    };
    setUserProfile(profile);
    setCurrentUserRole('OWNER');
    setShowLoginModal(false);
    setLoginError('');
    setLoginPasswordInput('');
    addLog("🔐 Authenticated as OWNER.");
    // Load server config after login
    loadUltibotConfig();
    // Load wallet groups after login
    fetchWalletGroups();
  } catch (e: any) {
    setLoginError(String(e?.message || e));
  }
  };

  const handleLogout = async () => {
      // Track logout if wallet is connected
      if (connectedAddress) {
        try {
          await fetch('/api/profile/logout', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ wallet: connectedAddress }),
          });
        } catch (e) {
          console.error('Logout tracking error:', e);
        }
      }
      
      setUserProfile(null);
      setCurrentUserRole('USER');
      setActiveTab('ANONPAY');
      handleWalletDisconnect(); 
      addLog("🔒 User Logged Out.");
  };

  const navigateToApp = (tab: AppTab) => {
      setViewMode('APP');
      handleTabClick(tab);
  };

  const handleTabClick = (tab: AppTab) => {
    // Public Tab
    if (tab === 'ANONPAY') {
        setActiveTab(tab);
        return;
    }

    // Restricted Tabs - check login first, don't set tab yet
    if (!isLoggedIn) {
        setActiveTab(tab); // Set tab so login modal knows where to go
        setShowLoginModal(true);
        return;
    }

    // Role checks
    if (tab === 'ULTICLEANER' || tab === 'ADMIN' || tab === 'MARKETMAKER') {
        if (currentUserRole !== 'ADMIN' && currentUserRole !== 'OWNER') {
            alert("Access Denied. Admin or Owner role required.");
            setActiveTab('ANONPAY'); // Reset to public tab
            return;
        }
        
        if (tab === 'ADMIN' || tab === 'MARKETMAKER') {
            // For MARKETMAKER, require admin login first
            if (tab === 'MARKETMAKER' && !isAdminLoggedIn) {
                // Store the intended tab but don't set it yet - wait for password verification
                setPendingAdminTab(tab);
                setAdminGateInput('');
                setAdminGateError('');
                setShowAdminGateModal(true);
                return;
            }
            
            if (tab === 'ADMIN') {
                // Store the intended tab but don't set it yet - wait for password verification
                setPendingAdminTab(tab);
                setAdminGateInput('');
                setAdminGateError('');
                setShowAdminGateModal(true);
                return;
            }
        }
    }
    
    // For other tabs (ULTIBOT, ULTICLEANER, MARKETMAKER), set the tab now
    setActiveTab(tab);
  };

  const [isAdminLoggedIn, setIsAdminLoggedIn] = useState(false);

  const handleAdminGateSubmit = () => {
      if (adminGateInput === adminPassword) {
          setIsAdminLoggedIn(true);
          setShowAdminGateModal(false);
          if (pendingAdminTab) {
              setActiveTab(pendingAdminTab);
              setPendingAdminTab(null);
          }
          addLog("🛡️ Admin Panel Accessed.");
      } else {
          setAdminGateError("Invalid Admin Password");
          setIsAdminLoggedIn(false);
          // Reset to safe tab if password is wrong
          setPendingAdminTab(null);
          setActiveTab('ANONPAY');
      }
  };

  const updateGlobalPassword = () => {
      if (newPasswordInput.length < 4) {
          alert("Password must be at least 4 characters");
          return;
      }
      setGlobalAccessPassword(newPasswordInput);
      setNewPasswordInput('');
      addLog("🔐 Access Password Updated Successfully.");
      alert("User Access Password updated.");
  };

  const updateAdminPassword = () => {
      if (newAdminPasswordInput.length < 4) {
          alert("Password must be at least 4 characters");
          return;
      }
      setAdminPassword(newAdminPasswordInput);
      setNewAdminPasswordInput('');
      addLog("🛡️ Admin Password Updated Successfully.");
      alert("Admin Page Password updated.");
  };

  // --- Wallet Connection Logic (REAL) ---
  const handleConnectWalletClick = () => {
      setShowWalletModal(true);
  };

  const handleWalletDisconnect = async () => {
    try {
      // Try to disconnect generic provider
      const provider = (window as any).phantom?.solana || (window as any).solana;
      if (provider && provider.disconnect) {
          await provider.disconnect();
      }
      
      const solflare = (window as any).solflare;
      if (solflare && solflare.disconnect) {
          await solflare.disconnect();
      }
    } catch (e) {
      console.warn("Disconnect warning:", e);
    }
    setUserWalletConnected(false);
    setConnectedProvider('NONE');
    setConnectedAddress('');
    setUserWalletBalance(0);
    setUserTokens([]);
    addLog("🔌 Wallet Disconnected.");
  };

  // Helper to find provider with retries (React hydration race condition)
  const detectProvider = async (providerType: WalletProvider): Promise<any> => {
      const MAX_RETRIES = 10; // 1 second total
      let attempts = 0;

      return new Promise((resolve, reject) => {
          const check = () => {
              attempts++;
              
              if (providerType === 'PHANTOM') {
                  // Check new standard first
                  if ('phantom' in window) {
                      const p = (window as any).phantom?.solana;
                      if (p?.isPhantom) {
                          resolve(p);
                          return;
                      }
                  }
                  // Check legacy standard
                  if ('solana' in window) {
                      const s = (window as any).solana;
                      if (s?.isPhantom) {
                          resolve(s);
                          return;
                      }
                  }
              } 
              
              if (providerType === 'SOLFLARE') {
                  if ('solflare' in window) {
                      resolve((window as any).solflare);
                      return;
                  }
              }

              if (attempts >= MAX_RETRIES) {
                  resolve(null);
              } else {
                  setTimeout(check, 100);
              }
          };
          check();
      });
  };

  const [pendingProvider, setPendingProvider] = useState<WalletProvider>('NONE');

  const connectSpecificWallet = async (provider: WalletProvider) => {
      // SECURITY CHECK: HTTPS is mandatory for real wallet interactions
      if (window.location.protocol !== 'https:' && window.location.hostname !== 'localhost') {
          alert("SECURITY ERROR: Wallet connections require an HTTPS connection.\n\nPlease verify you are accessing this site via https://");
          return;
      }

      try {
          const walletObj = await detectProvider(provider);
          
          if (!walletObj) {
              let url = "https://phantom.app/";
              if (provider === 'SOLFLARE') url = "https://solflare.com/";
              
              const confirm = window.confirm(`${provider} wallet not detected.\n\nClick OK to visit the download page.`);
              if (confirm) window.open(url, "_blank");
              return;
          }

          // Attempt connection
          try {
              const resp = await walletObj.connect();
              // Handle different response structures (Phantom vs Solflare)
              const pubKey = resp?.publicKey?.toString() || walletObj.publicKey?.toString();
              
              if (pubKey) {
                  setPendingProvider(provider);
                  finishConnection(provider, pubKey);
              } else {
                  throw new Error("No public key returned");
              }
          } catch (connErr) {
              console.error(connErr);
              addLog(`⚠️ ${provider} Connection rejected by user.`);
          }

      } catch (err) {
          console.error("Wallet Connection Failed:", err);
          addLog(`⚠️ Connection to ${provider} failed: ${String(err)}`);
      }
  };

  const finishConnection = async (provider: WalletProvider, address: string) => {
    setPendingWalletAddress(address);
    setShowWalletModal(false);
    setShowPromoCodeModal(true);
  };

  const handlePromoCodeSubmit = async () => {
    if (!pendingWalletAddress) {
      addLog('❌ Error: Wallet address is missing');
      return;
    }
    
    try {
      const response = await fetch('/api/profile/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          wallet: pendingWalletAddress,
          username: profileUsername?.trim() || undefined,
          referredBy: promoCodeInput.trim().toUpperCase() || undefined,
          twitterHandle: profileTwitter?.trim() || undefined,
          tiktokHandle: profileTikTok?.trim() || undefined,
          facebookHandle: profileFacebook?.trim() || undefined,
        }),
      });
      
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        const errorMessage = errorData.error || 'Failed to create profile';
        addLog(`❌ ${errorMessage}`);
        throw new Error(errorMessage);
      }
      
      const data = await response.json();
      setUserPromoCode(data.promoCode);
      
      // Set user profile
      setUserProfile({
        id: pendingWalletAddress,
        email: '',
        name: data.username || `Wallet ${pendingWalletAddress.substring(0, 6)}`,
        provider: pendingProvider,
        role: 'USER',
        wallet: pendingWalletAddress,
        username: data.username,
        promoCode: data.promoCode,
        referredBy: promoCodeInput.trim().toUpperCase() || undefined,
        twitterHandle: profileTwitter?.trim() || undefined,
        tiktokHandle: profileTikTok?.trim() || undefined,
        facebookHandle: profileFacebook?.trim() || undefined,
      });
      
      setConnectedProvider(pendingProvider);
      setConnectedAddress(pendingWalletAddress);
      setUserWalletConnected(true);
      setShowPromoCodeModal(false);
      setPendingWalletAddress('');
      setProfileUsername('');
      setPromoCodeInput('');
      setProfileTwitter('');
      setProfileTikTok('');
      setProfileFacebook('');
      await fetchWalletBalances(pendingWalletAddress);
      
      addLog(`💳 Connected with ${pendingProvider}. Address: ${pendingWalletAddress.substring(0,6)}...`);
      addLog(`✅ Profile created! Username: ${data.username || 'Generated'}, Promo code: ${data.promoCode}`);
      
      if (data.existing) {
        addLog(`✅ Profile already exists. Welcome back!`);
      } else {
        addLog(`✅ Profile created successfully!`);
      }
    } catch (err: any) {
      console.error('Failed to create profile:', err);
      alert(err?.message || 'Failed to create profile. Please try again.');
    }
  };

  // --- Strategy Selection & Editing Handlers ---
  const handleStrategyChange = (strategyId: string) => {
    const strategy = strategies.find(s => s.id === strategyId);
    if (strategy) {
      setSelectedStrategyId(strategyId);
      setConfig(prev => ({ ...prev, strategy: strategy.config }));
      addLog(`⚙️ Strategy Switched to: ${strategy.name}`);
    }
  };

  const handleConfigChange = (field: keyof StrategyConfig, value: number | boolean | string) => {
    setConfig(prev => ({
      ...prev,
      strategy: {
        ...prev.strategy,
        [field]: value
      }
    }));
  };

  const saveStrategyChanges = () => {
    setStrategies(prev => prev.map(s => 
      s.id === selectedStrategyId 
        ? { ...s, config: config.strategy }
        : s
    ));
    addLog(`💾 Strategy updated: ${strategies.find(s => s.id === selectedStrategyId)?.name}`);
  };

  const createNewStrategy = () => {
    const newId = `CUSTOM_${Date.now()}`;
    const newStrategy: StrategyPreset = {
      id: newId,
      name: `Custom Strategy ${strategies.length + 1}`,
      description: 'User defined configuration',
      config: config.strategy
    };
    setStrategies(prev => [...prev, newStrategy]);
    setSelectedStrategyId(newId);
    addLog(`✨ New Strategy Created: ${newStrategy.name}`);
  };

  const deleteStrategy = async () => {
    if (strategies.length <= 1) {
      alert('Cannot delete the last strategy. At least one strategy must exist.');
      return;
    }

    const strategyToDelete = strategies.find(s => s.id === selectedStrategyId);
    if (!strategyToDelete) return;

    if (!confirm(`Are you sure you want to delete "${strategyToDelete.name}"? This action cannot be undone.`)) {
      return;
    }

    try {
      // Try to delete from backend if it's a saved strategy (not a local INITIAL_STRATEGY)
      if (!strategyToDelete.id.startsWith('CYCLE_') && !strategyToDelete.id.startsWith('PROFIT_') && !strategyToDelete.id.startsWith('SCALP_')) {
        await authFetch(`/api/ultibot/strategies/${selectedStrategyId}`, { method: 'DELETE' });
      }

      // Remove from local state
      const remainingStrategies = strategies.filter(s => s.id !== selectedStrategyId);

      // Switch to the first remaining strategy
      if (remainingStrategies.length > 0) {
        const newSelectedId = remainingStrategies[0].id;
        setSelectedStrategyId(newSelectedId);
        setConfig(prev => ({ ...prev, strategy: remainingStrategies[0].config }));
        addLog(`🗑️ Strategy deleted: ${strategyToDelete.name}. Switched to: ${remainingStrategies[0].name}`);
      }
    } catch (error: any) {
      console.error('Failed to delete strategy:', error);
      alert(`Failed to delete strategy: ${error?.message || 'Unknown error'}`);
    }
  };

  // --- Key Management Handlers ---
  const openKeyModal = async (role: SpecialRole) => {
    const wallet = specialWallets.find(w => w.role === role);
    setEditingWalletRole(role);
    setTempPrivateKey(wallet?.privateKey || '');
    setShowKeyModal(true);
    
    // If wallet already has a private key, fetch balance automatically
    if (wallet?.privateKey) {
      try {
        addLog(`🔄 Refreshing balance for ${role} wallet...`);
        const res = await authFetch('/api/wallet/balance', {
          method: 'POST',
          body: JSON.stringify({
            privateKey: wallet.privateKey,
            rpcUrl: rpcUrl || undefined
          })
        });
        
        if (res.ok) {
          const data = await res.json();
          setSpecialWallets(prev => prev.map(w => {
            if (w.role === role) {
              return {
                ...w,
                address: data.publicKey,
                balanceSol: data.balance || 0
              };
            }
            return w;
          }));
          addLog(`✅ ${role} Wallet: ${(data.balance || 0).toFixed(4)} SOL`);
        }
      } catch (e: any) {
        console.error('Balance refresh error:', e);
      }
    }
  };

  const savePrivateKey = async () => {
    if (!editingWalletRole) {
      addLog(`❌ No wallet selected for import`);
      return;
    }

    // Validate private key format before attempting to save
    const trimmedKey = tempPrivateKey.trim();
    if (!trimmedKey) {
      addLog(`⚠️ Please enter a private key or generate a new wallet`);
      return;
    }

    // Basic format validation
    const isValidFormat = 
      trimmedKey.length === 64 || // Hex format (32 bytes)
      trimmedKey.length === 88 || // Base58 format (64 bytes)
      trimmedKey.length === 128 || // Hex format (64 bytes)
      trimmedKey.startsWith('[') || // JSON array format
      /^[0-9a-fA-F]+$/.test(trimmedKey) || // Hex characters
      /^[1-9A-HJ-NP-Za-km-z]+$/.test(trimmedKey); // Base58 characters

    if (!isValidFormat && trimmedKey.length < 32) {
      addLog(`⚠️ Private key format appears invalid. Expected: 64-char hex, 88-char base58, or JSON array`);
      return;
    }

    let newAddress = '';
    let newBalance = 0;
    
    // If private key provided, fetch real balance and address
    try {
      addLog(`🔄 Importing ${editingWalletRole} wallet and fetching balance...`);
      const res = await authFetch('/api/wallet/balance', {
        method: 'POST',
        body: JSON.stringify({
          privateKey: trimmedKey,
          rpcUrl: rpcUrl || undefined
        })
      });
      
      if (res.ok) {
        const data = await res.json();
        newAddress = data.publicKey;
        newBalance = data.balance || 0;
        addLog(`✅ ${editingWalletRole} Wallet imported successfully!`);
        addLog(`   Address: ${newAddress}`);
        addLog(`   Balance: ${newBalance.toFixed(4)} SOL`);
      } else {
        const errorText = await res.text();
        addLog(`❌ Failed to import ${editingWalletRole} wallet: ${errorText}`);
        addLog(`   Please check your private key format and try again.`);
        // Don't save invalid keys
        return;
      }
    } catch (e: any) {
      console.error('Wallet import error:', e);
      const errorMsg = String(e?.message || e);
      addLog(`❌ Error importing ${editingWalletRole} wallet: ${errorMsg}`);
      addLog(`   Please verify your private key is correct.`);
      // Don't save keys that fail validation
      return;
    }
    
    // Only save if we successfully got the address and balance
    if (newAddress) {
      setSpecialWallets(prev => prev.map(w => {
        if (w.role === editingWalletRole) {
          return {
            ...w,
            privateKey: trimmedKey,
            address: newAddress,
            balanceSol: newBalance
          };
        }
        return w;
      }));
      
      addLog(`🔐 ${editingWalletRole} Wallet keys saved successfully!`);
      setShowKeyModal(false);
      setTempPrivateKey(''); // Clear the input
    } else {
      addLog(`❌ Failed to get wallet address. Cannot save.`);
    }
  };

  const generateNewWallet = () => {
    const newKey = generatePrivateKey();
    setTempPrivateKey(newKey);
    addLog(`⚡ New Wallet Generated for ${editingWalletRole}. Click Save to apply.`);
  };

  // --- Token Data Fetch (Production Ready) ---
  const handleTokenFetch = async () => {
  if (!monitoredTokenAddress) return;
  setBotStatus('Fetching token info...');
  try {
    const res = await authFetch(`/api/solana/token-info?mint=${encodeURIComponent(monitoredTokenAddress)}`, { method: 'GET' });
    if (!res.ok) throw new Error((await res.json().catch(()=>({}))).error || 'Failed to fetch token info');
    const data = await res.json();
    setMarketData(prev => ({
      ...prev,
      tokenName: data.metadata?.name || 'Unknown Token',
      tokenTicker: data.metadata?.symbol || '???',
      totalSupply: data.supply ? Number(data.supply) / Math.pow(10, data.decimals || 0) : prev.totalSupply
    }));

    // Persist mint to server config
    await authFetch('/api/ultibot/config', {
      method: 'POST',
      body: JSON.stringify({ enabled: botEnabled, tokenMint: monitoredTokenAddress }),
    });

    setBotStatus('Token info loaded');
  } catch (e: any) {
    console.error(e);
    setBotStatus('Token fetch failed');
  }
};

  // --- Privacy Helper Functions ---
  const queuePrivacyTransfer = (
    fromRole: SpecialRole | undefined, 
    fromWalletId: string | undefined, 
    toRole: SpecialRole | undefined, 
    toWalletId: string | undefined, 
    amount: number,
    delayMs: number = 2000,
    toAddress?: string, 
    assetType: 'SOL' | 'TOKEN' = 'SOL',
    tokenSymbol?: string
  ) => {
    const newItem: PrivacyQueueItem = {
      id: `pq-${Math.random().toString(36)}`,
      fromRole, fromWalletId,
      toRole, toWalletId,
      toAddress,
      amount,
      assetType,
      tokenSymbol,
      status: 'QUEUED',
      releaseTime: Date.now() + delayMs
    };

    setPrivacyState(prev => ({
      ...prev,
      queue: [...prev.queue, newItem]
    }));
  };

  // --- AnonPay Logic ---
  const getActiveAssetBalance = () => {
      if (anonPaySelectedAssetMint === 'SOL') return userWalletBalance;
      const token = userTokens.find(t => t.mint === anonPaySelectedAssetMint);
      return token ? token.balance : 0;
  };

  const calculateAnonPayAmount = () => {
      if (anonPayAmountMode === 'FIXED') {
          return randRange(anonPayMinAmount, anonPayMaxAmount);
      } else {
          const balance = getActiveAssetBalance();
          if (balance === 0) return 0;
          const pct = randRange(anonPayMinPct, anonPayMaxPct);
          return balance * (pct / 100);
      }
  };

  const handleAnonPayCSVUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = async (event) => {
      const content = event.target?.result as string;
      if (content) {
        // We pass 0 as default because we will recalc based on mode immediately after
        const parsed = await parseAnonPayCSV(content, 0); 
        
        const calculatedRecipients: AnonPayRecipient[] = parsed.map(r => {
            // If CSV had explicit amount, use it. If 0 (default), calculate based on current mode
            const amt = r.amount > 0 ? r.amount : calculateAnonPayAmount();
            return { ...r, amount: amt };
        });
        
        setAnonPayRecipients(prev => [...prev, ...calculatedRecipients]);
        addLog(`📂 Loaded ${calculatedRecipients.length} recipients.`);
      }
    };
    reader.readAsText(file);
    e.target.value = ''; // Reset
  };

  const addManualRecipients = () => {
    if (!anonPayRecipientInput.trim()) return;
    const lines = anonPayRecipientInput.split('\n');
    const parsed: AnonPayRecipient[] = [];
    lines.forEach(line => {
        if (line.trim().length > 10) {
            const parts = line.split(',');
            const addr = parts[0].trim();
            // Use provided amount OR calculate based on mode
            const amt = parts.length > 1 ? parseFloat(parts[1]) : calculateAnonPayAmount();
            
            // Explicit construction to satisfy type check
            const newRecipient: AnonPayRecipient = { 
                id: Math.random().toString(), 
                address: addr, 
                amount: amt, 
                status: 'PENDING'
            };
            parsed.push(newRecipient);
        }
    });
    setAnonPayRecipients(prev => [...prev, ...parsed]);
    setAnonPayRecipientInput(''); 
    addLog(`📝 Added ${parsed.length} recipients.`);
  };



const MAX_TRANSFERS_PER_TX = 15;

const executeAnonPayBatch = async () => {
  if (!userWalletConnected) return alert("Please connect your wallet to pay fees.");

  const pending = anonPayRecipients.filter((r) => r.status === "PENDING");
  if (pending.length === 0) return alert("No pending transfers.");

  const feesSol = pending.length * ANON_PAY_FEE_PER_TX;
  const totalTransferAmount = pending.reduce((acc, r) => acc + r.amount, 0);

  if (userWalletBalance < feesSol)
    return alert(`Insufficient SOL for Fees. Need ${feesSol.toFixed(3)} SOL.`);

  const isSol = anonPaySelectedAssetMint === "SOL";
  const selectedToken = userTokens.find((t) => t.mint === anonPaySelectedAssetMint);
  const tokenDecimals = selectedToken?.decimals ?? 9;
  const assetSymbol = isSol ? "SOL" : selectedToken?.symbol ?? "TOKEN";
  const assetBalance = isSol ? userWalletBalance : selectedToken?.balance ?? 0;

  if (isSol) {
    if (userWalletBalance < feesSol + totalTransferAmount)
      return alert("Insufficient SOL for Fees + Transfers.");
    setUserWalletBalance((p) => p - (feesSol + totalTransferAmount));
  } else {
    if (assetBalance < totalTransferAmount)
      return alert(`Insufficient ${assetSymbol} Balance.`);
    setUserWalletBalance((p) => p - feesSol);
    setUserTokens((p) =>
      p.map((t) =>
        t.mint === anonPaySelectedAssetMint
          ? { ...t, balance: t.balance - totalTransferAmount }
          : t
      )
    );
  }

  addLog(`💳 Fees of ${feesSol.toFixed(4)} SOL sent to fee collector: ${FEE_COLLECTOR_WALLET}`);

  addLog(
    anonPayPrivacyEnabled
      ? `🛡️ Privacy Shield ACTIVE. Processing ${pending.length} privacy transfers.`
      : `🚀 Direct Transfer Mode. Processing ${pending.length} transfers.`
  );

  try {
    const provider =
      connectedProvider === "PHANTOM"
        ? (window as any).phantom?.solana || (window as any).solana
        : (window as any).solflare;
    if (!provider?.publicKey) return alert("Wallet not connected properly.");

    const connection = new solanaWeb3.Connection('', "confirmed");
    const sender = new solanaWeb3.PublicKey(provider.publicKey.toString());

    // ✅ validate addresses first
    const valid = pending.filter((r) => {
      try {
        new solanaWeb3.PublicKey(r.address);
        return true;
      } catch {
        addLog(`⚠️ Invalid recipient skipped: ${r.address}`);
        return false;
      }
    });
    if (valid.length === 0) return alert("No valid recipients.");

    // 🛡️ PRIVACY SHIELD: Use Privacy Cash for SOL transfers
    if (anonPayPrivacyEnabled && isSol) {
      addLog(`🛡️ Using Privacy Cash for ${valid.length} private SOL transfers...`);
      
      try {
        // Create Privacy Cash instance
        const privacyCash = new PrivacyCashDirect({
          connection,
          wallet: {
            publicKey: sender,
            signMessage: async (message: Uint8Array) => {
              const signed = await provider.signMessage(message);
              return { signature: signed.signature };
            },
            signTransaction: async (tx: any) => {
              return await provider.signTransaction(tx);
            },
            signAllTransactions: async (txs: any[]) => {
              return await provider.signAllTransactions(txs);
            },
          },
          circuitBaseUrl: '/circuit2',
          enableDebug: true,
        });

        // Initialize Privacy Cash
        addLog(`🔐 Initializing Privacy Cash...`);
        await privacyCash.initialize();

        // Process each recipient with automatic Privacy Cash transfer (deposit + withdraw)
        let successCount = 0;
        for (let i = 0; i < valid.length; i++) {
          const recipient = valid[i];
          const amountLamports = Math.round(recipient.amount * 10 ** 9);
          
          try {
            addLog(`🛡️ Processing automatic private transfer ${i + 1}/${valid.length}: ${recipient.amount} SOL to ${recipient.address.substring(0, 8)}...`);
            
            // Use automatic private transfer (deposits if needed, then withdraws)
            await privacyCash.privateTransfer({
              lamports: amountLamports,
              recipientAddress: recipient.address,
            });

            // Mark as completed
            setAnonPayRecipients((p) =>
              p.map((r) =>
                r.address === recipient.address
                  ? { ...r, status: "COMPLETED" as const }
                  : r
              )
            );
            
            successCount++;
            addLog(`✅ Automatic private transfer ${i + 1}/${valid.length} completed`);
            
            // Small delay between transfers to avoid rate limiting (using configured delay)
            if (i < valid.length - 1 && anonPayDelaySeconds > 0) {
              await new Promise(resolve => setTimeout(resolve, anonPayDelaySeconds * 1000));
            }
          } catch (error: any) {
            addLog(`❌ Private transfer ${i + 1}/${valid.length} failed: ${error.message}`);
            // Continue with next transfer
          }
        }

        addLog(`✅ Privacy Shield: ${successCount}/${valid.length} transfers completed successfully.`);
        return;
      } catch (error: any) {
        addLog(`❌ Privacy Cash initialization failed: ${error.message}`);
        addLog(`⚠️ Falling back to direct transfer mode...`);
        // Fall through to direct transfer mode
      }
    }

    // 🚀 DIRECT TRANSFER MODE (or fallback from Privacy Cash)
    const amountPerRecipient = valid.map((r) =>
      Math.round(r.amount * 10 ** (isSol ? 9 : tokenDecimals))
    );
    const recipients = valid.map((r) => r.address);

    // split into 15-transfer batches
    const batches: string[][] = [];
    for (let i = 0; i < recipients.length; i += MAX_TRANSFERS_PER_TX)
      batches.push(recipients.slice(i, i + MAX_TRANSFERS_PER_TX));

    addLog(`💰 Sending ${valid.length} transfers in ${batches.length} batch(es)...`);

    for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
      const batch = batches[batchIndex];
      const tx = new solanaWeb3.Transaction();

      for (let j = 0; j < batch.length; j++) {
        const addr = batch[j].trim();
        let dest: solanaWeb3.PublicKey;
        try {
          dest = new solanaWeb3.PublicKey(addr);
        } catch {
          addLog(`⚠️ Skipping invalid address in batch: ${addr}`);
          continue;
        }

        const amount = amountPerRecipient[batchIndex * MAX_TRANSFERS_PER_TX + j] || 0;

        if (isSol) {
          tx.add(
            solanaWeb3.SystemProgram.transfer({
              fromPubkey: sender,
              toPubkey: dest,
              lamports: amount,
            })
          );
        } else {
          const mint = new solanaWeb3.PublicKey(anonPaySelectedAssetMint);
          const senderTokenAcc = await getAssociatedTokenAddress(mint, sender);
          const destTokenAcc = await getAssociatedTokenAddress(mint, dest);

          // ✅ ensure destination ATA exists
          const info = await connection.getAccountInfo(destTokenAcc);
          if (!info) {
            tx.add(
              createAssociatedTokenAccountInstruction(
                sender,
                destTokenAcc,
                dest,
                mint
              )
            );
          }

          tx.add(
            createTransferInstruction(
              senderTokenAcc,
              destTokenAcc,
              sender,
              amount,
              [],
              TOKEN_PROGRAM_ID
            )
          );
        }
      }

      tx.feePayer = sender;
      const { blockhash } = await connection.getLatestBlockhash("finalized");
      tx.recentBlockhash = blockhash;

      const signed = await provider.signTransaction(tx);
      const sig = await connection.sendRawTransaction(signed.serialize());
      addLog(`📤 Batch ${batchIndex + 1}/${batches.length} sent: ${sig}`);
      await connection.confirmTransaction(sig, "finalized");

      setAnonPayRecipients((p) =>
        p.map((r) =>
          batch.includes(r.address)
            ? { ...r, status: "COMPLETED" as const }
            : r
        )
      );
    }

    addLog(`✅ All ${valid.length} transfers completed successfully.`);
  } catch (err) {
    console.error("AnonPay transfer failed:", err);
    addLog(`❌ Error: ${String(err)}`);
    alert("Transfer failed. Check console/log for details.");
  }

  addLog(`✅ AnonPay Batch Initiated.`);
};


  // --- ULTICLEANER LOGIC ---
  const addCleanerDestinations = () => {
      if (!cleanerInput.trim()) return;
      const lines = cleanerInput.split('\n');
      const parsed: CleanerDestination[] = [];
      lines.forEach(line => {
          if (line.trim().length > 10) {
              const parts = line.split(',');
              parsed.push({
                  id: Math.random().toString(),
                  address: parts[0].trim(),
                  privateKey: parts[1] ? parts[1].trim() : undefined,
                  status: 'PENDING'
              });
          }
      });
      setCleanerDestinations(prev => [...prev, ...parsed]);
      setCleanerInput('');
  };

  const runCleanerSequence = () => {
      if (!userWalletConnected) return alert("Connect wallet first.");
      if (cleanerDestinations.length === 0) return alert("Add destinations first.");
      
      setCleanerStage('DISTRIBUTING');
      addCleanerLog("Starting Cleaner Sequence...");
      
      // Simulate Phase 1: Distribute
      setTimeout(() => {
          setCleanerStage('SELLING');
          addCleanerLog("✅ Phase 1: Distribution Complete (20 Intermediary Wallets Funded)");
          
          // Phase 2: Sell
          setTimeout(() => {
              setCleanerStage('CONSOLIDATING');
              addCleanerLog("✅ Phase 2: Liquidation Complete. Assets converted to SOL.");
              
              // Phase 3: Consolidate
              setTimeout(() => {
                 setCleanerStage('FINAL_BUY');
                 setCleanerDestinations(prev => prev.map(d => ({...d, status: 'FUNDED'})));
                 addCleanerLog("✅ Phase 3: Consolidation Complete. SOL sent to destinations.");

                 // Phase 4: Final Buy (if keys exist)
                 setTimeout(() => {
                     const buyers = cleanerDestinations.filter(d => d.privateKey);
                     if (buyers.length > 0) {
                         setCleanerDestinations(prev => prev.map(d => d.privateKey ? {...d, status: 'BOUGHT'} : {...d, status: 'COMPLETE'}));
                         addCleanerLog(`🚀 Phase 4: Executed 98% Buy Order for ${buyers.length} wallets.`);
                     } else {
                         setCleanerDestinations(prev => prev.map(d => ({...d, status: 'COMPLETE'})));
                         addCleanerLog("ℹ️ Phase 4 Skipped: No private keys provided for auto-buy.");
                     }
                     setCleanerStage('COMPLETE');
                     addCleanerLog("✨ CLEANING SEQUENCE FINISHED.");
                 }, 2000);

              }, 2000);
          }, 2000);
      }, 2000);
  };

  const clearCleanerData = () => {
      setCleanerDestinations([]);
      setCleanerLogs([]);
      setCleanerStage('IDLE');
      setCleanerInput('');
  };


  // --- Logic: Initialize Cycle ---
  const initializeCycle = (cycleNum: number) => {
    if (marketData.marketCap >= config.targetMarketCapSell) {
        addLog(`🛑 TARGET MARKET CAP ($${config.targetMarketCapSell.toLocaleString()}) REACHED. Stopping.`);
        setAppState(AppState.IDLE);
      fetch('/api/ultibot/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: false }) }).catch(() => {});
        return;
    }

    addLog(`🔄 INITIALIZING CYCLE #${cycleNum} with Strategy: ${strategies.find(s => s.id === selectedStrategyId)?.name}`);
    
    const targetSupplyPct = randRange(config.strategy.targetSupplyBuyMin, config.strategy.targetSupplyBuyMax);
    const tokensToBuy = marketData.totalSupply * (targetSupplyPct / 100);
    const estimatedCostSol = tokensToBuy * marketData.priceUsd;
    const totalFundingNeeded = estimatedCostSol * 1.05; 
    const walletsPerCycle = config.walletsPerCycle ?? 5;
    const fundingPerWallet = totalFundingNeeded / walletsPerCycle;

    const newWallets: Wallet[] = Array.from({ length: walletsPerCycle }).map((_, i) => ({
      id: `cycle-${cycleNum}-w-${i}`,
      groupId: `group-${cycleNum}`,
      address: generateAddress(),
      label: `C${cycleNum}-W${i+1}`,
      isWhitelisted: true,
      balanceSol: 0, 
      initialBalanceSol: fundingPerWallet,
      balanceTokens: 0,
      status: 'ACTIVE'
    }));

    const newGroup: WalletGroup = {
      id: `group-${cycleNum}`,
      name: `Cycle Group ${cycleNum}`,
      cycleNumber: cycleNum,
      isActive: true,
      phase: CyclePhase.INITIAL_BUY, 
      hasDefended: false,
      entryPriceUsd: marketData.priceUsd,
      startTime: Date.now(),
      wallets: newWallets
    };

    if (config.strategy.usePrivacyMode) {
      addLog(`🛡️ PRIVACY MODE ACTIVE: Initiating unlinked funding via Shadow Pool...`);
      newWallets.forEach((w, i) => {
        queuePrivacyTransfer('FUNDING', undefined, undefined, w.id, fundingPerWallet, 1000 + (i * 800));
      });
    } else {
      setSpecialWallets(prev => prev.map(sw => 
        sw.role === 'FUNDING' ? { ...sw, balanceSol: sw.balanceSol - totalFundingNeeded } : sw
      ));
      newGroup.wallets.forEach(w => w.balanceSol = fundingPerWallet);
      addLog(`💸 Standard Funding Complete (Linked).`);
    }

    setWalletGroups(prev => {
      const archived = prev.map(g => ({ ...g, isActive: false, phase: CyclePhase.COMPLETE }));
      return [...archived, newGroup];
    });

    addLog(`✅ Cycle #${cycleNum} Prepared. Waiting for funds to land.`);
  };

  const toggleRunState = async () => {
  if (!monitoredTokenAddress) {
    alert("Please enter a Token Address to monitor first.");
    return;
  }
  try {
    console.log('State values before save - intruderTriggerPct:', intruderTriggerPct, 'groupSellPctMin:', groupSellPctMin, 'groupSellPctMax:', groupSellPctMax);
    // Save config first (includes dynamic RPC URL and optional bot key)
    const configResponse = await authFetch('/api/ultibot/config', {
      method: 'POST',
      body: JSON.stringify({
        enabled: !botEnabled,
        tokenMint: monitoredTokenAddress,
        whitelist: whitelist || [],
        intruderTriggerPct: intruderTriggerPct ?? 1,
        intruderActions: intruderActions || [{ type: 'ALERT' }],
        groupSellPctMin: groupSellPctMin ?? 10,
        groupSellPctMax: groupSellPctMax ?? 20,
        walletsPerCycle: walletsPerCycle ?? 5,
        monitoringRules: monitoringRules || { takeProfitPct: 20, stopLossPct: 15, maxHoldSec: 3600 },
        rpcUrl: rpcUrl,
        botSecretKey: botSecretKeyInput,
      }),
    });
    console.log('Config save response:', configResponse.status);
    if (!configResponse.ok) {
      const errorText = await configResponse.text();
      console.error('Config save failed:', errorText);
      addLog(`❌ Config save failed: ${errorText}`);
      return;
    }

    if (!botEnabled) {
      console.log('Starting bot...');
      const startResponse = await authFetch('/api/ultibot/start', { method: 'POST' });
      console.log('Bot start response:', startResponse.status);
      if (startResponse.ok) {
        setBotStatus('Running (server-side)');
        addLog('🚀 Bot started successfully');
      } else {
        const errorText = await startResponse.text();
        console.error('Bot start failed:', errorText);
        addLog(`❌ Failed to start bot: ${errorText}`);
      }
    } else {
      console.log('Stopping bot...');
      const stopResponse = await authFetch('/api/ultibot/stop', { method: 'POST' });
      console.log('Bot stop response:', stopResponse.status);
      if (stopResponse.ok) {
        setBotStatus('Stopped');
        addLog('⏹️ Bot stopped successfully');
      } else {
        const errorText = await stopResponse.text();
        console.error('Bot stop failed:', errorText);
        addLog(`❌ Failed to stop bot: ${errorText}`);
      }
    }
    setBotEnabled(!botEnabled);
    if (botSecretKeyInput) setBotSecretKeyInput('');
  } catch (e: any) {
    console.error(e);
    addLog(`❌ Failed to update bot state: ${String(e?.message || e)}`);
    setBotStatus('Failed to update bot state');
  }
};

  const handleAddAdmin = () => {
      if (!newAdminEmail) return;
      setAdminUsers(prev => [...prev, { id: Date.now().toString(), role: 'ADMIN', email: newAdminEmail }]);
      setNewAdminEmail('');
      addLog(`👮 Admin Added: ${newAdminEmail}`);
  };

  // --- ALL HOOKS MUST BE BEFORE EARLY RETURNS ---
  
  // --- Simulation Loop ---
  useEffect(() => {
    intervalRef.current = window.setInterval(() => {
        
        // 0. PRIVACY SHIELD ENGINE
        setPrivacyState(prev => {
          const now = Date.now();
          let updatedQueue = [...prev.queue];
          let updatedShadowSol = prev.shadowPoolBalanceSol;
          let updatedShadowTokens = prev.shadowPoolBalanceTokens;
          let updatedTotalVol = prev.totalVolumeAnonymized;
          
          updatedQueue = updatedQueue.map(item => {
            // STEP 1: DEPOSIT
            if (item.status === 'QUEUED') {
              const depositHash = `dep-${Math.random().toString(36).substring(7)}`;
              
              if (item.fromRole) {
                 setSpecialWallets(wallets => wallets.map(w => 
                    w.role === item.fromRole ? { ...w, balanceSol: w.balanceSol - item.amount } : w
                 ));
                 setTransactions(txs => [{ 
                   id: Math.random().toString(), hash: depositHash, sender: "Internal", receiver: generateMixerAddress(),
                   type: 'MIXER_DEPOSIT' as const, amountSol: item.amount, assetSymbol: item.tokenSymbol || 'SOL', timestamp: now, isIntruder: false, isPrivacyAction: true 
                 }, ...txs].slice(0, 10));
              } else {
                 setTransactions(txs => [{ 
                   id: Math.random().toString(), hash: depositHash, sender: "User Wallet", receiver: generateMixerAddress(),
                   type: 'MIXER_DEPOSIT' as const, amountSol: item.amount, assetSymbol: item.tokenSymbol || 'SOL', timestamp: now, isIntruder: false, isPrivacyAction: true 
                 }, ...txs].slice(0, 10));
              }

              if (item.assetType === 'SOL') updatedShadowSol += item.amount;
              else updatedShadowTokens += item.amount;
              
              addLog(`🛡️ Shield Deposit: ${item.amount.toFixed(2)} ${item.tokenSymbol || 'SOL'}.`);
              return { ...item, status: 'MIXING', depositTxHash: depositHash, zkProofNote: generateZKProof() };
            }

            // STEP 2: RELAY
            if (item.status === 'MIXING' && now > item.releaseTime) {
               const relayHash = `relay-${Math.random().toString(36).substring(7)}`;
               const relayerAddr = generateRelayerAddress();

               if (item.toRole) {
                 setSpecialWallets(wallets => wallets.map(w => 
                    w.role === item.toRole ? { ...w, balanceSol: w.balanceSol + item.amount } : w
                 ));
               } else if (item.toWalletId) {
                 setWalletGroups(groups => groups.map(g => ({
                    ...g,
                    wallets: g.wallets.map(w => w.id === item.toWalletId ? { ...w, balanceSol: w.balanceSol + item.amount } : w)
                 })));
               } else if (item.toAddress) {
                 setAnonPayRecipients(prev => prev.map(r => r.address === item.toAddress ? { ...r, status: 'COMPLETED' } : r));
               }

               setTransactions(txs => [{ 
                   id: Math.random().toString(), hash: relayHash, sender: relayerAddr, receiver: item.toAddress || 'Internal',
                   type: 'RELAY_WITHDRAW' as const, amountSol: item.amount, assetSymbol: item.tokenSymbol || 'SOL', timestamp: now, isIntruder: false, isPrivacyAction: true 
               }, ...txs].slice(0, 10));

               if (item.assetType === 'SOL') {
                   updatedShadowSol -= item.amount;
                   updatedTotalVol += item.amount;
               } else {
                   updatedShadowTokens -= item.amount;
               }
               
               addLog(`👻 Relay Complete: ${item.amount.toFixed(2)} ${item.tokenSymbol || 'SOL'}.`);
               return { ...item, status: 'COMPLETED' };
            }
            return item;
          });

          return {
            shadowPoolBalanceSol: updatedShadowSol,
            shadowPoolBalanceTokens: updatedShadowTokens,
            totalVolumeAnonymized: updatedTotalVol,
            queue: updatedQueue.filter(i => i.status !== 'COMPLETED')
          };
        });

        // --- Market & Simulation Loop ---
        // Only run logic if system is Active OR if we are Waiting for Exit (to simulate sell pressure)
        if (appState === AppState.RUNNING || (appState === AppState.RESTARTING && config.strategy.pauseMode === 'WAIT_FOR_EXIT')) {
            setMarketData(prev => {
                // Random Price Movement
                const change = (Math.random() - 0.45) * 0.03; 
                const newPrice = Math.max(0.00001, prev.priceUsd * (1 + change));
                const newMC = prev.totalSupply * newPrice;
                const curveProgress = Math.min(100, (newMC / BONDING_CURVE_LIMIT) * 100);
                
                // Intruder Logic
                let newIntruderHoldings = prev.intruderHoldings;
                if (appState === AppState.RUNNING) {
                    // Simulate buying pressure from outsiders
                    if (Math.random() > 0.7) newIntruderHoldings += randRange(0.1, 0.5);
                } else if (appState === AppState.RESTARTING && config.strategy.pauseMode === 'WAIT_FOR_EXIT') {
                    // Simulate selling pressure (clearing out)
                    if (newIntruderHoldings > 0) {
                        newIntruderHoldings = Math.max(0, newIntruderHoldings - randRange(0.5, 2.0)); // Sell off
                    }
                }

                // Update Chart
                const timeStr = new Date().toLocaleTimeString();
                setChartData(prevChart => [...prevChart, {
                    time: timeStr,
                    marketCap: newMC,
                    price: newPrice
                }].slice(-50));

                // Update trading chart with market data
                setTradingChartData(prev => {
                    const last = prev[prev.length - 1];
                    // Only add new point if price/market cap changed significantly or every 5 seconds
                    const shouldUpdate = !last || 
                        Math.abs((last.price || 0) - newPrice) / newPrice > 0.01 || // 1% price change
                        Date.now() % 5000 < 1000; // Every ~5 seconds
                    
                    if (shouldUpdate) {
                        return [...prev, {
                            time: timeStr,
                            price: newPrice,
                            marketCap: newMC,
                            buyVolume: last?.buyVolume || 0,
                            sellVolume: last?.sellVolume || 0,
                            buyCount: last?.buyCount || 0,
                            sellCount: last?.sellCount || 0,
                            buys: last?.buys || [],
                            sells: last?.sells || [],
                        }].slice(-100);
                    }
                    return prev;
                });

                return { ...prev, priceUsd: newPrice, marketCap: newMC, bondingCurveProgress: curveProgress, intruderHoldings: newIntruderHoldings };
            });
        }

        if (appState === AppState.RUNNING) {
             setWalletGroups(prevGroups => prevGroups.map(group => {
                 if (!group.isActive || group.phase === CyclePhase.COMPLETE) return group;
                 
                 if (group.phase === CyclePhase.INITIAL_BUY) {
                    const hasFunds = group.wallets.some(w => w.balanceSol > 0.01);
                    if (hasFunds) {
                        const updatedWallets = group.wallets.map(w => {
                            if (w.balanceSol < 0.1) return w;
                            const buyAmount = w.balanceSol * (config.strategy.initialBuySolPct / 100);
                            return { ...w, balanceSol: w.balanceSol - buyAmount, balanceTokens: w.balanceTokens + (buyAmount / marketData.priceUsd) };
                        });
                        return { ...group, wallets: updatedWallets, phase: CyclePhase.MONITORING };
                    }
                 }
                 return group;
             }));
        }
        
      }, 800);
    return () => { if (intervalRef.current) clearInterval(intervalRef.current); };
  }, [appState, marketData, config, privacyState.queue, userWalletConnected, anonPayRecipients, userWalletBalance]);

  // Cycle Manager - Handles COMPLETE transitions and rollover
  useEffect(() => {
    if (appState === AppState.RUNNING) {
        const activeGroup = walletGroups.find(g => g.isActive);
        // Check if active group is COMPLETE
        if (activeGroup && activeGroup.phase === CyclePhase.COMPLETE) {
          addLog(`✅ Cycle ${activeGroup.cycleNumber} COMPLETE. Preparing next cycle...`);
          setAppState(AppState.RESTARTING);
          return;
        }
        // No active group but we have groups - check if all are COMPLETE
        if (!activeGroup && walletGroups.length > 0) {
          const allComplete = walletGroups.every(g => g.phase === CyclePhase.COMPLETE || !g.isActive);
          if (allComplete) {
            if (marketData.marketCap >= config.targetMarketCapSell) {
              setAppState(AppState.IDLE);
              fetch('/api/ultibot/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: false }) }).catch(() => {});
              addLog(`🛑 Target Market Cap reached. Stopping.`);
            } else {
              setAppState(AppState.RESTARTING);
            }
          }
        }
    } else if (appState === AppState.RESTARTING) {
        if (config.strategy.pauseMode === 'WAIT_FOR_EXIT') {
            // Check if intruders have cleared out (simulated holdings < 0.1%)
            if (marketData.intruderHoldings <= 0.1) {
                const next = cycleCount + 1;
                setCycleCount(next);
                initializeCycle(next);
                setAppState(AppState.RUNNING);
      // Sync config to backend listener
      fetch('/api/ultibot/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          enabled: true,
          tokenMint: monitoredTokenAddress,
          whitelist: walletGroups.flatMap(g => g.wallets.filter(w => w.isWhitelisted).map(w => w.address)),
          intruderTriggerPct: config.strategy.intruderTriggerPct,
          intruderActions: config.strategy.intruderActions ?? [{ type: 'ALERT' }],
          groupSellPctMin: config.strategy.groupSellPctMin,
          groupSellPctMax: config.strategy.groupSellPctMax,
          walletsPerCycle: config.walletsPerCycle ?? 5,
          monitoringRules: config.strategy.monitoringRules ?? {},
        })
      }).catch(() => {});

                addLog("✅ Intruders Cleared. Starting next cycle.");
            }
            // Else we just wait for simulation loop to reduce holdings
        } else {
            // Fixed Time Logic
            nextCycleTimeoutRef.current = setTimeout(() => {
                const next = cycleCount + 1;
                setCycleCount(next);
                initializeCycle(next);
                setAppState(AppState.RUNNING);
      // Sync config to backend listener
      fetch('/api/ultibot/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          enabled: true,
          tokenMint: monitoredTokenAddress,
          whitelist: walletGroups.flatMap(g => g.wallets.filter(w => w.isWhitelisted).map(w => w.address)),
          intruderTriggerPct: config.strategy.intruderTriggerPct,
          intruderActions: config.strategy.intruderActions ?? [{ type: 'ALERT' }],
          groupSellPctMin: config.strategy.groupSellPctMin,
          groupSellPctMax: config.strategy.groupSellPctMax,
          walletsPerCycle: config.walletsPerCycle ?? 5,
          monitoringRules: config.strategy.monitoringRules ?? {},
        })
      }).catch(() => {});

            }, config.strategy.cyclePauseTimeSec * 1000);
            return () => { if (nextCycleTimeoutRef.current) clearTimeout(nextCycleTimeoutRef.current); };
        }
    }
  }, [walletGroups, appState, marketData.intruderHoldings, config.strategy.pauseMode, config.strategy.cyclePauseTimeSec]);

  // --- MONITORING Trade Actions (simulation-based) ---
  useEffect(() => {
    if (appState !== AppState.RUNNING) return;
    const t = setInterval(() => {
      const rules = config.strategy.monitoringRules ?? {};
      setWalletGroups(prev => prev.map(g => {
        if (!g.isActive || g.phase !== CyclePhase.MONITORING) return g;

        const entry = g.entryPriceUsd ?? marketData.priceUsd;
        const tp = rules.takeProfitPct;
        const sl = rules.stopLossPct;
        const maxHold = rules.maxHoldSec;

        const ageSec = g.startTime ? (Date.now() - g.startTime) / 1000 : 0;
        let shouldExit = false;
        let exitReason = '';

        if (tp != null && marketData.priceUsd >= entry * (1 + tp/100)) { shouldExit = true; exitReason = `TP +${tp}%`; }
        if (!shouldExit && sl != null && marketData.priceUsd <= entry * (1 - sl/100)) { shouldExit = true; exitReason = `SL -${sl}%`; }
        if (!shouldExit && maxHold != null && ageSec >= maxHold) { shouldExit = true; exitReason = `MaxHold ${maxHold}s`; }

        if (!shouldExit) return g;

        // Execute a production-ready "group sell percent" exit using groupSellPctMin/Max:
        const sellPct = randRange(config.strategy.groupSellPctMin, config.strategy.groupSellPctMax);
        const updatedWallets = g.wallets.map(w => {
          if (w.status !== 'ACTIVE') return w;
          const sellTokens = w.balanceTokens * (sellPct / 100);
          const solOut = sellTokens * marketData.priceUsd;
          const newTokenBal = w.balanceTokens - sellTokens;
          return { ...w, balanceTokens: newTokenBal, balanceSol: w.balanceSol + solOut, status: (newTokenBal <= 0.00000001 ? 'EXITED' : 'ACTIVE') as any };
        });

        addLog(`📉 Monitoring Exit (${exitReason}) sold ${sellPct.toFixed(1)}% for ${g.id}`);

        const allExited = updatedWallets.every(w => w.balanceTokens <= 0.00000001 || w.status === 'EXITED');
        return { ...g, wallets: updatedWallets, phase: (allExited ? CyclePhase.COMPLETE : CyclePhase.MONITORING), isActive: (allExited ? false : g.isActive) };
      }));
    }, 1500);
    return () => clearInterval(t);
  }, [appState, config.strategy, marketData.priceUsd]);

  const activeGroup = walletGroups.find(g => g.isActive);
  const isPostCurve = marketData.bondingCurveProgress >= 100;

  // --- RENDER ---

  // 1. Landing Page View
  if (viewMode === 'LANDING') {
      return (
        <div className="min-h-screen bg-background text-white font-sans flex flex-col">
            {/* Landing Navbar */}
            <nav className="max-w-7xl mx-auto px-6 py-8 w-full flex justify-between items-center">
                <div className="flex items-center gap-2">
                    <Shield className="h-8 w-8 text-primary"/>
                    <span className="text-2xl font-bold tracking-tight">Ultibots<span className="text-primary">.xyz</span></span>
                </div>
                <div className="flex items-center gap-3">
                  <button onClick={() => setShowWalletModal(true)} className="bg-gray-800 border border-gray-700 px-4 py-2 rounded-lg text-sm hover:bg-gray-700">Create Profile</button>
                </div>
                <div className="hidden md:flex gap-8">
                    <button onClick={() => setViewMode('LANDING')} className="text-white hover:text-primary transition-colors font-bold">Home</button>
                    <button onClick={() => navigateToApp('ULTIBOT')} className="text-gray-400 hover:text-white transition-colors">Tools</button>
                    {/* Ulti Cleaner hidden but backend code remains */}
                    {/* <button onClick={() => navigateToApp('ULTICLEANER')} className="text-gray-400 hover:text-white transition-colors">Cleaner</button> */}
                    <button onClick={() => navigateToApp('ANONPAY')} className="text-gray-400 hover:text-white transition-colors">AnonPay</button>
                </div>
                <div>
                     <button onClick={() => navigateToApp('ULTIBOT')} className="bg-primary hover:bg-emerald-600 text-white px-6 py-2 rounded-full font-bold shadow-lg shadow-primary/20 transition-all">Launch App</button>
                </div>
            </nav>
{showProfileModal && (
  <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
    <div className="w-full max-w-lg bg-surface border border-gray-700 rounded-2xl p-6">
      <div className="flex items-center justify-between mb-4">
        <div className="text-lg font-bold">Wallet Profile</div>
        <button onClick={() => setShowProfileModal(false)} className="text-gray-400 hover:text-white">✕</button>
      </div>
      <div className="space-y-3">
        <input className="w-full bg-background border border-gray-700 rounded-lg px-3 py-2 text-sm outline-none" placeholder="Wallet address (optional - will generate random username)" value={profileWallet} onChange={(e)=>setProfileWallet(e.target.value)} />
        <input className="w-full bg-background border border-gray-700 rounded-lg px-3 py-2 text-sm outline-none" placeholder="Referral promo code (optional)" value={profileReferral} onChange={(e)=>setProfileReferral(e.target.value.toUpperCase())} />
        <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
          <input className="w-full bg-background border border-gray-700 rounded-lg px-3 py-2 text-sm outline-none" placeholder="Twitter @handle (optional)" value={profileTwitter} onChange={(e)=>setProfileTwitter(e.target.value)} />
          <input className="w-full bg-background border border-gray-700 rounded-lg px-3 py-2 text-sm outline-none" placeholder="TikTok @handle (optional)" value={profileTikTok} onChange={(e)=>setProfileTikTok(e.target.value)} />
          <input className="w-full bg-background border border-gray-700 rounded-lg px-3 py-2 text-sm outline-none" placeholder="Facebook name (optional)" value={profileFacebook} onChange={(e)=>setProfileFacebook(e.target.value)} />
        </div>
        <button
          onClick={async () => {
            try{
              // Generate random username if wallet not provided
              const walletAddress = profileWallet.trim() || `user_${Math.random().toString(36).substring(2, 10)}_${Date.now().toString(36)}`;
              
              const r = await fetch('/api/profile/connect', {
                method:'POST',
                headers:{'Content-Type':'application/json'},
                body: JSON.stringify({
                  wallet: walletAddress,
                  referredBy: profileReferral.trim() || undefined,
                  twitterHandle: profileTwitter.trim() || undefined,
                  tiktokHandle: profileTikTok.trim() || undefined,
                  facebookHandle: profileFacebook.trim() || undefined
                })
              });
              const j = await r.json();
              if (!r.ok) throw new Error(j?.error || 'Failed');
              setUserProfile({
                id: walletAddress,
                email: '',
                name: walletAddress.startsWith('user_') ? `User ${walletAddress.substring(5, 13)}` : `Wallet ${walletAddress.substring(0, 6)}`,
                provider: 'EMAIL',
                role: 'USER',
                wallet: walletAddress,
                promoCode: j.promoCode,
                referredBy: profileReferral.trim() || undefined,
                twitterHandle: profileTwitter.trim() || undefined,
                tiktokHandle: profileTikTok.trim() || undefined,
                facebookHandle: profileFacebook.trim() || undefined,
              });
              addLog(`👤 Profile created. Your promo code: ${j.promoCode}`);
              setShowProfileModal(false);
              // Reset form
              setProfileWallet('');
              setProfileReferral('');
              setProfileTwitter('');
              setProfileTikTok('');
              setProfileFacebook('');
            } catch(e:any){
              alert(String(e?.message ?? e));
            }
          }}
          className="w-full bg-primary hover:opacity-90 rounded-lg py-2 font-semibold"
        >
          Create Profile & Get Promo Code
        </button>
        <div className="text-xs text-gray-500">All fields are optional. A random username will be generated if wallet address is not provided.</div>
      </div>
    </div>
  </div>
)}


            {/* Hero */}
            <header className="flex-1 flex flex-col items-center justify-center text-center px-4 py-20 bg-gradient-to-b from-background to-surface/20">
                <h1 className="text-5xl md:text-7xl font-bold mb-6 tracking-tight">Privacy. Speed. <br/><span className="text-transparent bg-clip-text bg-gradient-to-r from-primary to-secondary">Sovereignty.</span></h1>
                <p className="text-xl text-gray-400 max-w-2xl mb-10 leading-relaxed">
                    The advanced toolkit for algorithmic trading management, asset consolidation, and privacy-preserving transfers on Solana.
                </p>
                <div className="flex flex-col md:flex-row gap-4">
                    <button onClick={() => navigateToApp('ULTIBOT')} className="bg-primary hover:bg-emerald-600 text-white text-lg px-8 py-4 rounded-xl font-bold shadow-xl shadow-primary/30 flex items-center gap-3 transition-all">
                        <Activity/> Launch Tools
                    </button>
                    {/* Ulti Cleaner hidden but backend code remains */}
                    {/* <button onClick={() => navigateToApp('ULTICLEANER')} className="bg-surface hover:bg-gray-800 border border-gray-700 text-white text-lg px-8 py-4 rounded-xl font-bold flex items-center gap-3 transition-all">
                        <Sparkles/> Launch Cleaner
                    </button> */}
                </div>
            </header>

            {/* Features Grid */}
            <section className="max-w-7xl mx-auto px-6 py-20 grid grid-cols-1 md:grid-cols-3 gap-8">
                <div className="bg-surface border border-gray-800 p-8 rounded-2xl hover:border-gray-600 transition-colors group">
                    <div className="bg-blue-900/30 w-12 h-12 rounded-xl flex items-center justify-center text-blue-400 mb-6 group-hover:scale-110 transition-transform"><Activity/></div>
                    <h3 className="text-xl font-bold mb-3">Algorithmic Trading</h3>
                    <p className="text-gray-400 leading-relaxed">Automated cycle management, intruder detection, and profit-building strategies for Bonding Curve environments.</p>
                </div>
                <div className="bg-surface border border-gray-800 p-8 rounded-2xl hover:border-gray-600 transition-colors group">
                    <div className="bg-purple-900/30 w-12 h-12 rounded-xl flex items-center justify-center text-purple-400 mb-6 group-hover:scale-110 transition-transform"><Ghost/></div>
                    <h3 className="text-xl font-bold mb-3">Privacy Shield</h3>
                    <p className="text-gray-400 leading-relaxed">Break the on-chain link between sender and receiver with our Shadow Pool technology for SOL and SPL tokens.</p>
                </div>
                 <div className="bg-surface border border-gray-800 p-8 rounded-2xl hover:border-gray-600 transition-colors group">
                    <div className="bg-rose-900/30 w-12 h-12 rounded-xl flex items-center justify-center text-rose-400 mb-6 group-hover:scale-110 transition-transform"><Sparkles/></div>
                    <h3 className="text-xl font-bold mb-3">Volume Cleaning</h3>
                    <p className="text-gray-400 leading-relaxed">High-volume wash and consolidation flows to manage asset distribution efficiently.</p>
                </div>
            </section>

            {/* Leaderboard Section */}
            <section className="max-w-7xl mx-auto px-6 py-20">
              <Leaderboard />
            </section>

            <footer className="border-t border-gray-800 py-12 text-center text-gray-500 text-sm">
                <div className="max-w-7xl mx-auto px-6 flex flex-col md:flex-row justify-between items-center">
                    <p>&copy; 2024 Ultibots.xyz. All rights reserved.</p>
                    <div className="flex gap-6 mt-4 md:mt-0">
                        <span className="hover:text-white cursor-pointer">Privacy Policy</span>
                        <span className="hover:text-white cursor-pointer">Terms of Service</span>
                        <span className="hover:text-white cursor-pointer">Docs</span>
                    </div>
                </div>
            </footer>
        </div>
      );
  }

  // 2. App Dashboard View
  return (
    <div className="min-h-screen bg-background text-white font-sans pb-20 overflow-x-hidden w-full">
      
      {/* LOGIN MODAL */}
      {showLoginModal && (
        <div className="fixed inset-0 bg-black/90 flex items-center justify-center z-50 backdrop-blur-sm animate-in fade-in p-4">
           <div className="bg-surface border border-gray-700 rounded-2xl p-6 w-full max-w-md shadow-2xl">
              <div className="flex justify-between items-center mb-6">
                 <h2 className="text-2xl font-bold flex items-center gap-2"><Shield className="text-primary"/> Ultibot Tools</h2>
                 <button onClick={() => setShowLoginModal(false)} className="text-gray-400 hover:text-white transition-colors"><X/></button>
              </div>
              <p className="text-gray-400 mb-6 text-sm text-center">Enter your access password to initialize the dashboard.</p>
              
              <div className="space-y-4">
                 <div>
                    <label className="text-xs text-gray-500 block mb-1 font-bold uppercase">Access Password</label>
                    <div className="relative">
                        <input 
                            type="password" 
                            className="w-full bg-black/50 border border-gray-700 rounded-lg px-4 py-3 text-white outline-none focus:border-primary transition-colors"
                            placeholder="Enter Password..."
                            value={loginPasswordInput}
                            onChange={(e) => setLoginPasswordInput(e.target.value)}
                            onKeyDown={(e) => e.key === 'Enter' && handlePasswordLogin()}
                        />
                        <Lock className="absolute right-3 top-3 text-gray-500 w-5 h-5"/>
                    </div>
                 </div>
                 
                 {loginError && <p className="text-red-500 text-xs font-bold text-center">{loginError}</p>}

                 <button onClick={handlePasswordLogin} className="w-full bg-primary text-white font-bold py-3 rounded-lg flex items-center justify-center gap-2 hover:bg-emerald-600 transition-colors shadow-lg shadow-primary/20">
                    Initialize System <ArrowRight className="w-4 h-4"/>
                 </button>
              </div>
           </div>
        </div>
      )}

      {/* ADMIN GATE MODAL */}
      {showAdminGateModal && (
        <div className="fixed inset-0 bg-black/90 flex items-center justify-center z-50 backdrop-blur-sm animate-in fade-in p-4">
           <div className="bg-surface border border-gray-700 rounded-2xl p-6 w-full max-w-md shadow-2xl border-t-4 border-t-accent">
              <div className="flex justify-between items-center mb-6">
                 <h2 className="text-xl font-bold flex items-center gap-2 text-accent"><Lock className="text-accent"/> Admin Verification</h2>
                 <button onClick={() => {
                   setShowAdminGateModal(false);
                   setPendingAdminTab(null);
                   setAdminGateInput('');
                   setAdminGateError('');
                   // Reset to safe tab if modal is closed without password
                   if (activeTab === 'ADMIN') {
                     setActiveTab('ANONPAY');
                   }
                 }} className="text-gray-400 hover:text-white transition-colors"><X/></button>
              </div>
              <p className="text-gray-400 mb-6 text-xs text-center">Restricted Area. Authorized personnel only.</p>
              
              <div className="space-y-4">
                 <div>
                    <div className="relative">
                        <input 
                            type="password" 
                            className="w-full bg-black/50 border border-gray-700 rounded-lg px-4 py-3 text-white outline-none focus:border-accent transition-colors"
                            placeholder="Admin Password..."
                            value={adminGateInput}
                            onChange={(e) => setAdminGateInput(e.target.value)}
                            onKeyDown={(e) => e.key === 'Enter' && handleAdminGateSubmit()}
                        />
                    </div>
                 </div>
                 
                 {adminGateError && <p className="text-red-500 text-xs font-bold text-center">{adminGateError}</p>}

                 <button onClick={handleAdminGateSubmit} className="w-full bg-accent text-white font-bold py-3 rounded-lg flex items-center justify-center gap-2 hover:bg-rose-600 transition-colors shadow-lg shadow-accent/20">
                    Enter Admin Panel <ArrowRight className="w-4 h-4"/>
                 </button>
              </div>
           </div>
        </div>
      )}

      {/* WALLET SELECTION MODAL */}
      {showWalletModal && (
        <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 backdrop-blur-sm p-4">
           <div className="bg-surface border border-gray-700 rounded-2xl p-6 w-full max-w-sm shadow-2xl">
              <div className="flex justify-between items-center mb-4">
                 <h3 className="text-lg font-bold">Connect Wallet</h3>
                 <button onClick={() => setShowWalletModal(false)} className="text-gray-400 hover:text-white"><X/></button>
              </div>
              <div className="space-y-2">
                 <button onClick={() => connectSpecificWallet('PHANTOM')} className="w-full flex items-center justify-between p-4 bg-gray-900 hover:bg-gray-800 rounded-xl border border-gray-800 transition-all group">
                    <span className="font-bold text-sm">Phantom</span>
                    <Phantom className="w-6 h-6" />
                 </button>
                 <button onClick={() => connectSpecificWallet('SOLFLARE')} className="w-full flex items-center justify-between p-4 bg-gray-900 hover:bg-gray-800 rounded-xl border border-gray-800 transition-all group">
                    <span className="font-bold text-sm">Solflare</span>
                    <Solflare className="w-6 h-6" />
                 </button>
              </div>
           </div>
        </div>
      )}

      {/* PROMO CODE MODAL */}
      {showPromoCodeModal && (
        <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 backdrop-blur-sm p-4">
          <div className="bg-surface border border-gray-700 rounded-2xl p-6 w-full max-w-md shadow-2xl">
            <div className="flex justify-between items-center mb-4">
              <h3 className="text-lg font-bold">Complete Your Profile</h3>
              <button onClick={() => { setShowPromoCodeModal(false); setPendingWalletAddress(''); }} className="text-gray-400 hover:text-white"><X/></button>
            </div>
            
            <div className="space-y-4">
              <div>
                <label className="text-sm text-gray-400 block mb-2">Choose a Username (Optional)</label>
                <input
                  type="text"
                  value={profileUsername}
                  onChange={(e) => setProfileUsername(e.target.value)}
                  placeholder="Leave blank for auto-generated username"
                  className="w-full bg-background border border-gray-700 rounded-lg px-4 py-2 text-white outline-none focus:border-primary"
                />
                <p className="text-xs text-gray-500 mt-1">If left blank, a unique username will be generated for you</p>
              </div>

              <div>
                <label className="text-sm text-gray-400 block mb-2">Referral Code (Optional)</label>
                <input
                  type="text"
                  value={promoCodeInput}
                  onChange={(e) => setPromoCodeInput(e.target.value.toUpperCase())}
                  placeholder="Enter promo code"
                  className="w-full bg-background border border-gray-700 rounded-lg px-4 py-2 text-white outline-none focus:border-primary"
                />
              </div>

              <div>
                <label className="text-sm text-gray-400 block mb-2">Connect Social Media (Optional)</label>
                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <input
                      type="text"
                      value={profileTwitter}
                      onChange={(e) => setProfileTwitter(e.target.value)}
                      placeholder="@twitter_handle"
                      className="flex-1 bg-background border border-gray-700 rounded-lg px-4 py-2 text-white outline-none focus:border-primary"
                    />
                    <button
                      onClick={() => {
                        // OAuth integration - can be configured later
                        addLog('ℹ️ Twitter OAuth integration available. Enter handle manually or configure API keys.');
                      }}
                      className="px-4 py-2 bg-blue-500 hover:bg-blue-600 rounded-lg text-white text-sm font-bold"
                    >
                      Connect
                    </button>
                  </div>
                  <div className="flex items-center gap-2">
                    <input
                      type="text"
                      value={profileTikTok}
                      onChange={(e) => setProfileTikTok(e.target.value)}
                      placeholder="@tiktok_handle"
                      className="flex-1 bg-background border border-gray-700 rounded-lg px-4 py-2 text-white outline-none focus:border-primary"
                    />
                    <button
                      onClick={() => {
                        // OAuth integration - can be configured later
                        addLog('ℹ️ TikTok OAuth integration available. Enter handle manually or configure API keys.');
                      }}
                      className="px-4 py-2 bg-black hover:bg-gray-900 rounded-lg text-white text-sm font-bold"
                    >
                      Connect
                    </button>
                  </div>
                  <div className="flex items-center gap-2">
                    <input
                      type="text"
                      value={profileFacebook}
                      onChange={(e) => setProfileFacebook(e.target.value)}
                      placeholder="Facebook name"
                      className="flex-1 bg-background border border-gray-700 rounded-lg px-4 py-2 text-white outline-none focus:border-primary"
                    />
                    <button
                      onClick={() => {
                        // OAuth integration - can be configured later
                        addLog('ℹ️ Facebook OAuth integration available. Enter handle manually or configure API keys.');
                      }}
                      className="px-4 py-2 bg-blue-600 hover:bg-blue-700 rounded-lg text-white text-sm font-bold"
                    >
                      Connect
                    </button>
                  </div>
                </div>
              </div>

              <button
                onClick={handlePromoCodeSubmit}
                className="w-full bg-primary hover:bg-emerald-600 text-white font-bold py-3 rounded-lg transition-all"
              >
                Complete Setup
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Key Modal */}
      {showKeyModal && (
        <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 p-4">
          <div className="bg-surface border border-gray-700 rounded-xl p-6 w-full max-w-lg">
             <div className="flex justify-between items-center mb-6">
              <h3 className="text-lg font-bold flex items-center gap-2"><Key className="text-primary"/> Manage {editingWalletRole} Wallet</h3>
              <button onClick={() => setShowKeyModal(false)} className="text-gray-400 hover:text-white"><X/></button>
            </div>
            <div className="mb-4">
              <label className="text-xs text-gray-400 block mb-2">Private Key (Hex, Base58, or JSON array format)</label>
              <textarea 
                value={tempPrivateKey} 
                onChange={(e) => setTempPrivateKey(e.target.value)} 
                className="w-full h-32 bg-background border border-gray-700 rounded-lg p-3 text-xs font-mono text-green-400 outline-none focus:border-primary transition-colors" 
                placeholder="Paste Private Key (64-char hex, 88-char base58, or JSON array)..." 
              />
              <p className="text-[10px] text-gray-500 mt-2">
                Supported formats: 64-char hex, 88-char base58, 128-char hex, or JSON array [32 or 64 numbers]
              </p>
            </div>
            <div className="flex gap-4 mt-4">
                <button onClick={generateNewWallet} className="flex-1 bg-gray-700 hover:bg-gray-600 py-3 rounded-lg font-bold text-sm transition-colors">Generate New</button>
                <button onClick={savePrivateKey} className="flex-1 bg-primary hover:bg-emerald-600 py-3 rounded-lg font-bold text-sm transition-colors">Import & Save</button>
            </div>
          </div>
        </div>
      )}

      {/* Navbar */}
      <nav className="border-b border-gray-700 bg-surface/80 backdrop-blur-md sticky top-0 z-40">
        <div className="max-w-7xl mx-auto px-4 flex flex-col md:flex-row items-center justify-between gap-2 md:gap-0 py-2 md:py-0 md:h-16">
            <div className="flex items-center gap-3 w-full md:w-auto justify-between md:justify-start">
              <button onClick={() => setViewMode('LANDING')} className="flex items-center gap-2 hover:opacity-80 transition-opacity">
                  <Shield className="text-primary h-6 w-6" />
                  <span className="font-bold text-xl tracking-tight">Ultibot<span className="text-primary">Tools</span></span>
              </button>
               {/* Mobile Status Badge */}
               <div className="md:hidden text-[10px] bg-gray-800 px-2 py-1 rounded text-gray-400 border border-gray-700">
                 Role: <span className="text-white font-bold">{currentUserRole}</span>
               </div>
            </div>
            
            {/* Tabs - Scrollable on mobile */}
            <div className="w-full md:w-auto overflow-x-auto pb-1 md:pb-0 no-scrollbar">
                <div className="flex items-center bg-gray-900 rounded-lg p-1 border border-gray-700 min-w-max mx-auto">
                <button onClick={() => handleTabClick('ULTIBOT')} className={`flex items-center gap-2 px-4 py-1.5 text-xs font-bold rounded-md transition-all whitespace-nowrap ${activeTab === 'ULTIBOT' ? 'bg-primary text-white' : 'text-gray-400 hover:text-white'}`}>
                    {(!isLoggedIn) && <Lock className="w-3 h-3"/>} ULTIBOT TOOLS
                </button>
                <button onClick={() => handleTabClick('ANONPAY')} className={`flex items-center gap-2 px-4 py-1.5 text-xs font-bold rounded-md transition-all whitespace-nowrap ${activeTab === 'ANONPAY' ? 'bg-primary text-white' : 'text-gray-400 hover:text-white'}`}>
                    ANONPAY
                </button>
                {/* ULTI CLEANER tab hidden but backend code remains */}
                {/* <button onClick={() => handleTabClick('ULTICLEANER')} className={`flex items-center gap-2 px-4 py-1.5 text-xs font-bold rounded-md transition-all whitespace-nowrap ${activeTab === 'ULTICLEANER' ? 'bg-primary text-white' : 'text-gray-400 hover:text-white'}`}>
                    {!(currentUserRole === 'ADMIN' || currentUserRole === 'OWNER') && <Lock className="w-3 h-3 text-gray-500"/>} ULTI CLEANER
                </button> */}
                <button onClick={() => handleTabClick('ADMIN')} className={`flex items-center gap-2 px-4 py-1.5 text-xs font-bold rounded-md transition-all whitespace-nowrap ${activeTab === 'ADMIN' ? 'bg-primary text-white' : 'text-gray-400 hover:text-white'}`}>
                    {!(currentUserRole === 'ADMIN' || currentUserRole === 'OWNER') && <Lock className="w-3 h-3 text-gray-500"/>} ADMIN
                </button>
                {/* Market Maker only visible after admin login */}
                {isAdminLoggedIn && (currentUserRole === 'ADMIN' || currentUserRole === 'OWNER') && (
                <button onClick={() => handleTabClick('MARKETMAKER')} className={`flex items-center gap-2 px-4 py-1.5 text-xs font-bold rounded-md transition-all whitespace-nowrap ${activeTab === 'MARKETMAKER' ? 'bg-primary text-white' : 'text-gray-400 hover:text-white'}`}>
                    MARKET MAKER
                </button>
                )}
                </div>
            </div>
            
            <div className="hidden md:flex items-center gap-4">
               <div className="text-[10px] bg-gray-800 px-2 py-1 rounded text-gray-400 border border-gray-700">
                 Status: <span className="text-white font-bold">{currentUserRole}</span>
               </div>

               {isLoggedIn ? (
                 <div className="flex items-center gap-3">
                    <button onClick={handleLogout} className="text-xs bg-gray-800 hover:bg-gray-700 px-3 py-1.5 rounded text-white border border-gray-700 transition-colors">Log Out</button>
                 </div>
               ) : (
                 <button onClick={() => setShowLoginModal(true)} className="bg-primary text-white px-4 py-1.5 rounded-lg text-sm font-bold hover:bg-emerald-600 transition-colors">Login</button>
               )}
            </div>
        </div>
      </nav>

      <div className="max-w-7xl mx-auto p-4 md:p-6">
        
        {/* --- ULTIBOT TOOLS TAB --- */}
        {activeTab === 'ULTIBOT' && (
          <div className="space-y-6">

            {/* Documentation Module */}
            <InfoPanel title="User Guide: Ultibot Tools">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                    <div>
                        <h4 className="font-bold text-white mb-2">Capabilities</h4>
                        <ul className="list-disc list-inside space-y-1 text-gray-400">
                            <li>Automated "Profit Builder" cycles with randomized intervals.</li>
                            <li>Real-time Bonding Curve monitoring ($69k limit awareness).</li>
                            <li>Intruder Detection: Automatically defends against un-whitelisted wallets.</li>
                            <li>Privacy Mode: Uses Shadow Pools to anonymize funding cycles.</li>
                        </ul>
                    </div>
                    <div>
                        <h4 className="font-bold text-white mb-2">Workflow</h4>
                        <ol className="list-decimal list-inside space-y-1 text-gray-400">
                            <li><strong>Setup:</strong> Enter the Token Address to monitor.</li>
                            <li><strong>Strategy:</strong> Select a preset or customize parameters (Buy %, Trigger %).</li>
                            <li><strong>Fund:</strong> Ensure Funding Wallet has SOL.</li>
                            <li><strong>Launch:</strong> Click "START BOT". System generates wallets, funds them, and begins trading.</li>
                        </ol>
                    </div>
                </div>
            </InfoPanel>

            {/* Special Wallets + Unwhitelisted Tracker */}
            <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                {specialWallets.map(wallet => (
                    <div key={wallet.role} className="bg-surface border border-gray-700 rounded-xl p-4 relative overflow-hidden group">
                         <div className="absolute top-0 right-0 p-2 opacity-0 group-hover:opacity-100 transition-opacity">
                             <button onClick={() => openKeyModal(wallet.role)} className="text-gray-400 hover:text-white bg-black/50 p-1 rounded"><Settings className="w-4 h-4"/></button>
                         </div>
                         <div className={`w-1 h-full absolute left-0 top-0 ${
                             wallet.role === 'FUNDING' ? 'bg-blue-500' : wallet.role === 'PROFIT' ? 'bg-green-500' : 'bg-orange-500'
                         }`}></div>
                         <p className="text-[10px] uppercase font-bold text-gray-500 mb-1">{wallet.role} Wallet</p>
                         <p className="text-xs font-mono text-gray-300 mb-2 truncate">{wallet.address}</p>
                         <div className="flex items-center gap-2">
                           <p className="text-xl font-bold">{wallet.balanceSol.toFixed(4)} <span className="text-xs font-normal text-gray-400">SOL</span></p>
                           {wallet.privateKey && (
                             <button
                               onClick={async (e) => {
                                 e.stopPropagation();
                                 try {
                                   addLog(`🔄 Refreshing ${wallet.role} balance...`);
                                   const res = await authFetch('/api/wallet/balance', {
                                     method: 'POST',
                                     body: JSON.stringify({
                                       privateKey: wallet.privateKey,
                                       rpcUrl: rpcUrl || undefined
                                     })
                                   });
                                   
                                   if (res.ok) {
                                     const data = await res.json();
                                     setSpecialWallets(prev => prev.map(w => {
                                       if (w.role === wallet.role) {
                                         return {
                                           ...w,
                                           address: data.publicKey,
                                           balanceSol: data.balance || 0
                                         };
                                       }
                                       return w;
                                     }));
                                     addLog(`✅ ${wallet.role} balance updated: ${(data.balance || 0).toFixed(4)} SOL`);
                                   } else {
                                     const errorText = await res.text();
                                     addLog(`❌ Failed to refresh balance: ${errorText}`);
                                   }
                                 } catch (e: any) {
                                   addLog(`❌ Error refreshing balance: ${String(e?.message || e)}`);
                                 }
                               }}
                               className="text-gray-400 hover:text-primary transition-colors p-1"
                               title="Refresh balance"
                             >
                               <RefreshCw className="w-4 h-4" />
                             </button>
                           )}
                         </div>
                    </div>
                ))}
                {/* Unwhitelisted Tracker */}
                <div className="bg-surface border border-gray-700 rounded-xl p-4 relative overflow-hidden">
                    <div className={`w-1 h-full absolute left-0 top-0 bg-red-500`}></div>
                    <p className="text-[10px] uppercase font-bold text-gray-500 mb-1">Unwhitelisted Holdings</p>
                    <p className="text-xl font-bold text-white mb-2">
                        ${(() => {
                            const totalValue = walletGroups.flatMap(g => g.wallets)
                                .filter(w => !w.isWhitelisted)
                                .reduce((sum, w) => sum + (w.balanceTokens * marketData.priceUsd), 0);
                            return totalValue.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
                        })()}
                    </p>
                    <button
                        onClick={() => {
                            const whitelistedWallets = walletGroups.flatMap(g => g.wallets).filter(w => w.isWhitelisted && w.balanceTokens > 0);
                            if (whitelistedWallets.length === 0) {
                                addLog('⚠️ No whitelisted wallets with tokens to sell.');
                                return;
                            }
                            whitelistedWallets.forEach(w => {
                                const group = walletGroups.find(g => g.wallets.some(w2 => w2.id === w.id));
                                if (group) {
                                    executeGroupSell(group.id, 100, 'SELL ALL');
                                }
                            });
                            addLog(`💰 SELL ALL: Selling all tokens from ${whitelistedWallets.length} whitelisted wallets.`);
                        }}
                        className="w-full mt-2 bg-red-600 hover:bg-red-700 text-white text-xs font-bold py-2 px-3 rounded-lg transition-colors"
                    >
                        SELL ALL
                    </button>
                    <button
                        onClick={executeUnwhitelistedSellFromActiveGroup}
                        className="w-full mt-2 bg-orange-600 hover:bg-orange-700 text-white text-xs font-bold py-2 px-3 rounded-lg transition-colors"
                    >
                        SELL UNWHITELISTED FROM ACTIVE GROUP
                    </button>
                </div>
            </div>

            {/* Top Stats */}
            <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
              <StatsCard label="Cycle Status" value={activeGroup?.phase || (appState === AppState.RESTARTING ? "RESTARTING" : "IDLE")} subValue={`Cycle #${cycleCount}`} trend="neutral" icon={<RefreshCw className="text-primary"/>} />
              <StatsCard label="Active Strategy" value={strategies.find(s => s.id === selectedStrategyId)?.name.split(':')[0] || "None"} subValue={`${walletGroups.find(g => g.isActive)?.wallets.length || 0} Wallets Active`} trend="up" icon={<Activity />} />
              <StatsCard label="Market Cap" value={`$${marketData.marketCap.toLocaleString()}`} subValue={`Target: $${config.targetMarketCapSell.toLocaleString()}`} trend="up" icon={<Activity />} />
              
              <div className="bg-surface border border-gray-700 rounded-xl p-5 shadow-lg">
                 <div className="flex justify-between items-start mb-2">
                   <p className="text-muted text-sm font-medium">Live Status</p>
                   <span className={`px-2 py-0.5 rounded text-[10px] font-bold ${isPostCurve ? 'bg-purple-500/20 text-purple-400' : 'bg-blue-500/20 text-blue-400'}`}>
                     {isPostCurve ? 'DEX TRADING' : 'CURVE BONDING'}
                   </span>
                 </div>
                 <div className="w-full bg-gray-800 rounded-full h-2 mb-1">
                    <div className={`h-2 rounded-full transition-all duration-1000 ${isPostCurve ? 'bg-purple-500' : 'bg-blue-500'}`} style={{ width: `${marketData.bondingCurveProgress}%` }}></div>
                 </div>
                 <p className="text-xs text-gray-400 text-right">{marketData.bondingCurveProgress.toFixed(1)}% Complete</p>
              </div>
            </div>

            {/* Wallet Groups Management */}
            <div className="bg-surface border border-gray-700 rounded-xl p-5">
                <div className="flex justify-between items-center mb-4">
                    <h3 className="text-lg font-bold flex items-center gap-2"><Users className="w-5 h-5"/> Wallet Groups</h3>
                    {walletGroups.length > 0 && (
                        <button
                            onClick={() => {
                                const newGroupId = `group-${Date.now()}`;
                                const newGroup: WalletGroup = {
                                    id: newGroupId,
                                    name: `Group ${walletGroups.length + 1}`,
                                    cycleNumber: walletGroups.length + 1,
                                    isActive: false,
                                    phase: CyclePhase.PENDING,
                                    hasDefended: false,
                                    wallets: [],
                                    initialBuySolPct: config.strategy.initialBuySolPct,
                                    intruderTriggerPct: config.strategy.intruderTriggerPct,
                                    groupSellPctMin: config.strategy.groupSellPctMin,
                                    groupSellPctMax: config.strategy.groupSellPctMax,
                                    walletsPerGroup: config.walletsPerCycle ?? 5,
                                    tpStopLossPairs: [
                                        { tpBuy: undefined, stopLossBuy: undefined, tpSell: undefined, stopLossSell: undefined },
                                        { tpBuy: undefined, stopLossBuy: undefined, tpSell: undefined, stopLossSell: undefined }
                                    ],
                                    marketCapTakeProfit: []
                                };
                                setWalletGroups(prev => [...prev, newGroup]);
                                addLog(`✅ Created new wallet group: ${newGroup.name}`);
                            }}
                            className="bg-primary hover:bg-emerald-600 text-white px-4 py-2 rounded-lg font-bold flex items-center gap-2"
                        >
                            <Plus className="w-4 h-4"/> Create New Group
                        </button>
                    )}
                </div>

                {walletGroups.length === 0 ? (
                    <div className="text-center py-8 text-gray-500">
                        <p className="mb-4">No wallet groups yet. Click Enter to create your first wallet group.</p>
                        <button
                            onClick={async () => {
                                const newGroupId = `group-${Date.now()}`;
                                const newGroup: WalletGroup = {
                                    id: newGroupId,
                                    name: `Group ${walletGroups.length + 1}`,
                                    cycleNumber: walletGroups.length + 1,
                                    isActive: false,
                                    phase: CyclePhase.PENDING,
                                    hasDefended: false,
                                    wallets: [],
                                    initialBuySolPct: config.strategy.initialBuySolPct,
                                    intruderTriggerPct: config.strategy.intruderTriggerPct,
                                    groupSellPctMin: config.strategy.groupSellPctMin,
                                    groupSellPctMax: config.strategy.groupSellPctMax,
                                    walletsPerGroup: config.walletsPerCycle ?? 5,
                                    tpStopLossPairs: [
                                        { tpBuy: undefined, stopLossBuy: undefined, tpSell: undefined, stopLossSell: undefined },
                                        { tpBuy: undefined, stopLossBuy: undefined, tpSell: undefined, stopLossSell: undefined }
                                    ],
                                    marketCapTakeProfit: []
                                };
                                setWalletGroups(prev => [...prev, newGroup]);
                                await saveWalletGroupToBackend(newGroup);
                                addLog(`✅ Created new wallet group: ${newGroup.name}`);
                            }}
                            className="bg-primary hover:bg-emerald-600 text-white px-6 py-3 rounded-lg font-bold text-lg flex items-center gap-2 mx-auto transition-all shadow-lg shadow-primary/20"
                        >
                            <ArrowRight className="w-5 h-5"/> Enter
                        </button>
                    </div>
                ) : (
                    <div className="overflow-x-auto pb-2 -mx-2 px-2">
                        <div className="flex gap-4 min-w-max">
                            {walletGroups.map(group => (
                                <div key={group.id} className="bg-background border border-gray-700 rounded p-2 flex-shrink-0" style={{ width: 'calc(25% - 12px)', minWidth: '100px' }}>
                                    <div className="flex justify-between items-center mb-2">
                                        <div>
                                            <h4 className="font-bold text-white text-xs">{group.name}</h4>
                                            <p className="text-[8px] text-gray-400">
                                                {group.phase} | {group.wallets.length}/{group.walletsPerGroup ?? (config.walletsPerCycle ?? 5)}
                                            </p>
                                        </div>
                                        <div className="flex gap-1">
                                            <button
                                                onClick={() => {
                                                    const newName = prompt('Enter new group name:', group.name);
                                                    if (newName) {
                                                        setWalletGroups(prev => prev.map(g => g.id === group.id ? { ...g, name: newName } : g));
                                                    }
                                                }}
                                                className="text-gray-400 hover:text-white"
                                            >
                                                <Settings className="w-2 h-2"/>
                                            </button>
                                            {!group.isActive && (
                                                <button
                                                    onClick={() => setWalletGroups(prev => prev.filter(g => g.id !== group.id))}
                                                    className="text-red-400 hover:text-red-300"
                                                >
                                                    <Trash2 className="w-2 h-2"/>
                                                </button>
                                            )}
                                        </div>
                                    </div>

                                    {/* First Row: Wallets for this group and Initial Buy %} */}
                                    <div className="grid grid-cols-2 gap-2 mb-2">
                                        <div>
                                            <label className="text-[8px] text-gray-500 block mb-0.5">wallets</label>
                                            <input
                                                type="number"
                                                min={1}
                                                max={50}
                                                value={group.walletsPerGroup ?? (config.walletsPerCycle ?? 5)}
                                                onChange={(e) => setWalletGroups(prev => prev.map(g =>
                                                    g.id === group.id ? { ...g, walletsPerGroup: Math.max(1, Math.min(50, parseInt(e.target.value) || 5)) } : g
                                                ))}
                                                className="w-full bg-gray-800 border border-gray-700 rounded px-1 py-0.5 text-white text-xs"
                                            />
                                        </div>
                                        <div>
                                            <label className="text-[8px] text-gray-500 block mb-0.5">Initial Buy %</label>
                                            <input
                                                type="number"
                                                value={group.initialBuySolPct ?? config.strategy.initialBuySolPct}
                                                onChange={(e) => setWalletGroups(prev => prev.map(g =>
                                                    g.id === group.id ? { ...g, initialBuySolPct: parseFloat(e.target.value) } : g
                                                ))}
                                                className="w-full bg-gray-800 border border-gray-700 rounded px-1 py-0.5 text-white text-xs"
                                            />
                                        </div>
                                    </div>

                                    {/* Intruder and Sell Range Configuration */}
                                    <div className="grid grid-cols-3 gap-2 mb-2">
                                        <div>
                                            <label className="text-[8px] text-gray-500 block mb-0.5">Intruder %</label>
                                            <input
                                                type="number"
                                                value={group.intruderTriggerPct ?? config.strategy.intruderTriggerPct}
                                                onChange={(e) => setWalletGroups(prev => prev.map(g =>
                                                    g.id === group.id ? { ...g, intruderTriggerPct: parseFloat(e.target.value) } : g
                                                ))}
                                                className="w-full bg-gray-800 border border-gray-700 rounded px-1 py-0.5 text-white text-xs"
                                            />
                                        </div>
                                        <div>
                                            <label className="text-[8px] text-gray-500 block mb-0.5">Sell Min %</label>
                                            <input
                                                type="number"
                                                value={group.groupSellPctMin ?? config.strategy.groupSellPctMin}
                                                onChange={(e) => setWalletGroups(prev => prev.map(g =>
                                                    g.id === group.id ? { ...g, groupSellPctMin: parseFloat(e.target.value) } : g
                                                ))}
                                                className="w-full bg-gray-800 border border-gray-700 rounded px-1 py-0.5 text-white text-xs"
                                            />
                                        </div>
                                        <div>
                                            <label className="text-[8px] text-gray-500 block mb-0.5">Sell Max %</label>
                                            <input
                                                type="number"
                                                value={group.groupSellPctMax ?? config.strategy.groupSellPctMax}
                                                onChange={(e) => setWalletGroups(prev => prev.map(g =>
                                                    g.id === group.id ? { ...g, groupSellPctMax: parseFloat(e.target.value) } : g
                                                ))}
                                                className="w-full bg-gray-800 border border-gray-700 rounded px-1 py-0.5 text-white text-xs"
                                            />
                                        </div>
                                    </div>

                                    {/* TP and Stop Loss Rows for Buying and Selling */}
                                    <div className="space-y-1.5 mb-1.5">
                                        {((group.tpStopLossPairs && group.tpStopLossPairs.length > 0) ? group.tpStopLossPairs : [
                                            { tpBuy: undefined, stopLossBuy: undefined, tpSell: undefined, stopLossSell: undefined },
                                            { tpBuy: undefined, stopLossBuy: undefined, tpSell: undefined, stopLossSell: undefined }
                                        ]).map((pair, index) => (
                                            <div key={index} className="border border-gray-700 rounded p-1.5 bg-gray-800/50">
                                                <div className="text-[8px] text-gray-400 mb-1 font-bold">Rule {index + 1}</div>
                                                <div className="grid grid-cols-2 gap-1.5 mb-1.5">
                                                    <div>
                                                        <label className="text-[8px] text-gray-500 block mb-0.5">TP Buy %</label>
                                                        <input
                                                            type="number"
                                                            value={pair.tpBuy ?? ''}
                                                            onChange={(e) => {
                                                                const value = e.target.value === '' ? undefined : parseFloat(e.target.value);
                                                                setWalletGroups(prev => prev.map(g => {
                                                                    if (g.id !== group.id) return g;
                                                                    const pairs = g.tpStopLossPairs ?? [
                                                                        { tpBuy: undefined, stopLossBuy: undefined, tpSell: undefined, stopLossSell: undefined },
                                                                        { tpBuy: undefined, stopLossBuy: undefined, tpSell: undefined, stopLossSell: undefined }
                                                                    ];
                                                                    const newPairs = [...pairs];
                                                                    if (!newPairs[index]) newPairs[index] = { tpBuy: undefined, stopLossBuy: undefined, tpSell: undefined, stopLossSell: undefined };
                                                                    newPairs[index] = { ...newPairs[index], tpBuy: value };
                                                                    return { ...g, tpStopLossPairs: newPairs };
                                                                }));
                                                            }}
                                                            className="w-full bg-gray-800 border border-gray-700 rounded px-1 py-0.5 text-white text-xs"
                                                            placeholder="TP Buy"
                                                        />
                                                    </div>
                                                    <div>
                                                        <label className="text-[8px] text-gray-500 block mb-0.5">SL Buy %</label>
                                                        <input
                                                            type="number"
                                                            value={pair.stopLossBuy ?? ''}
                                                            onChange={(e) => {
                                                                const value = e.target.value === '' ? undefined : parseFloat(e.target.value);
                                                                setWalletGroups(prev => prev.map(g => {
                                                                    if (g.id !== group.id) return g;
                                                                    const pairs = g.tpStopLossPairs ?? [
                                                                        { tpBuy: undefined, stopLossBuy: undefined, tpSell: undefined, stopLossSell: undefined },
                                                                        { tpBuy: undefined, stopLossBuy: undefined, tpSell: undefined, stopLossSell: undefined }
                                                                    ];
                                                                    const newPairs = [...pairs];
                                                                    if (!newPairs[index]) newPairs[index] = { tpBuy: undefined, stopLossBuy: undefined, tpSell: undefined, stopLossSell: undefined };
                                                                    newPairs[index] = { ...newPairs[index], stopLossBuy: value };
                                                                    return { ...g, tpStopLossPairs: newPairs };
                                                                }));
                                                            }}
                                                            className="w-full bg-gray-800 border border-gray-700 rounded px-1 py-0.5 text-white text-xs"
                                                            placeholder="SL Buy"
                                                        />
                                                    </div>
                                                </div>
                                                <div className="grid grid-cols-2 gap-1.5">
                                                    <div>
                                                        <label className="text-[8px] text-gray-500 block mb-0.5">TP Sell %</label>
                                                        <input
                                                            type="number"
                                                            value={pair.tpSell ?? ''}
                                                            onChange={(e) => {
                                                                const value = e.target.value === '' ? undefined : parseFloat(e.target.value);
                                                                setWalletGroups(prev => prev.map(g => {
                                                                    if (g.id !== group.id) return g;
                                                                    const pairs = g.tpStopLossPairs ?? [
                                                                        { tpBuy: undefined, stopLossBuy: undefined, tpSell: undefined, stopLossSell: undefined },
                                                                        { tpBuy: undefined, stopLossBuy: undefined, tpSell: undefined, stopLossSell: undefined }
                                                                    ];
                                                                    const newPairs = [...pairs];
                                                                    if (!newPairs[index]) newPairs[index] = { tpBuy: undefined, stopLossBuy: undefined, tpSell: undefined, stopLossSell: undefined };
                                                                    newPairs[index] = { ...newPairs[index], tpSell: value };
                                                                    return { ...g, tpStopLossPairs: newPairs };
                                                                }));
                                                            }}
                                                            className="w-full bg-gray-800 border border-gray-700 rounded px-1 py-0.5 text-white text-xs"
                                                            placeholder="TP Sell"
                                                        />
                                                    </div>
                                                    <div>
                                                        <label className="text-[8px] text-gray-500 block mb-0.5">SL Sell %</label>
                                                        <input
                                                            type="number"
                                                            value={pair.stopLossSell ?? ''}
                                                            onChange={(e) => {
                                                                const value = e.target.value === '' ? undefined : parseFloat(e.target.value);
                                                                setWalletGroups(prev => prev.map(g => {
                                                                    if (g.id !== group.id) return g;
                                                                    const pairs = g.tpStopLossPairs ?? [
                                                                        { tpBuy: undefined, stopLossBuy: undefined, tpSell: undefined, stopLossSell: undefined },
                                                                        { tpBuy: undefined, stopLossBuy: undefined, tpSell: undefined, stopLossSell: undefined }
                                                                    ];
                                                                    const newPairs = [...pairs];
                                                                    if (!newPairs[index]) newPairs[index] = { tpBuy: undefined, stopLossBuy: undefined, tpSell: undefined, stopLossSell: undefined };
                                                                    newPairs[index] = { ...newPairs[index], stopLossSell: value };
                                                                    return { ...g, tpStopLossPairs: newPairs };
                                                                }));
                                                            }}
                                                            className="w-full bg-gray-800 border border-gray-700 rounded px-1 py-0.5 text-white text-xs"
                                                            placeholder="SL Sell"
                                                        />
                                                    </div>
                                                </div>
                                            </div>
                                        ))}
                                    </div>

                                    {/* Add More TP/Stop Loss Button */}
                                    <button
                                        onClick={() => {
                                            setWalletGroups(prev => prev.map(g => {
                                                if (g.id !== group.id) return g;
                                                const pairs = g.tpStopLossPairs ?? [
                                                    { tpBuy: undefined, stopLossBuy: undefined, tpSell: undefined, stopLossSell: undefined },
                                                    { tpBuy: undefined, stopLossBuy: undefined, tpSell: undefined, stopLossSell: undefined }
                                                ];
                                                return { ...g, tpStopLossPairs: [...pairs, { tpBuy: undefined, stopLossBuy: undefined, tpSell: undefined, stopLossSell: undefined }] };
                                            }));
                                        }}
                                        className="w-full bg-gray-700 hover:bg-gray-600 text-white text-[10px] font-bold py-1 px-1.5 rounded transition-colors flex items-center justify-center gap-1 mb-1.5"
                                    >
                                        <Plus className="w-1.5 h-1.5"/> Add Rule
                                    </button>

                                    {/* Market Cap Take Profit Schedule */}
                                    <div className="mt-2 pt-2 border-t border-gray-700">
                                        <div className="text-[10px] text-gray-400 mb-1.5 font-bold">Market Cap Take Profit</div>
                                        <div className="space-y-1.5 mb-1.5">
                                            {((group.marketCapTakeProfit && group.marketCapTakeProfit.length > 0) ? group.marketCapTakeProfit : []).map((rule, index) => (
                                                <div key={index} className="border border-gray-700 rounded p-1.5 bg-gray-800/30">
                                                    <div className="grid grid-cols-2 gap-1.5">
                                                        <div>
                                                            <label className="text-[8px] text-gray-500 block mb-0.5">Sell %</label>
                                                            <input
                                                                type="number"
                                                                value={rule.sellPct ?? ''}
                                                                onChange={(e) => {
                                                                    const value = e.target.value === '' ? undefined : parseFloat(e.target.value);
                                                                    setWalletGroups(prev => prev.map(g => {
                                                                        if (g.id !== group.id) return g;
                                                                        const rules = g.marketCapTakeProfit ?? [];
                                                                        const newRules = [...rules];
                                                                        if (!newRules[index]) newRules[index] = { marketCapIncreaseDollar: undefined, sellPct: undefined, executed: false };
                                                                        newRules[index] = { ...newRules[index], sellPct: value };
                                                                        return { ...g, marketCapTakeProfit: newRules };
                                                                    }));
                                                                }}
                                                                className="w-full bg-gray-800 border border-gray-700 rounded px-1 py-0.5 text-white text-xs"
                                                                placeholder="%"
                                                            />
                                                        </div>
                                                        <div>
                                                            <label className="text-[8px] text-gray-500 block mb-0.5">At $</label>
                                                            <input
                                                                type="number"
                                                                value={rule.marketCapIncreaseDollar ?? ''}
                                                                onChange={(e) => {
                                                                    const value = e.target.value === '' ? undefined : parseFloat(e.target.value);
                                                                    setWalletGroups(prev => prev.map(g => {
                                                                        if (g.id !== group.id) return g;
                                                                        const rules = g.marketCapTakeProfit ?? [];
                                                                        const newRules = [...rules];
                                                                        if (!newRules[index]) newRules[index] = { marketCapIncreaseDollar: undefined, sellPct: undefined, executed: false };
                                                                        newRules[index] = { ...newRules[index], marketCapIncreaseDollar: value };
                                                                        return { ...g, marketCapTakeProfit: newRules };
                                                                    }));
                                                                }}
                                                                className="w-full bg-gray-800 border border-gray-700 rounded px-1 py-0.5 text-white text-xs"
                                                                placeholder="$"
                                                            />
                                                        </div>
                                                    </div>
                                                    {rule.executed && (
                                                        <div className="text-[8px] text-green-400 mt-1">✓ Executed</div>
                                                    )}
                                                </div>
                                            ))}
                                        </div>
                                        <button
                                            onClick={() => {
                                                setWalletGroups(prev => prev.map(g => {
                                                    if (g.id !== group.id) return g;
                                                    const rules = g.marketCapTakeProfit ?? [];
                                                    return { ...g, marketCapTakeProfit: [...rules, { marketCapIncreaseDollar: undefined, sellPct: undefined, executed: false }] };
                                                }));
                                            }}
                                            className="w-full bg-gray-700 hover:bg-gray-600 text-white text-[10px] font-bold py-1 px-1.5 rounded transition-colors flex items-center justify-center gap-1"
                                        >
                                            <Plus className="w-1.5 h-1.5"/> Add MC TP
                                        </button>
                                    </div>
                                </div>
                            ))}
                        </div>
                    </div>
                )}
            </div>

            {/* Main Control Area */}
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
              
              {/* Left: Strategy & Settings */}
              <div className="lg:col-span-1 space-y-6">
                 
                 {/* Token Input */}
                 <div className="bg-surface border border-gray-700 rounded-xl p-5">
                    <label className="text-xs text-gray-400 uppercase font-bold tracking-wider mb-2 block">Monitored Token Address</label>
                    <div className="flex gap-2">
                        <input
                          type="text"
                          className="w-full bg-background border border-gray-700 rounded-lg px-3 py-2 text-sm focus:border-primary outline-none transition-colors"
                          placeholder="Enter Token Address..."
                          value={monitoredTokenAddress}
                          onChange={(e) => setMonitoredTokenAddress(e.target.value)}
                          onKeyDown={(e) => e.key === 'Enter' && handleTokenFetch()}
                        />
                        <button onClick={handleTokenFetch} className="bg-gray-700 hover:bg-gray-600 p-2 rounded-lg text-white transition-colors">
                           <ArrowRight className="w-5 h-5"/>
                        </button>
                    </div>
                    
{/* Bot wallet secret key (encrypted at rest on server) */}
<div className="mt-4">
  <label className="text-xs text-gray-400 uppercase font-bold tracking-wider mb-2 block">Bot Wallet Secret Key (optional)</label>
  <input
    type="password"
    className="w-full bg-background border border-gray-700 rounded-lg px-3 py-2 text-sm focus:border-primary outline-none transition-colors"
    placeholder="Paste once to set/update (stored encrypted)"
    value={botSecretKeyInput}
    onChange={(e) => setBotSecretKeyInput(e.target.value)}
  />
  <div className="text-[11px] text-gray-500 mt-1">
    Leave blank to keep existing. Recommended format: base58 secret key or JSON array.
  </div>
</div>


{/* Token Metadata Display */}
                    {marketData.tokenName && (
                        <div className="mt-3 bg-black/20 rounded-lg p-2 flex justify-between items-center animate-in fade-in">
                            <div>
                                <p className="text-xs text-gray-400">Token Found</p>
                                <p className="text-sm font-bold text-white">{marketData.tokenName} <span className="text-primary">{marketData.tokenTicker}</span></p>
                            </div>
                            <div className="bg-primary/10 text-primary px-2 py-1 rounded text-[10px] border border-primary/20">Valid</div>
                        </div>
                    )}
                 </div>

                 {/* Strategy Console */}
                 <div className="bg-surface border border-gray-700 rounded-xl p-5">
                    <div className="flex justify-between items-center mb-4">
                        <h3 className="text-lg font-bold flex items-center gap-2"><Settings className="w-5 h-5"/> Strategy Console</h3>
                        <button onClick={saveStrategyChanges} className="text-primary hover:text-emerald-400"><Save/></button>
                    </div>
                    
                    <div className="mb-4">
                        <label className="text-xs text-gray-400 block mb-1">Select Preset</label>
                        <div className="flex gap-2">
                            <select 
                                value={selectedStrategyId} 
                                onChange={(e) => handleStrategyChange(e.target.value)}
                                className="flex-1 bg-background border border-gray-700 rounded-lg px-3 py-2 text-sm outline-none text-white"
                            >
                                {strategies.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                            </select>
                            <button onClick={createNewStrategy} className="bg-gray-700 px-3 rounded-lg hover:bg-gray-600"><Plus/></button>
                        </div>
                    </div>

                    <div className="bg-background border border-gray-700 rounded-lg p-4">
                      <div className="text-xs text-gray-400 uppercase font-bold tracking-wider mb-3">Intruder Trigger Actions</div>
                      <div className="space-y-3">
                        <div className="flex items-center gap-2">
                          <input
                            type="checkbox"
                            checked={config.strategy.intruderActions?.some(a => a.type === 'ALERT') ?? true}
                            onChange={(e) => {
                              const actions = config.strategy.intruderActions ?? [];
                              if (e.target.checked) {
                                if (!actions.some(a => a.type === 'ALERT')) {
                                  setConfig(c => ({...c, strategy: {...c.strategy, intruderActions: [...actions, {type: 'ALERT'}]}}));
                                }
                              } else {
                                setConfig(c => ({...c, strategy: {...c.strategy, intruderActions: actions.filter(a => a.type !== 'ALERT')}}));
                              }
                            }}
                            className="w-4 h-4"
                          />
                          <label className="text-sm">Alert (Log notification)</label>
                        </div>
                        <div className="flex items-center gap-2">
                          <input
                            type="checkbox"
                            checked={config.strategy.intruderActions?.some(a => a.type === 'PAUSE') ?? false}
                            onChange={(e) => {
                              const actions = config.strategy.intruderActions ?? [];
                              if (e.target.checked) {
                                if (!actions.some(a => a.type === 'PAUSE')) {
                                  setConfig(c => ({...c, strategy: {...c.strategy, intruderActions: [...actions, {type: 'PAUSE'}]}}));
                                }
                              } else {
                                setConfig(c => ({...c, strategy: {...c.strategy, intruderActions: actions.filter(a => a.type !== 'PAUSE')}}));
                              }
                            }}
                            className="w-4 h-4"
                          />
                          <label className="text-sm">Pause System</label>
                        </div>
                        <div className="flex items-center gap-2">
                          <input
                            type="checkbox"
                            checked={config.strategy.intruderActions?.some(a => a.type === 'SELL_GROUP_PERCENT') ?? false}
                            onChange={(e) => {
                              const actions = config.strategy.intruderActions ?? [];
                              const sellAction = actions.find(a => a.type === 'SELL_GROUP_PERCENT');
                              if (e.target.checked) {
                                if (!sellAction) {
                                  setConfig(c => ({...c, strategy: {...c.strategy, intruderActions: [...actions, {type: 'SELL_GROUP_PERCENT', percentage: config.strategy.groupSellPctMin}]}}));
                                }
                              } else {
                                setConfig(c => ({...c, strategy: {...c.strategy, intruderActions: actions.filter(a => a.type !== 'SELL_GROUP_PERCENT')}}));
                              }
                            }}
                            className="w-4 h-4"
                          />
                          <label className="text-sm">Sell Group Percentage</label>
                          {config.strategy.intruderActions?.some(a => a.type === 'SELL_GROUP_PERCENT') && (
                            <input
                              type="number"
                              min="0"
                              max="100"
                              value={(config.strategy.intruderActions.find(a => a.type === 'SELL_GROUP_PERCENT') as any)?.percentage ?? config.strategy.groupSellPctMin}
                              onChange={(e) => {
                                const actions = config.strategy.intruderActions ?? [];
                                const sellAction = actions.find(a => a.type === 'SELL_GROUP_PERCENT');
                                if (sellAction) {
                                  setConfig(c => ({
                                    ...c,
                                    strategy: {
                                      ...c.strategy,
                                      intruderActions: actions.map(a => a.type === 'SELL_GROUP_PERCENT' ? {type: 'SELL_GROUP_PERCENT', percentage: parseFloat(e.target.value)} : a)
                                    }
                                  }));
                                }
                              }}
                              className="w-20 bg-background border border-gray-600 rounded px-2 py-1 text-xs text-white ml-2"
                              placeholder="%"
                            />
                          )}
                        </div>
                      </div>
                    </div>

                      <div className="bg-background border border-gray-700 rounded-lg p-3">
                        <div className="text-xs text-gray-400 uppercase font-bold tracking-wider mb-2">Monitoring Rules (JSON)</div>
                        <textarea
                          className="w-full h-24 bg-transparent outline-none text-white font-mono text-xs"
                          value={JSON.stringify(config.strategy.monitoringRules ?? {takeProfitPct:25, stopLossPct:15, maxHoldSec:3600}, null, 2)}
                          onChange={(e) => {
                            try {
                              const parsed = JSON.parse(e.target.value);
                              setConfig(c => ({...c, strategy: {...c.strategy, monitoringRules: parsed}}));
                            } catch {}
                          }}
                        />
                        <div className="text-[10px] text-gray-500 mt-1">Fields: takeProfitPct, stopLossPct, maxHoldSec</div>
                      </div>

                    <div className="space-y-3 text-sm">

                        <div className="grid grid-cols-2 gap-4">
                            <div>
                                <label className="text-[10px] text-gray-500 block">Initial Buy %</label>
                                <input type="number" value={config.strategy.initialBuySolPct} onChange={(e) => handleConfigChange('initialBuySolPct', parseFloat(e.target.value))} className="w-full bg-background border border-gray-800 rounded px-2 py-1 text-white"/>
                            </div>
                            <div>
                                <label className="text-[10px] text-gray-500 block">Intruder Trigger %</label>
                                <input type="number" value={config.strategy.intruderTriggerPct} onChange={(e) => handleConfigChange('intruderTriggerPct', parseFloat(e.target.value))} className="w-full bg-background border border-gray-800 rounded px-2 py-1 text-white"/>
                            </div>
                        </div>
                        <div className="grid grid-cols-2 gap-4">
                            <div>
                                <label className="text-[10px] text-gray-500 block">Sell Range Min %</label>
                                <input type="number" value={config.strategy.groupSellPctMin} onChange={(e) => handleConfigChange('groupSellPctMin', parseFloat(e.target.value))} className="w-full bg-background border border-gray-800 rounded px-2 py-1 text-white"/>
                            </div>
                            <div>
                                <label className="text-[10px] text-gray-500 block">Sell Range Max %</label>
                                <input type="number" value={config.strategy.groupSellPctMax} onChange={(e) => handleConfigChange('groupSellPctMax', parseFloat(e.target.value))} className="w-full bg-background border border-gray-800 rounded px-2 py-1 text-white"/>
                            </div>
                        </div>
                        
                        {/* Next Cycle / Pause Logic */}
                        <div className="grid grid-cols-2 gap-4">
                             <div>
                                <label className="text-[10px] text-gray-500 block mb-1 font-bold">Wait For Intruders</label>
                                <select 
                                    value={config.strategy.pauseMode || 'FIXED'} 
                                    onChange={(e) => handleConfigChange('pauseMode', e.target.value as PauseMode)}
                                    className="w-full bg-black border border-gray-500 rounded px-2 py-1 text-xs outline-none text-white focus:border-primary font-bold"
                                >
                                    <option value="WAIT_FOR_EXIT" className="bg-gray-900">Yes</option>
                                    <option value="FIXED" className="bg-gray-900">No</option>
                                </select>
                            </div>

                            {(!config.strategy.pauseMode || config.strategy.pauseMode === 'FIXED') ? (
                                <div>
                                    <label className="text-[10px] text-gray-500 block mb-1">Pause Delay (Secs)</label>
                                    <input 
                                        type="number" 
                                        value={config.strategy.cyclePauseTimeSec} 
                                        onChange={(e) => handleConfigChange('cyclePauseTimeSec', parseFloat(e.target.value))} 
                                        className="w-full bg-background border border-gray-800 rounded px-2 py-1 text-xs text-white"
                                        placeholder="Secs"
                                    />
                                </div>
                            ) : (
                                <div className="opacity-50 pointer-events-none">
                                    <label className="text-[10px] text-gray-500 block mb-1">Pause Delay</label>
                                    <div className="w-full bg-gray-800 border border-gray-800 rounded px-2 py-1 text-xs text-gray-500 italic flex items-center justify-center">
                                        Overridden
                                    </div>
                                </div>
                            )}
                        </div>
                         <div className="mt-3">
                                <label className="text-[10px] text-gray-500 block mb-1">Privacy Mode</label>
                                <button 
                                    onClick={() => handleConfigChange('usePrivacyMode', !config.strategy.usePrivacyMode)}
                                    className={`w-full text-left px-2 py-1 rounded text-xs font-bold ${config.strategy.usePrivacyMode ? 'bg-purple-900 text-purple-300' : 'bg-gray-800 text-gray-400'}`}
                                >
                                    {config.strategy.usePrivacyMode ? 'ENABLED' : 'DISABLED'}
                                </button>
                        </div>
                    </div>
                    
                    <div className="mt-6 pt-6 border-t border-gray-700">
                         <label className="text-xs text-gray-400 uppercase font-bold tracking-wider mb-2 block">Target Market Cap (Exit)</label>
                         <div className="flex items-center gap-2 bg-background border border-gray-700 rounded-lg px-3 py-2">
                            <span className="text-gray-500">$</span>
                            <input 
                                type="number" 
                                className="bg-transparent w-full outline-none text-white font-mono"
                                value={config.targetMarketCapSell}
                                onChange={(e) => setConfig(c => ({...c, targetMarketCapSell: parseFloat(e.target.value)}))}
                            />
                         </div>
                    </div>

                    <div className="mt-4">
     <label className="text-xs text-gray-400 uppercase font-bold tracking-wider mb-2 block">Wallets per Cycle (default 5)</label>
     <div className="flex items-center gap-2 bg-background border border-gray-700 rounded-lg px-3 py-2">
        <input 
            type="number" 
            min={1}
            max={50}
            className="bg-transparent w-full outline-none text-white font-mono"
            value={config.walletsPerCycle ?? 5}
            onChange={(e) => setConfig(c => ({...c, walletsPerCycle: Math.max(1, Math.min(50, parseInt(e.target.value || '5')))}))}
        />
     </div>
</div>

<button
 
                        onClick={toggleRunState}
                        className={`w-full mt-6 py-4 rounded-xl font-bold text-lg flex items-center justify-center gap-2 transition-all ${
                            appState === AppState.RUNNING ? 'bg-accent hover:bg-rose-600' : 
                            appState === AppState.RESTARTING ? 'bg-yellow-600' : 'bg-primary hover:bg-emerald-600'
                        }`}
                    >
                        {appState === AppState.RUNNING ? <><Pause className="fill-current"/> STOP BOT</> : 
                         appState === AppState.RESTARTING ? <><RefreshCw className="animate-spin"/> {config.strategy.pauseMode === 'WAIT_FOR_EXIT' ? "WAITING FOR EXIT" : "PAUSED"}</> : 
                         <><Play className="fill-current"/> START BOT</>}
                    </button>
                 </div>

                 {/* Privacy Status */}
                 <div className="bg-surface border border-gray-700 rounded-xl p-5">
                    <h3 className="text-sm font-bold flex items-center gap-2 mb-3 text-purple-400"><Ghost/> Privacy Shield</h3>
                    <div className="grid grid-cols-2 gap-2 text-center">
                        <div className="bg-background rounded p-2">
                            <p className="text-[10px] text-gray-500">Shadow Pool (SOL)</p>
                            <p className="text-sm font-mono">{privacyState.shadowPoolBalanceSol.toFixed(2)}</p>
                        </div>
                         <div className="bg-background rounded p-2">
                            <p className="text-[10px] text-gray-500">In Queue</p>
                            <p className="text-sm font-mono">{privacyState.queue.length} txs</p>
                        </div>
                    </div>
                 </div>

              </div>

              {/* Center: Chart & Groups */}
              <div className="lg:col-span-2 space-y-6">
                 {/* Live Trading Chart */}
                 <div className="bg-surface border border-gray-700 rounded-xl p-4">
                    <div className="flex justify-between items-center mb-4">
                        <h3 className="font-bold flex items-center gap-2">
                            <Activity className="text-primary w-5 h-5"/> Live Trading Chart
                            {marketData.tokenName && (
                                <span className="text-sm text-gray-400 font-normal">
                                    {marketData.tokenName} ({marketData.tokenTicker})
                                </span>
                            )}
                        </h3>
                        <div className="flex gap-4 text-xs">
                            <div className="flex items-center gap-2">
                                <div className="w-3 h-3 rounded-full bg-green-500"></div>
                                <span className="text-gray-400">Buy</span>
                                <span className="text-white font-bold">{tradingChartData.reduce((sum, d) => sum + (d.buyCount || 0), 0)}</span>
                            </div>
                            <div className="flex items-center gap-2">
                                <div className="w-3 h-3 rounded-full bg-red-500"></div>
                                <span className="text-gray-400">Sell</span>
                                <span className="text-white font-bold">{tradingChartData.reduce((sum, d) => sum + (d.sellCount || 0), 0)}</span>
                            </div>
                        </div>
                    </div>
                    <div className="h-[300px]">
                        <ResponsiveContainer width="100%" height="100%">
                            <ComposedChart data={tradingChartData.length > 0 ? tradingChartData : chartData}>
                                <defs>
                                    <linearGradient id="colorPrice" x1="0" y1="0" x2="0" y2="1">
                                        <stop offset="5%" stopColor="#10b981" stopOpacity={0.3}/>
                                        <stop offset="95%" stopColor="#10b981" stopOpacity={0}/>
                                    </linearGradient>
                                    <linearGradient id="colorBuy" x1="0" y1="0" x2="0" y2="1">
                                        <stop offset="5%" stopColor="#10b981" stopOpacity={0.8}/>
                                        <stop offset="95%" stopColor="#10b981" stopOpacity={0}/>
                                    </linearGradient>
                                    <linearGradient id="colorSell" x1="0" y1="0" x2="0" y2="1">
                                        <stop offset="5%" stopColor="#ef4444" stopOpacity={0.8}/>
                                        <stop offset="95%" stopColor="#ef4444" stopOpacity={0}/>
                                    </linearGradient>
                                </defs>
                                <CartesianGrid strokeDasharray="3 3" stroke="#334155" vertical={false} />
                                <XAxis 
                                    dataKey="time" 
                                    stroke="#64748b" 
                                    tick={{fontSize: 10}} 
                                    tickLine={false} 
                                    axisLine={false}
                                    interval="preserveStartEnd"
                                />
                                <YAxis 
                                    yAxisId="left"
                                    stroke="#64748b" 
                                    tick={{fontSize: 10}} 
                                    tickLine={false} 
                                    axisLine={false} 
                                    domain={['auto', 'auto']}
                                    label={{ value: 'Price ($)', angle: -90, position: 'insideLeft', style: { textAnchor: 'middle', fill: '#94a3b8' } }}
                                />
                                <YAxis 
                                    yAxisId="right"
                                    orientation="right"
                                    stroke="#64748b" 
                                    tick={{fontSize: 10}} 
                                    tickLine={false} 
                                    axisLine={false} 
                                    domain={[0, 'auto']}
                                    label={{ value: 'Volume (SOL)', angle: 90, position: 'insideRight', style: { textAnchor: 'middle', fill: '#94a3b8' } }}
                                />
                                <Tooltip 
                                    contentStyle={{backgroundColor: '#1e293b', border: '1px solid #334155', borderRadius: '8px'}}
                                    itemStyle={{color: '#f8fafc'}}
                                    formatter={(value: any, name: string) => {
                                        if (name === 'price') return [`$${Number(value).toFixed(6)}`, 'Price'];
                                        if (name === 'marketCap') return [`$${Number(value).toLocaleString()}`, 'Market Cap'];
                                        if (name === 'buyVolume') return [`${Number(value).toFixed(4)} SOL`, 'Buy Volume'];
                                        if (name === 'sellVolume') return [`${Number(value).toFixed(4)} SOL`, 'Sell Volume'];
                                        return [value, name];
                                    }}
                                />
                                <Legend 
                                    wrapperStyle={{ paddingTop: '10px' }}
                                    iconType="line"
                                />
                                {/* Price Line */}
                                <Line 
                                    yAxisId="left"
                                    type="monotone" 
                                    dataKey="price" 
                                    stroke="#10b981" 
                                    strokeWidth={2}
                                    dot={false}
                                    name="Price"
                                    isAnimationActive={false}
                                />
                                {/* Market Cap Area */}
                                <Area 
                                    yAxisId="left"
                                    type="monotone" 
                                    dataKey="marketCap" 
                                    stroke="#6366f1" 
                                    strokeWidth={1}
                                    fillOpacity={0.2}
                                    fill="#6366f1"
                                    name="Market Cap"
                                    isAnimationActive={false}
                                />
                                {/* Buy Volume Bars */}
                                <Bar 
                                    yAxisId="right"
                                    dataKey="buyVolume" 
                                    fill="#10b981" 
                                    opacity={0.6}
                                    name="Buy Volume"
                                    radius={[2, 2, 0, 0]}
                                />
                                {/* Sell Volume Bars */}
                                <Bar 
                                    yAxisId="right"
                                    dataKey="sellVolume" 
                                    fill="#ef4444" 
                                    opacity={0.6}
                                    name="Sell Volume"
                                    radius={[2, 2, 0, 0]}
                                />
                                {/* Bonding Curve Reference Line at $69k */}
                                <ReferenceLine 
                                    yAxisId="left"
                                    y={BONDING_CURVE_LIMIT} 
                                    stroke="#6366f1" 
                                    strokeDasharray="3 3" 
                                    label={{ position: 'insideTopRight', value: 'Bonding Curve Limit', fill: '#6366f1', fontSize: 10 }} 
                                />
                            </ComposedChart>
                        </ResponsiveContainer>
                    </div>
                    {tradingChartData.length === 0 && (
                        <div className="text-center text-gray-500 text-sm mt-4">
                            Waiting for trading activity... Chart will update in real-time when buys/sells occur.
                        </div>
                    )}
                 </div>

                 {/* Active Cycle Groups */}
                 <div className="bg-surface border border-gray-700 rounded-xl overflow-hidden">
                    <div className="p-4 bg-gray-800/50 border-b border-gray-700 flex justify-between items-center">
                        <h3 className="font-bold flex items-center gap-2"><Users className="w-4 h-4"/> Active Cycle Groups</h3>
                        <div className="flex gap-2">
                            <button onClick={() => document.getElementById('csvInput')?.click()} className="text-xs bg-gray-700 hover:bg-gray-600 px-3 py-1 rounded flex items-center gap-1 text-gray-200">
                                <Upload className="w-3 h-3"/> Import CSV
                            </button>
                            <input id="csvInput" type="file" accept=".csv" className="hidden" ref={fileInputRef} onChange={async (e) => {
                                if (e.target.files?.[0]) {
                                    const reader = new FileReader();
                                    reader.onload = async (ev) => {
                                        const text = ev.target?.result as string;
                                        try {
                                            // Get active group ID if exists
                                            const activeGroup = walletGroups.find(g => g.isActive);
                                            const groupId = activeGroup?.id;
                                            
                                            const res = await authFetch('/api/ultibot/wallets/import', {
                                                method: 'POST',
                                                body: JSON.stringify({
                                                    csv: text,
                                                    groupId: groupId,
                                                }),
                                            });
                                            
                                            if (res.ok) {
                                                const data = await res.json();
                                                addLog(`✅ Imported ${data.imported} wallets from CSV${groupId ? ` to group ${groupId.substring(0, 8)}...` : ''}`);
                                                fetchWalletGroups();
                                            } else {
                                                const error = await res.text();
                                                addLog(`❌ CSV import failed: ${error}`);
                                            }
                                        } catch (err: any) {
                                            addLog(`❌ Error importing CSV: ${String(err?.message || err)}`);
                                        }
                                    };
                                    reader.readAsText(e.target.files[0]);
                                }
                            }} />
                        </div>
                    </div>
                    <div className="max-h-[300px] overflow-y-auto">
                        {walletGroups.length === 0 ? (
                            <div className="p-8 text-center text-gray-500 text-sm">No active wallet groups. Start the bot to generate one.</div>
                        ) : (
                            walletGroups.map(group => (
                                <div key={group.id} className={`border-b border-gray-800 p-4 ${!group.isActive ? 'opacity-50 grayscale' : ''}`}>
                                    <div className="flex justify-between items-center mb-3">
                                        <div>
                                            <h4 className="font-bold text-sm text-white">{group.name}</h4>
                                            <p className="text-[10px] text-gray-400">Phase: {group.phase}</p>
                                        </div>
                                        <span className={`text-[10px] px-2 py-1 rounded ${group.isActive ? 'bg-green-900 text-green-300' : 'bg-gray-700 text-gray-400'}`}>
                                            {group.isActive ? 'ACTIVE' : 'ARCHIVED'}
                                        </span>
                                    </div>
                                    <div className="space-y-2">
                                        {group.wallets.map(wallet => (
                                            <div key={wallet.id} className="flex items-center justify-between bg-background rounded p-2 text-xs">
                                                <div className="flex items-center gap-3">
                                                    <div className={`w-2 h-2 rounded-full ${wallet.status === 'ACTIVE' ? 'bg-green-500' : 'bg-red-500'}`}></div>
                                                    <span className="font-mono text-gray-300">{wallet.label}</span>
                                                </div>
                                                <div className="flex gap-4 text-right">
                                                    <span className="text-gray-400">{wallet.balanceSol.toFixed(2)} SOL</span>
                                                    <span className="text-primary font-bold">{wallet.balanceTokens.toFixed(0)} TOKENS</span>
                                                </div>
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            ))
                        )}
                    </div>
                </div>

                 {/* Logs */}
                  <div className="bg-black/40 border border-gray-800 rounded-xl p-4 h-40 overflow-y-auto font-mono text-[10px] text-green-400/80">
                    {logs.map((log, i) => <div key={i}>{log}</div>)}
                 </div>
              </div>
            </div>
          </div>
        )}

        {/* --- ANONPAY TAB --- */}
        {activeTab === 'ANONPAY' && (
            <div className="max-w-4xl mx-auto space-y-6">
                
                {/* Header */}
                <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
                    <div>
                        <h2 className="text-2xl font-bold text-white flex items-center gap-2">AnonPay Batch Sender <span className={`text-xs px-2 py-0.5 rounded border ${anonPayPrivacyEnabled ? 'bg-purple-900 text-purple-200 border-purple-700' : 'bg-gray-700 text-gray-300 border-gray-600'}`}>{anonPayPrivacyEnabled ? 'Privacy Active' : 'Standard Mode'}</span></h2>
                        <p className="text-gray-400 text-sm mt-1">Anonymous bulk transfers via Shadow Pool mixing.</p>
                    </div>
                    {/* Connect Button - Top Right */}
                    <div>
                        {!userWalletConnected ? (
                            <button onClick={handleConnectWalletClick} className="bg-primary hover:bg-emerald-600 text-white px-5 py-2.5 rounded-lg font-bold flex items-center gap-2 transition-all shadow-lg shadow-primary/20 w-full md:w-auto">
                                <WalletIcon className="w-5 h-5"/> Connect Wallet to Begin Transfers
                            </button>
                        ) : (
                            <div className="flex items-center gap-3">
                                <div className="bg-surface border border-gray-700 px-4 py-2 rounded-lg text-right">
                                    <p className="text-[10px] text-gray-400 uppercase font-bold">Connected ({connectedProvider})</p>
                                    <div className="flex gap-3 text-sm font-bold">
                                        <span className="text-white">{userWalletBalance.toFixed(3)} SOL</span>
                                    </div>
                                </div>
                                <button onClick={handleWalletDisconnect} className="bg-gray-800 p-2 rounded-lg hover:bg-red-900/50 text-gray-400 hover:text-red-400 transition-colors" title="Disconnect Wallet">
                                    <X className="w-5 h-5" />
                                </button>
                            </div>
                        )}
                    </div>
                </div>
                
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                    
                    {/* Left: Source Configuration */}
                    <div className="space-y-6">
                        {/* Asset Selector */}
                         <div className="bg-surface border border-gray-700 rounded-xl p-6">
                            <h3 className="font-bold mb-4 flex items-center gap-2"><Layers className="text-primary"/> Asset Selection</h3>
                            
                            <label className="text-xs text-gray-500 block mb-2">Select Token to Send</label>
                            <div className="bg-background border border-gray-700 rounded-lg p-1">
                                <select 
                                    value={anonPaySelectedAssetMint} 
                                    onChange={(e) => setAnonPaySelectedAssetMint(e.target.value)}
                                    className="w-full bg-transparent text-white text-sm font-bold outline-none p-2"
                                    disabled={!userWalletConnected}
                                >
                                    <option value="SOL">SOL (Balance: {userWalletBalance.toFixed(4)})</option>
                                    {userTokens.map(token => (
                                        <option key={token.mint} value={token.mint}>
                                            {token.symbol} ({token.balance.toLocaleString()})
                                        </option>
                                    ))}
                                </select>
                            </div>
                            <p className="text-[10px] text-gray-500 mt-2">
                                {userTokens.length === 0 && userWalletConnected ? "No SPL tokens found." : 
                                 !userWalletConnected ? "Connect wallet to view assets." : ""}
                            </p>
                        </div>

                        {/* Settings */}
                         <div className="bg-surface border border-gray-700 rounded-xl p-6 border-l-4 border-l-primary">
                             <h3 className="font-bold mb-4 flex items-center gap-2"><Settings className="text-gray-400"/> Batch Settings</h3>
                             <div className="space-y-4">
                                 <div>
                                     <label className="text-xs text-gray-500 block mb-1">Calculation Mode</label>
                                     <div className="flex p-1 bg-gray-900 rounded-lg">
                                         <button onClick={() => setAnonPayAmountMode('FIXED')} className={`flex-1 py-1.5 text-xs font-bold rounded transition-colors ${anonPayAmountMode === 'FIXED' ? 'bg-gray-700 text-white' : 'text-gray-500 hover:text-gray-300'}`}>Fixed / Range</button>
                                         <button onClick={() => setAnonPayAmountMode('PERCENTAGE')} className={`flex-1 py-1.5 text-xs font-bold rounded transition-colors ${anonPayAmountMode === 'PERCENTAGE' ? 'bg-gray-700 text-white' : 'text-gray-500 hover:text-gray-300'}`}>% of Balance</button>
                                     </div>
                                 </div>

                                 {/* Explicit Range Inputs */}
                                 <div className="p-3 bg-black/20 rounded-lg border border-primary/50 shadow-inner">
                                     <label className="text-[10px] text-primary uppercase font-bold mb-2 block">
                                         {anonPayAmountMode === 'FIXED' ? 'Amount Per Wallet (Range)' : 'Percentage Range (Per Wallet)'}
                                     </label>
                                     <div className="grid grid-cols-2 gap-4">
                                        {anonPayAmountMode === 'FIXED' ? (
                                            <>
                                                <div>
                                                    <label className="text-xs text-gray-500 block mb-1">Min Amount</label>
                                                    <div className="flex items-center gap-1 bg-background border border-gray-700 rounded px-2 py-1.5 focus-within:border-primary">
                                                        <input type="number" value={anonPayMinAmount} onChange={(e) => setAnonPayMinAmount(parseFloat(e.target.value))} className="bg-transparent w-full outline-none text-white text-sm" />
                                                        <span className="text-[10px] text-gray-500">{anonPaySelectedAssetMint === 'SOL' ? 'SOL' : 'TOK'}</span>
                                                    </div>
                                                </div>
                                                <div>
                                                    <label className="text-xs text-gray-500 block mb-1">Max Amount</label>
                                                    <div className="flex items-center gap-1 bg-background border border-gray-700 rounded px-2 py-1.5 focus-within:border-primary">
                                                        <input type="number" value={anonPayMaxAmount} onChange={(e) => setAnonPayMaxAmount(parseFloat(e.target.value))} className="bg-transparent w-full outline-none text-white text-sm" />
                                                        <span className="text-[10px] text-gray-500">{anonPaySelectedAssetMint === 'SOL' ? 'SOL' : 'TOK'}</span>
                                                    </div>
                                                </div>
                                            </>
                                        ) : (
                                            <>
                                                <div>
                                                    <label className="text-xs text-gray-500 block mb-1">Min %</label>
                                                    <div className="relative">
                                                        <input type="number" value={anonPayMinPct} onChange={(e) => setAnonPayMinPct(parseFloat(e.target.value))} className="bg-background w-full border border-gray-700 rounded p-1.5 text-white text-sm focus:border-primary" />
                                                        <span className="absolute right-2 top-2 text-xs text-gray-500">%</span>
                                                    </div>
                                                </div>
                                                <div>
                                                    <label className="text-xs text-gray-500 block mb-1">Max %</label>
                                                    <div className="relative">
                                                        <input type="number" value={anonPayMaxPct} onChange={(e) => setAnonPayMaxPct(parseFloat(e.target.value))} className="bg-background w-full border border-gray-700 rounded p-1.5 text-white text-sm focus:border-primary" />
                                                        <span className="absolute right-2 top-2 text-xs text-gray-500">%</span>
                                                    </div>
                                                </div>
                                            </>
                                        )}
                                     </div>
                                     <p className="text-[10px] text-gray-500 mt-2 italic text-center">
                                         {anonPayAmountMode === 'FIXED' && anonPayMinAmount === anonPayMaxAmount 
                                            ? "Fixed amount will be sent to all wallets." 
                                            : "Random amount between Min and Max for each wallet."}
                                     </p>
                                 </div>
                                 

                                 <div>
                                    <label className="text-xs text-gray-500 block mb-1">Privacy Shield Mode</label>
                                    <button 
                                        onClick={() => setAnonPayPrivacyEnabled(!anonPayPrivacyEnabled)}
                                        className={`w-full flex items-center justify-between px-3 py-2 rounded-lg transition-all border ${anonPayPrivacyEnabled ? 'bg-purple-900/50 border-purple-500/50' : 'bg-gray-800 border-gray-700'}`}
                                    >
                                        <div className="flex items-center gap-2">
                                            {anonPayPrivacyEnabled ? <Ghost className="w-4 h-4 text-purple-400"/> : <EyeOff className="w-4 h-4 text-gray-400"/>}
                                            <span className={`text-sm font-bold ${anonPayPrivacyEnabled ? 'text-purple-200' : 'text-gray-400'}`}>
                                                {anonPayPrivacyEnabled ? 'Privacy Shield Enabled' : 'Direct Transfer Mode'}
                                            </span>
                                        </div>
                                        <div className={`w-8 h-4 rounded-full relative transition-colors ${anonPayPrivacyEnabled ? 'bg-purple-500' : 'bg-gray-600'}`}>
                                            <div className={`absolute top-0.5 w-3 h-3 bg-white rounded-full transition-transform ${anonPayPrivacyEnabled ? 'left-4.5' : 'left-0.5'}`}></div>
                                        </div>
                                    </button>
                                 </div>
                             </div>
                         </div>
                    </div>

                    {/* Right: Recipients & Payment */}
                    <div className="space-y-6">
                         <div className="bg-surface border border-gray-700 rounded-xl p-6 h-[400px] flex flex-col">
                             <div className="flex justify-between items-center mb-4">
                                 <h3 className="font-bold flex items-center gap-2"><Users className="text-gray-400"/> Recipients <span className="bg-gray-800 text-xs px-2 py-0.5 rounded-full">{anonPayRecipients.length}</span></h3>
                                 <div className="flex gap-2">
                                     <button onClick={() => setAnonPayRecipients([])} className="text-xs text-red-400 hover:text-red-300">Clear</button>
                                     <label className="cursor-pointer bg-gray-800 hover:bg-gray-700 text-white px-3 py-1 rounded text-xs flex items-center gap-1 transition-colors">
                                         <Upload className="w-3 h-3"/> Upload CSV
                                         <input type="file" accept=".csv" onChange={handleAnonPayCSVUpload} className="hidden"/>
                                     </label>
                                 </div>
                             </div>
                             
                             {/* Recipient Input Area */}
                             <textarea 
                                className="w-full h-24 bg-background border border-gray-700 rounded-lg p-3 text-xs font-mono text-gray-300 outline-none resize-none mb-3 focus:border-primary transition-colors"
                                placeholder={`Paste addresses here (one per line)...\nAmounts will be randomized between Min/Max unless specified.`}
                                value={anonPayRecipientInput}
                                onChange={(e) => setAnonPayRecipientInput(e.target.value)}
                                onBlur={addManualRecipients}
                             />

                             {/* List */}
                             <div className="flex-1 overflow-y-auto space-y-2 pr-2 custom-scrollbar">
                                 {anonPayRecipients.map((r, idx) => (
                                     <div key={r.id} className="flex items-center justify-between bg-background/50 p-2 rounded text-xs border border-gray-800">
                                         <div className="flex items-center gap-2">
                                             <span className="text-gray-500 w-4">{idx + 1}.</span>
                                             <span className="font-mono text-gray-300">{r.address.substring(0, 12)}...</span>
                                         </div>
                                         <div className="flex items-center gap-3">
                                             <span className="font-bold">{r.amount.toFixed(4)} {anonPaySelectedAssetMint === 'SOL' ? 'SOL' : 'TOK'}</span>
                                             {r.status === 'COMPLETED' ? <CheckCircle className="w-3 h-3 text-green-500"/> : 
                                              r.status === 'QUEUED' ? <RefreshCw className="w-3 h-3 text-yellow-500 animate-spin"/> : 
                                              <div className="w-2 h-2 bg-gray-600 rounded-full"></div>}
                                         </div>
                                     </div>
                                 ))}
                                 {anonPayRecipients.length === 0 && (
                                     <div className="text-center text-gray-600 text-sm py-8">List is empty. Add recipients to begin.</div>
                                 )}
                             </div>
                         </div>
                    </div>
                </div>

                {/* Payment Footer */}
                <div className="bg-gray-900 border-t border-gray-700 fixed bottom-0 left-0 right-0 p-4 z-30">
                    <div className="max-w-4xl mx-auto flex items-center justify-between">
                         <div className="flex gap-8 text-sm">
                             <div>
                                 <p className="text-gray-500 text-xs uppercase font-bold">Total Transfer</p>
                                 <p className="text-white font-bold text-lg">{anonPayRecipients.reduce((a,b) => a + b.amount, 0).toFixed(4)} <span className="text-sm text-gray-400">{anonPaySelectedAssetMint === 'SOL' ? 'SOL' : 'TOK'}</span></p>
                             </div>
                             <div>
                                 <p className="text-gray-500 text-xs uppercase font-bold">Service Fees ({ANON_PAY_FEE_PER_TX} SOL/tx)</p>
                                 <p className="text-white font-bold text-lg">{(anonPayRecipients.length * ANON_PAY_FEE_PER_TX).toFixed(4)} <span className="text-sm text-gray-400">SOL</span></p>
                             </div>
                         </div>
                         <button 
                            onClick={executeAnonPayBatch}
                            disabled={!userWalletConnected || anonPayRecipients.length === 0}
                            className={`px-8 py-3 rounded-xl font-bold text-white flex items-center gap-2 transition-all ${!userWalletConnected || anonPayRecipients.length === 0 ? 'bg-gray-700 cursor-not-allowed' : 'bg-primary hover:bg-emerald-600 hover:shadow-lg shadow-primary/20'}`}
                         >
                             <CreditCard className="w-5 h-5"/> Pay & Execute Batch
                         </button>
                    </div>
                </div>

            </div>
        )}

        {/* --- ULTICLEANER TAB --- */}
        {activeTab === 'ULTICLEANER' && (
            <div className="max-w-4xl mx-auto space-y-6">
                
                {/* Documentation Module */}
                <InfoPanel title="User Guide: Ulti Cleaner">
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                        <div>
                            <h4 className="font-bold text-white mb-2">Workflow</h4>
                            <ol className="list-decimal list-inside space-y-1 text-gray-400">
                                <li><strong>Connect:</strong> Link your source wallet containing SPL tokens.</li>
                                <li><strong>Configure:</strong> Enter the SPL Token Mint address.</li>
                                <li><strong>Destinations:</strong> Add wallets where you want the final SOL to arrive.</li>
                                <li><strong>Execute:</strong> "Start Cleaning" triggers the automated sequence.</li>
                            </ol>
                        </div>
                        <div>
                            <h4 className="font-bold text-white mb-2">Automated Stages</h4>
                            <ul className="list-disc list-inside space-y-1 text-gray-400">
                                <li><strong>Distribute:</strong> Tokens sent to 20 temporary "Mixer" wallets.</li>
                                <li><strong>Liquidate:</strong> Mixers sell tokens on DEX for SOL.</li>
                                <li><strong>Consolidate:</strong> SOL is forwarded to your Destination wallets.</li>
                                <li><strong>Re-Buy (Optional):</strong> If private keys provided, destinations buy back the token.</li>
                            </ul>
                        </div>
                    </div>
                </InfoPanel>

                <div className="flex items-center justify-between">
                    <div>
                        <h2 className="text-2xl font-bold flex items-center gap-2 text-accent"><Sparkles className="w-6 h-6"/> Ulti Cleaner <span className="text-xs bg-accent/20 text-accent px-2 py-0.5 rounded border border-accent/30">ADMIN TOOL</span></h2>
                        <p className="text-gray-400 text-sm mt-1">Automated high-volume wash & consolidation flow.</p>
                    </div>
                    <div>
                        {!userWalletConnected ? (
                            <button onClick={handleConnectWalletClick} className="bg-accent hover:bg-rose-600 text-white px-5 py-2.5 rounded-lg font-bold flex items-center gap-2 transition-all">
                                <WalletIcon className="w-5 h-5"/> Connect Source Wallet
                            </button>
                        ) : (
                            <div className="flex items-center gap-3">
                                <div className="bg-surface border border-gray-700 px-4 py-2 rounded-lg text-right">
                                    <p className="text-[10px] text-gray-400 uppercase font-bold">Source</p>
                                    <p className="text-sm font-bold text-white">{userWalletBalance.toFixed(2)} SOL</p>
                                </div>
                                <button onClick={handleWalletDisconnect} className="bg-gray-800 p-2 rounded-lg hover:bg-red-900/50 text-gray-400 hover:text-red-400 transition-colors">
                                    <X className="w-5 h-5" />
                                </button>
                            </div>
                        )}
                    </div>
                </div>

                <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                    {/* Left Panel: Config */}
                    <div className="space-y-6">
                        <div className="bg-surface border border-gray-700 rounded-xl p-5">
                            <h3 className="font-bold mb-4 flex items-center gap-2"><Layers className="text-accent"/> Token Config</h3>
                            <div className="space-y-3">
                                <div>
                                    <label className="text-xs text-gray-500 block mb-1">Token Mint Address</label>
                                    <input type="text" value={cleanerTokenMint} onChange={(e) => setCleanerTokenMint(e.target.value)} className="w-full bg-background border border-gray-700 rounded-lg px-3 py-2 text-sm outline-none focus:border-accent" placeholder="Enter Mint..." />
                                </div>
                            </div>
                        </div>

                        <div className="bg-surface border border-gray-700 rounded-xl p-5">
                             <h3 className="font-bold mb-4 flex items-center gap-2"><Settings className="text-accent"/> Sequence</h3>
                             <div className="space-y-4 text-sm">
                                 <div className={`flex items-center gap-3 p-2 rounded ${cleanerStage === 'DISTRIBUTING' ? 'bg-accent/20 text-white' : 'text-gray-500'}`}>
                                     <div className="w-6 h-6 rounded-full bg-gray-800 flex items-center justify-center border border-gray-700 text-xs">1</div>
                                     <p>Distribute to 20 Mixers</p>
                                 </div>
                                 <div className={`flex items-center gap-3 p-2 rounded ${cleanerStage === 'SELLING' ? 'bg-accent/20 text-white' : 'text-gray-500'}`}>
                                     <div className="w-6 h-6 rounded-full bg-gray-800 flex items-center justify-center border border-gray-700 text-xs">2</div>
                                     <p>Liquidate Tokens (Sell)</p>
                                 </div>
                                 <div className={`flex items-center gap-3 p-2 rounded ${cleanerStage === 'CONSOLIDATING' ? 'bg-accent/20 text-white' : 'text-gray-500'}`}>
                                     <div className="w-6 h-6 rounded-full bg-gray-800 flex items-center justify-center border border-gray-700 text-xs">3</div>
                                     <p>Consolidate SOL</p>
                                 </div>
                                 <div className={`flex items-center gap-3 p-2 rounded ${cleanerStage === 'FINAL_BUY' ? 'bg-accent/20 text-white' : 'text-gray-500'}`}>
                                     <div className="w-6 h-6 rounded-full bg-gray-800 flex items-center justify-center border border-gray-700 text-xs">4</div>
                                     <p>Automated Buy (If Keys Present)</p>
                                 </div>
                             </div>
                        </div>
                    </div>

                    {/* Center Panel: Destinations */}
                    <div className="lg:col-span-2 flex flex-col gap-6">
                        <div className="bg-surface border border-gray-700 rounded-xl p-5 flex-1 flex flex-col">
                            <div className="flex justify-between items-center mb-4">
                                <h3 className="font-bold flex items-center gap-2"><Users className="text-accent"/> Destination Wallets</h3>
                                <div className="flex gap-2">
                                    <button onClick={clearCleanerData} className="text-xs text-red-400 hover:text-red-300 flex items-center gap-1"><Trash2 className="w-3 h-3"/> Shred Evidence</button>
                                </div>
                            </div>
                            
                            <textarea 
                                className="w-full h-20 bg-background border border-gray-700 rounded-lg p-3 text-xs font-mono text-gray-300 outline-none resize-none mb-3 focus:border-accent transition-colors"
                                placeholder={`Paste destinations...\nFormat: Address, PrivateKey(Optional)`}
                                value={cleanerInput}
                                onChange={(e) => setCleanerInput(e.target.value)}
                                onBlur={addCleanerDestinations}
                             />

                             <div className="flex-1 bg-black/20 rounded-lg p-2 overflow-y-auto space-y-1 max-h-[200px] custom-scrollbar">
                                 {cleanerDestinations.map((d, i) => (
                                     <div key={d.id} className="flex items-center justify-between text-xs p-2 bg-background/50 rounded border border-gray-800">
                                         <div className="flex gap-2">
                                             <span className="text-gray-500">{i+1}.</span>
                                             <span className="font-mono text-gray-300">{d.address.substring(0, 16)}...</span>
                                             {d.privateKey && <span className="bg-accent/20 text-accent px-1.5 rounded text-[10px]">Key Loaded</span>}
                                         </div>
                                         <span className={`font-bold ${d.status === 'COMPLETE' || d.status === 'BOUGHT' ? 'text-green-400' : 'text-gray-500'}`}>{d.status}</span>
                                     </div>
                                 ))}
                                 {cleanerDestinations.length === 0 && <div className="text-center text-gray-600 py-8">No destinations added.</div>}
                             </div>
                        </div>

                        {/* Logs & Action */}
                        <div className="bg-surface border border-gray-700 rounded-xl p-5">
                             <div className="bg-black rounded-lg h-32 p-3 font-mono text-[10px] text-rose-300/80 overflow-y-auto mb-4">
                                 {cleanerLogs.map((l, i) => <div key={i}>{l}</div>)}
                                 {cleanerLogs.length === 0 && <div className="text-gray-700 italic">Ready to initialize sequence...</div>}
                             </div>
                             
                             <div className="flex justify-between items-center">
                                 <div className="text-xs text-gray-400">
                                     Est. Fee: <span className="text-white font-bold">{(cleanerDestinations.length * ultiCleanerFee).toFixed(4)} SOL</span>
                                 </div>
                                 <button 
                                    onClick={runCleanerSequence}
                                    className={`px-6 py-3 rounded-lg font-bold text-white flex items-center gap-2 transition-all ${!userWalletConnected ? 'bg-gray-700 cursor-not-allowed' : 'bg-accent hover:bg-rose-600 shadow-lg shadow-accent/20'}`}
                                    disabled={!userWalletConnected}
                                >
                                     <Sparkles className="w-4 h-4"/> Start Cleaning
                                 </button>
                             </div>
                        </div>
                    </div>
                </div>
            </div>
        )}


        {/* --- ADMIN TAB --- */}
        {activeTab === 'ADMIN' && (
            <div className="max-w-4xl mx-auto space-y-8">
                <h2 className="text-2xl font-bold mb-6 flex items-center gap-2"><Shield className="text-accent"/> System Administration</h2>
                
                <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                    <StatsCard label="Total Users" value={adminUsers.length.toString()} trend="neutral" icon={<Users/>} />
                    <StatsCard label="System Fees Collected" value="142.50" subValue="SOL" trend="up" icon={<CreditCard/>} />
                    <StatsCard label="Active Nodes" value="12" trend="neutral" icon={<Activity/>} />
                </div>

                {/* Site Fee Management */}
                <div className="bg-surface border border-gray-700 rounded-xl p-6">
                    <h3 className="font-bold mb-4 flex items-center gap-2"><CreditCard className="text-primary"/> Site Fee Management</h3>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <div>
                            <label className="text-xs text-gray-400 block mb-1">AnonPay Fee (%)</label>
                            <input
                                type="number"
                                value={siteFees.anonPayFee * 100}
                                onChange={(e) => setSiteFees({...siteFees, anonPayFee: parseFloat(e.target.value) / 100})}
                                className="w-full bg-background border border-gray-700 rounded-lg px-3 py-2 text-sm"
                                step="0.01"
                                min="0"
                                max="100"
                            />
                            <div className="text-xs text-gray-500 mt-1">{siteFees.anonPayFee * 100}% per transaction</div>
                        </div>
                        <div>
                            <label className="text-xs text-gray-400 block mb-1">Ulti Cleaner Fee (SOL)</label>
                            <input
                                type="number"
                                value={siteFees.cleanerFee}
                                onChange={(e) => setSiteFees({...siteFees, cleanerFee: parseFloat(e.target.value)})}
                                className="w-full bg-background border border-gray-700 rounded-lg px-3 py-2 text-sm"
                                step="0.0001"
                                min="0"
                            />
                            <div className="text-xs text-gray-500 mt-1">{siteFees.cleanerFee} SOL per destination</div>
                        </div>
                        <div>
                            <label className="text-xs text-gray-400 block mb-1">Market Maker Fee (%)</label>
                            <input
                                type="number"
                                value={siteFees.marketMakerFee * 100}
                                onChange={(e) => setSiteFees({...siteFees, marketMakerFee: parseFloat(e.target.value) / 100})}
                                className="w-full bg-background border border-gray-700 rounded-lg px-3 py-2 text-sm"
                                step="0.01"
                                min="0"
                                max="100"
                            />
                            <div className="text-xs text-gray-500 mt-1">{siteFees.marketMakerFee * 100}% per trade</div>
                        </div>
                        <div>
                            <label className="text-xs text-gray-400 block mb-1">Default Fee (%)</label>
                            <input
                                type="number"
                                value={siteFees.defaultFee * 100}
                                onChange={(e) => setSiteFees({...siteFees, defaultFee: parseFloat(e.target.value) / 100})}
                                className="w-full bg-background border border-gray-700 rounded-lg px-3 py-2 text-sm"
                                step="0.01"
                                min="0"
                                max="100"
                            />
                            <div className="text-xs text-gray-500 mt-1">{siteFees.defaultFee * 100}% default rate</div>
                        </div>
                    </div>
                    <button
                        onClick={async () => {
                            try {
                                const res = await fetch('/api/admin/fees', {
                                    method: 'POST',
                                    headers: { 'Content-Type': 'application/json' },
                                    body: JSON.stringify(siteFees),
                                });
                                if (res.ok) {
                                    addLog('✅ Site fees updated successfully');
                                } else {
                                    throw new Error('Failed to update fees');
                                }
                            } catch (e: any) {
                                alert(`Failed to update fees: ${e.message}`);
                            }
                        }}
                        className="mt-4 px-4 py-2 bg-primary text-white rounded-lg hover:bg-emerald-600 font-bold"
                    >
                        Save Fee Settings
                    </button>
                </div>

                {/* Security Settings */}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                    <div className="bg-surface border border-gray-700 rounded-xl p-6">
                        <h3 className="font-bold mb-4 flex items-center gap-2"><Lock className="text-primary"/> User Access</h3>
                        <p className="text-xs text-gray-400 mb-4">Update the password required to access "Ultibot Tools" and "Ulti Cleaner".</p>
                        <div className="flex items-end gap-4">
                            <div className="flex-1">
                                <label className="text-xs text-gray-500 block mb-1">New User Password</label>
                                <input 
                                    type="text" 
                                    placeholder="Enter new password" 
                                    className="w-full bg-background border border-gray-600 rounded px-3 py-2 text-sm outline-none focus:border-primary"
                                    value={newPasswordInput}
                                    onChange={(e) => setNewPasswordInput(e.target.value)}
                                />
                            </div>
                            <button onClick={updateGlobalPassword} className="bg-primary text-white px-4 py-2 rounded-lg font-bold text-sm hover:bg-emerald-600">Update</button>
                        </div>
                    </div>

                    <div className="bg-surface border border-gray-700 rounded-xl p-6">
                        <h3 className="font-bold mb-4 flex items-center gap-2"><Lock className="text-accent"/> Admin Access</h3>
                        <p className="text-xs text-gray-400 mb-4">Update the master password for the Admin Panel.</p>
                        <div className="flex items-end gap-4">
                            <div className="flex-1">
                                <label className="text-xs text-gray-500 block mb-1">New Admin Password</label>
                                <input 
                                    type="text" 
                                    placeholder="Enter new password" 
                                    className="w-full bg-background border border-gray-600 rounded px-3 py-2 text-sm outline-none focus:border-accent"
                                    value={newAdminPasswordInput}
                                    onChange={(e) => setNewAdminPasswordInput(e.target.value)}
                                />
                            </div>
                            <button onClick={updateAdminPassword} className="bg-accent text-white px-4 py-2 rounded-lg font-bold text-sm hover:bg-rose-600">Update</button>
                        </div>
                    </div>
                </div>

                {/* Configuration */}
                <div className="bg-surface border border-gray-700 rounded-xl p-6">
                    <h3 className="font-bold mb-4 flex items-center gap-2"><Settings className="text-gray-400"/> System Configuration</h3>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                        <div>
                            <label className="text-xs text-gray-500 block mb-1">RPC URL (server)</label>
                            <input 
                                type="text" 
                                className="w-full bg-background border border-gray-600 rounded px-3 py-2 text-sm outline-none focus:border-accent"
                                placeholder="https://... (kept on server)"
                                value={rpcUrl}
                                onChange={(e) => setRpcUrl(e.target.value)}
                            />
                            <div className="text-[11px] text-gray-500 mt-1">This is stored on the backend and used for all Solana RPC calls (your key is not exposed in the browser).</div>
                        </div>
                        <div>
                            <label className="text-xs text-gray-500 block mb-1">Ulti Cleaner Fee (SOL)</label>
                            <input 
                                type="number" 
                                className="w-full bg-background border border-gray-600 rounded px-3 py-2 text-sm outline-none focus:border-accent"
                                value={ultiCleanerFee}
                                onChange={(e) => setUltiCleanerFee(parseFloat(e.target.value))}
                            />
                        </div>
                    </div>
                </div>

                <div className="bg-surface border border-gray-700 rounded-xl overflow-hidden">
                    <div className="p-5 border-b border-gray-700 flex justify-between items-center">
                        <h3 className="font-bold">User Management</h3>
                        {currentUserRole === 'OWNER' && (
                            <div className="flex gap-2">
                                <input 
                                    type="email" 
                                    placeholder="New Admin Email" 
                                    className="bg-background border border-gray-600 rounded px-3 py-1 text-sm outline-none"
                                    value={newAdminEmail}
                                    onChange={(e) => setNewAdminEmail(e.target.value)}
                                />
                                <button onClick={handleAddAdmin} className="bg-primary text-white px-3 py-1 rounded text-sm font-bold hover:bg-emerald-600">Add Admin</button>
                            </div>
                        )}
                    </div>
                    <table className="w-full text-left text-sm">
                        <thead className="bg-gray-800 text-gray-400">
                            <tr>
                                <th className="p-4">User ID</th>
                                <th className="p-4">Email</th>
                                <th className="p-4">Role</th>
                                <th className="p-4">Status</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-gray-800">
                            {adminUsers.map(u => (
                                <tr key={u.id} className="hover:bg-gray-800/50">
                                    <td className="p-4 font-mono text-gray-500">{u.id}</td>
                                    <td className="p-4">{u.email}</td>
                                    <td className="p-4"><span className={`px-2 py-1 rounded text-[10px] font-bold ${u.role === 'OWNER' ? 'bg-purple-900 text-purple-300' : 'bg-blue-900 text-blue-300'}`}>{u.role}</span></td>
                                    <td className="p-4 text-green-400">Active</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>

                {/* Profile Management */}
                <div className="bg-surface border border-gray-700 rounded-xl overflow-hidden">
                    <div className="p-5 border-b border-gray-700 flex justify-between items-center">
                        <h3 className="font-bold flex items-center gap-2"><Users className="text-primary"/> Profile Management</h3>
                        <div className="flex gap-2">
                            <input 
                                type="text" 
                                placeholder="Search by wallet or promo code..." 
                                className="bg-background border border-gray-600 rounded px-3 py-1.5 text-sm outline-none focus:border-primary w-64"
                                value={profileSearchTerm}
                                onChange={(e) => setProfileSearchTerm(e.target.value)}
                            />
                            <button onClick={fetchAdminProfiles} className="bg-primary text-white px-4 py-1.5 rounded text-sm font-bold hover:bg-emerald-600 flex items-center gap-2">
                                <RefreshCw className="w-4 h-4"/> Refresh
                            </button>
                        </div>
                    </div>
                    <div className="overflow-x-auto max-h-[600px] overflow-y-auto">
                        <table className="w-full text-left text-sm">
                            <thead className="bg-gray-800 text-gray-400 sticky top-0">
                                <tr>
                                    <th className="p-3">Wallet</th>
                                    <th className="p-3">Promo Code</th>
                                    <th className="p-3">Social</th>
                                    <th className="p-3">Referrals</th>
                                    <th className="p-3">Volume (SOL)</th>
                                    <th className="p-3">Logins</th>
                                    <th className="p-3">Created</th>
                                    <th className="p-3">Actions</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-gray-800">
                                {adminProfiles
                                  .filter(p => 
                                    !profileSearchTerm || 
                                    p.wallet?.toLowerCase().includes(profileSearchTerm.toLowerCase()) ||
                                    p.promo_code?.toLowerCase().includes(profileSearchTerm.toLowerCase())
                                  )
                                  .map(profile => (
                                    <tr key={profile.wallet} className="hover:bg-gray-800/50">
                                        <td className="p-3 font-mono text-xs text-gray-300">{profile.wallet?.substring(0, 12)}...</td>
                                        <td className="p-3 font-mono text-primary font-bold">{profile.promo_code}</td>
                                        <td className="p-3">
                                            <div className="flex gap-1">
                                                {profile.twitter_handle && <span className="px-2 py-0.5 bg-blue-500/20 text-blue-400 rounded text-[10px]">T</span>}
                                                {profile.tiktok_handle && <span className="px-2 py-0.5 bg-black text-white rounded text-[10px]">TT</span>}
                                                {profile.facebook_handle && <span className="px-2 py-0.5 bg-blue-600/20 text-blue-300 rounded text-[10px]">F</span>}
                                            </div>
                                        </td>
                                        <td className="p-3 text-gray-300">{profile.referrals_count || 0}</td>
                                        <td className="p-3 text-gray-300">{profile.referred_volume_sol?.toFixed(2) || '0.00'}</td>
                                        <td className="p-3 text-gray-300">{profile.login_count || 0}</td>
                                        <td className="p-3 text-gray-400 text-xs">{profile.created_at ? new Date(profile.created_at).toLocaleDateString() : '-'}</td>
                                        <td className="p-3">
                                            <div className="flex gap-2">
                                                <button 
                                                    onClick={() => handleEditProfile(profile)}
                                                    className="px-2 py-1 bg-primary/20 text-primary rounded text-xs hover:bg-primary/30"
                                                >
                                                    Edit
                                                </button>
                                                <button 
                                                    onClick={() => handleDeleteProfile(profile.wallet)}
                                                    className="px-2 py-1 bg-red-900/20 text-red-400 rounded text-xs hover:bg-red-900/30"
                                                >
                                                    Delete
                                                </button>
                                            </div>
                                        </td>
                                    </tr>
                                  ))}
                                {adminProfiles.length === 0 && (
                                    <tr>
                                        <td colSpan={8} className="p-8 text-center text-gray-500">No profiles found. Click Refresh to load.</td>
                                    </tr>
                                )}
                            </tbody>
                        </table>
                    </div>
                </div>

                {/* Edit Profile Modal */}
                {editingProfile && (
                    <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 backdrop-blur-sm">
                        <div className="bg-surface border border-gray-700 rounded-2xl p-6 w-full max-w-md">
                            <div className="flex justify-between items-center mb-4">
                                <h3 className="text-lg font-bold">Edit Profile</h3>
                                <button onClick={() => setEditingProfile(null)} className="text-gray-400 hover:text-white"><X/></button>
                            </div>
                            <div className="space-y-4">
                                <div>
                                    <label className="text-xs text-gray-500 block mb-1">Wallet</label>
                                    <input 
                                        type="text" 
                                        value={editingProfile.wallet} 
                                        disabled
                                        className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-400"
                                    />
                                </div>
                                <div>
                                    <label className="text-xs text-gray-500 block mb-1">Promo Code</label>
                                    <input 
                                        type="text" 
                                        value={editingProfile.promo_code} 
                                        disabled
                                        className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-400"
                                    />
                                </div>
                                <div>
                                    <label className="text-xs text-gray-500 block mb-1">Twitter Handle</label>
                                    <input 
                                        type="text" 
                                        value={editProfileTwitter} 
                                        onChange={(e) => setEditProfileTwitter(e.target.value)}
                                        placeholder="@handle"
                                        className="w-full bg-background border border-gray-700 rounded-lg px-3 py-2 text-sm outline-none focus:border-primary"
                                    />
                                </div>
                                <div>
                                    <label className="text-xs text-gray-500 block mb-1">TikTok Handle</label>
                                    <input 
                                        type="text" 
                                        value={editProfileTikTok} 
                                        onChange={(e) => setEditProfileTikTok(e.target.value)}
                                        placeholder="@handle"
                                        className="w-full bg-background border border-gray-700 rounded-lg px-3 py-2 text-sm outline-none focus:border-primary"
                                    />
                                </div>
                                <div>
                                    <label className="text-xs text-gray-500 block mb-1">Facebook Name</label>
                                    <input 
                                        type="text" 
                                        value={editProfileFacebook} 
                                        onChange={(e) => setEditProfileFacebook(e.target.value)}
                                        placeholder="Name"
                                        className="w-full bg-background border border-gray-700 rounded-lg px-3 py-2 text-sm outline-none focus:border-primary"
                                    />
                                </div>
                                <div className="flex gap-2">
                                    <button 
                                        onClick={handleSaveProfile}
                                        className="flex-1 bg-primary text-white px-4 py-2 rounded-lg font-bold hover:bg-emerald-600"
                                    >
                                        Save Changes
                                    </button>
                                    <button 
                                        onClick={() => setEditingProfile(null)}
                                        className="px-4 py-2 bg-gray-700 text-white rounded-lg hover:bg-gray-600"
                                    >
                                        Cancel
                                    </button>
                                </div>
                            </div>
                        </div>
                    </div>
                )}
            </div>
        )}

        {/* --- MARKET MAKER TAB --- */}
        {activeTab === 'MARKETMAKER' && (
          <MarketMaker
            userWalletConnected={userWalletConnected}
            connectedAddress={connectedAddress}
            connectedProvider={connectedProvider === 'PHANTOM' ? (window as any).phantom?.solana || (window as any).solana : (window as any).solflare}
            usePrivacyMode={config?.strategy?.usePrivacyMode ?? true}
            addLog={addLog}
            unwhitelistedPct={unwhitelistedPct}
          />
        )}

      </div>
    </div>
  );
};


export default App;

function getToken() {
  return localStorage.getItem('admin_token') || '';
}

async function authFetch(path: string, init: RequestInit = {}) {
  const token = getToken();
  const headers = new Headers(init.headers as any);
  if (token) headers.set('Authorization', `Bearer ${token}`);
  if (!headers.has('Content-Type') && init.body) headers.set('Content-Type', 'application/json');
  const res = await fetch(`${API_BASE}${path}`, { ...init, headers });
  return res;
}
