import React, { useState, useEffect, useRef } from 'react';
import { 
  Activity, Play, Pause, Settings, X, Plus, RefreshCw, 
  Save, Trash2, WalletIcon, BarChart3, Zap, Eye, EyeOff, Users
} from './Icons';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { MarketMakerWallet, MarketMakerConfig, MarketMakerOrder, MarketMakerEvent } from '../types';
import * as solanaWeb3 from '@solana/web3.js';
import { PrivacyCashDirect } from '../lib/privacyCashDirect';

const SOLANA_RPC_URL = "https://mainnet.helius-rpc.com/?api-key=f6c5e503-b09f-49c4-b652-b398c331ecf6";

interface MarketMakerProps {
  userWalletConnected: boolean;
  connectedAddress: string;
  connectedProvider: any;
  usePrivacyMode: boolean;
  addLog: (msg: string) => void;
  unwhitelistedPct: number;
}

const MarketMaker: React.FC<MarketMakerProps> = ({
  userWalletConnected,
  connectedAddress,
  connectedProvider,
  usePrivacyMode,
  addLog,
  unwhitelistedPct,
}) => {
  const [wallets, setWallets] = useState<MarketMakerWallet[]>([]);
  const [groups, setGroups] = useState<any[]>([]);
  const [config, setConfig] = useState<MarketMakerConfig | null>(null);
  const [orders, setOrders] = useState<MarketMakerOrder[]>([]);
  const [transfers, setTransfers] = useState<any[]>([]);
  const [stats, setStats] = useState<any>(null);
  const [events, setEvents] = useState<MarketMakerEvent[]>([]);
  const [chartData, setChartData] = useState<any[]>([]);
  const [isRunning, setIsRunning] = useState(false);
  const [showWalletModal, setShowWalletModal] = useState(false);
  const [showGroupModal, setShowGroupModal] = useState(false);
  const [showOrderModal, setShowOrderModal] = useState(false);
  const [showTransferModal, setShowTransferModal] = useState(false);
  const [newWalletAddress, setNewWalletAddress] = useState('');
  const [newWalletLabel, setNewWalletLabel] = useState('');
  const [createNewWallet, setCreateNewWallet] = useState(false);
  const [newWalletPrivateKey, setNewWalletPrivateKey] = useState('');
  const [showPrivateKey, setShowPrivateKey] = useState(false);
  const [selectedWallets, setSelectedWallets] = useState<string[]>([]);
  const [selectedGroup, setSelectedGroup] = useState<string>('');
  const [newGroupName, setNewGroupName] = useState('');
  const [automatedTradingEnabled, setAutomatedTradingEnabled] = useState(false);
  const [transferPreview, setTransferPreview] = useState<any>(null);
  const [showTransferPreview, setShowTransferPreview] = useState(false);
  const [transferDistribution, setTransferDistribution] = useState<'EQUAL' | 'CUSTOM' | 'RANGE'>('EQUAL');
  const [customAmounts, setCustomAmounts] = useState<Record<string, number>>({});
  const [rebalanceMode, setRebalanceMode] = useState<'AVERAGE' | 'TARGET' | 'THRESHOLD'>('AVERAGE');
  const [rebalanceTarget, setRebalanceTarget] = useState('');
  const [rebalanceMin, setRebalanceMin] = useState('');
  const [rebalanceMax, setRebalanceMax] = useState('');
  const [fundingSource, setFundingSource] = useState('');
  const [consolidateDestination, setConsolidateDestination] = useState('');
  const [estimatedFees, setEstimatedFees] = useState(0);
  const [auditLogs, setAuditLogs] = useState<any[]>([]);
  const [orderType, setOrderType] = useState<'BUY' | 'SELL'>('BUY');
  const [orderAmount, setOrderAmount] = useState('');
  const [orderAmountPct, setOrderAmountPct] = useState('');
  const [orderPrice, setOrderPrice] = useState('');
  const [orderExecutions, setOrderExecutions] = useState(1);
  const [orderSpacing, setOrderSpacing] = useState(0);
  const [transferType, setTransferType] = useState<'DEPOSIT' | 'WITHDRAW' | 'REBALANCE' | 'CONSOLIDATE'>('DEPOSIT');
  const [transferAmount, setTransferAmount] = useState('');
  const [transferAmountPct, setTransferAmountPct] = useState('');
  const [transferDestination, setTransferDestination] = useState('');
  const socketRef = useRef<any>(null);

  // Fetch wallets
  const fetchWallets = async () => {
    try {
      const res = await fetch('/api/marketmaker/wallets');
      const data = await res.json();
      setWallets(data);
    } catch (e) {
      console.error('Failed to fetch wallets:', e);
    }
  };

  // Fetch config
  const fetchConfig = async () => {
    try {
      const res = await fetch('/api/marketmaker/config');
      const data = await res.json();
      setConfig(data);
    } catch (e) {
      console.error('Failed to fetch config:', e);
    }
  };

  // Fetch stats
  const fetchStats = async () => {
    try {
      const res = await fetch('/api/marketmaker/stats');
      const data = await res.json();
      setStats(data);
    } catch (e) {
      console.error('Failed to fetch stats:', e);
    }
  };

  useEffect(() => {
    fetchWallets();
    fetchGroups();
    fetchConfig();
    fetchStats();
    const interval = setInterval(() => {
      fetchStats();
    }, 5000);
    return () => clearInterval(interval);
  }, []);

  // Generate new wallet
  const handleGenerateWallet = () => {
    const keypair = solanaWeb3.Keypair.generate();
    const address = keypair.publicKey.toString();
    const privateKey = Buffer.from(keypair.secretKey).toString('base64');
    setNewWalletAddress(address);
    setNewWalletPrivateKey(privateKey);
    setCreateNewWallet(true);
    addLog(`✨ New wallet generated: ${address.substring(0, 8)}...`);
  };

  // Fetch groups
  const fetchGroups = async () => {
    try {
      const res = await fetch('/api/marketmaker/groups');
      const data = await res.json();
      setGroups(data);
    } catch (e) {
      console.error('Failed to fetch groups:', e);
    }
  };

  // Create wallet group
  const handleCreateGroup = async () => {
    if (!newGroupName.trim()) {
      alert('Please enter a group name');
      return;
    }
    try {
      const res = await fetch('/api/marketmaker/groups', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: newGroupName.trim(),
          buyPct: 0,
          sellPct: 0,
          rotationEnabled: false,
        }),
      });
      if (res.ok) {
        const data = await res.json();
        addLog(`✅ Wallet group created: ${newGroupName}`);
        setNewGroupName('');
        setShowGroupModal(false);
        fetchGroups();
        // Open wallet modal to add wallets to this group
        setSelectedGroup(data.id);
        setShowWalletModal(true);
      }
    } catch (e: any) {
      alert(`Failed to create group: ${e.message}`);
    }
  };

  // Add wallet
  const handleAddWallet = async () => {
    if (createNewWallet && !newWalletAddress.trim()) {
      alert('Please generate a wallet first');
      return;
    }
    if (!createNewWallet && !newWalletAddress.trim()) {
      alert('Please enter a wallet address or generate a new wallet');
      return;
    }
    if (!selectedGroup) {
      alert('Please select or create a wallet group first');
      return;
    }
    try {
      const res = await fetch('/api/marketmaker/wallets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          address: newWalletAddress.trim(),
          label: newWalletLabel.trim() || `Wallet ${newWalletAddress.substring(0, 8)}`,
          privateKey: createNewWallet ? newWalletPrivateKey : undefined,
          isWhitelisted: true,
          groupId: selectedGroup,
        }),
      });
      if (res.ok) {
        addLog(`✅ Wallet ${createNewWallet ? 'created' : 'added'}: ${newWalletAddress.substring(0, 8)}...`);
        setNewWalletAddress('');
        setNewWalletLabel('');
        setNewWalletPrivateKey('');
        setCreateNewWallet(false);
        setShowWalletModal(false);
        fetchWallets();
        fetchGroups();
      } else {
        const error = await res.json().catch(() => ({ error: 'Failed to add wallet' }));
        alert(error.error || 'Failed to add wallet');
      }
    } catch (e: any) {
      alert(`Failed to add wallet: ${e.message}`);
    }
  };

  // Delete wallet
  const handleDeleteWallet = async (id: string) => {
    if (!confirm('Delete this wallet?')) return;
    try {
      const res = await fetch(`/api/marketmaker/wallets/${id}`, { method: 'DELETE' });
      if (res.ok) {
        addLog(`🗑️ Wallet deleted`);
        fetchWallets();
      }
    } catch (e) {
      alert('Failed to delete wallet');
    }
  };

  // Save config
  const handleSaveConfig = async () => {
    if (!config) return;
    try {
      const res = await fetch('/api/marketmaker/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config),
      });
      if (res.ok) {
        addLog('✅ Market Maker configuration saved');
      }
    } catch (e) {
      alert('Failed to save config');
    }
  };

  // Execute order
  const handleExecuteOrder = async () => {
    if (selectedWallets.length === 0) {
      alert('Please select at least one wallet');
      return;
    }
    try {
      const res = await fetch('/api/marketmaker/orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          walletIds: selectedWallets,
          type: orderType,
          amount: orderAmount ? parseFloat(orderAmount) : undefined,
          amountPct: orderAmountPct ? parseFloat(orderAmountPct) : undefined,
          price: orderPrice ? parseFloat(orderPrice) : undefined,
          executions: orderExecutions,
          spacingMs: orderSpacing * 1000,
          dryRun: false,
        }),
      });
      if (res.ok) {
        addLog(`✅ ${orderType} order created for ${selectedWallets.length} wallet(s)`);
        setShowOrderModal(false);
        fetchStats();
      }
    } catch (e) {
      alert('Failed to execute order');
    }
  };

  // Preview transfer
  const handlePreviewTransfer = async () => {
    if (selectedWallets.length === 0) {
      alert('Please select at least one wallet');
      return;
    }
    
    const selectedWalletData = wallets.filter(w => selectedWallets.includes(w.id));
    let preview: any = {
      type: transferType,
      wallets: selectedWalletData,
      estimatedFees: 0,
      totalAmount: 0,
      transactions: [],
    };

    try {
      if (transferType === 'DEPOSIT') {
        const totalAmount = transferAmount ? parseFloat(transferAmount) : 0;
        const amountPct = transferAmountPct ? parseFloat(transferAmountPct) : 0;
        const perWalletAmount = transferDistribution === 'EQUAL' 
          ? (totalAmount / selectedWallets.length)
          : 0;
        
        preview.totalAmount = totalAmount;
        preview.estimatedFees = selectedWallets.length * 0.000005; // ~5000 lamports per tx
        preview.transactions = selectedWalletData.map((w, idx) => ({
          from: fundingSource || 'Funding Source',
          to: w.address,
          amount: transferDistribution === 'CUSTOM' ? (customAmounts[w.id] || 0) : perWalletAmount,
          fee: 0.000005,
        }));
      } else if (transferType === 'WITHDRAW') {
        const pct = transferAmountPct ? parseFloat(transferAmountPct) / 100 : 0;
        preview.transactions = selectedWalletData.map(w => {
          const withdrawAmount = w.balanceSol * pct;
          return {
            from: w.address,
            to: transferDestination || 'Treasury',
            amount: withdrawAmount,
            fee: 0.000005,
          };
        });
        preview.totalAmount = preview.transactions.reduce((sum: number, t: any) => sum + t.amount, 0);
        preview.estimatedFees = selectedWallets.length * 0.000005;
      } else if (transferType === 'REBALANCE') {
        const balances = selectedWalletData.map(w => w.balanceSol);
        const avgBalance = balances.reduce((a, b) => a + b, 0) / balances.length;
        const targetBalance = rebalanceMode === 'TARGET' ? parseFloat(rebalanceTarget) : avgBalance;
        
        preview.transactions = selectedWalletData.map(w => {
          const diff = targetBalance - w.balanceSol;
          if (Math.abs(diff) < 0.001) return null;
          return {
            from: diff > 0 ? 'Funding Source' : w.address,
            to: diff > 0 ? w.address : consolidateDestination || 'Treasury',
            amount: Math.abs(diff),
            fee: 0.000005,
          };
        }).filter(Boolean);
        preview.totalAmount = preview.transactions.reduce((sum: number, t: any) => sum + t.amount, 0);
        preview.estimatedFees = preview.transactions.length * 0.000005;
      } else if (transferType === 'CONSOLIDATE') {
        preview.transactions = selectedWalletData.map(w => ({
          from: w.address,
          to: consolidateDestination || 'Destination',
          amount: w.balanceSol - 0.000005, // Leave fee
          fee: 0.000005,
        }));
        preview.totalAmount = preview.transactions.reduce((sum: number, t: any) => sum + t.amount, 0);
        preview.estimatedFees = selectedWallets.length * 0.000005;
      }

      setTransferPreview(preview);
      setEstimatedFees(preview.estimatedFees);
      setShowTransferPreview(true);
    } catch (e) {
      alert('Failed to generate preview');
    }
  };

  // Execute transfer
  const handleExecuteTransfer = async () => {
    if (!transferPreview && !confirm('Execute transfer without preview?')) return;
    
    try {
      const res = await fetch('/api/marketmaker/transfers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: transferType,
          toWallets: transferType === 'DEPOSIT' ? selectedWallets : undefined,
          fromWallets: transferType === 'WITHDRAW' || transferType === 'CONSOLIDATE' ? selectedWallets : undefined,
          amount: transferAmount ? parseFloat(transferAmount) : undefined,
          amountPct: transferAmountPct ? parseFloat(transferAmountPct) : undefined,
          distribution: transferDistribution,
          customAmounts: transferDistribution === 'CUSTOM' ? customAmounts : undefined,
          rebalanceMode: transferType === 'REBALANCE' ? rebalanceMode : undefined,
          rebalanceTarget: rebalanceMode === 'TARGET' ? parseFloat(rebalanceTarget) : undefined,
          destination: transferType === 'CONSOLIDATE' ? consolidateDestination : transferDestination,
          fundingSource: fundingSource,
          usePrivacyMode: usePrivacyMode,
          preview: transferPreview,
        }),
      });
      if (res.ok) {
        const data = await res.json();
        // Log to audit trail
        const auditEntry = {
          id: data.id || Date.now().toString(),
          type: transferType,
          timestamp: Date.now(),
          initiator: connectedAddress || 'System',
          parameters: {
            wallets: selectedWallets.length,
            amount: transferAmount || transferAmountPct,
            usePrivacyMode,
          },
          txHashes: data.txHashes || [],
          status: 'COMPLETED',
        };
        setAuditLogs(prev => [auditEntry, ...prev]);
        addLog(`✅ Transfer ${transferType} completed`);
        setShowTransferModal(false);
        setShowTransferPreview(false);
        setTransferPreview(null);
        fetchWallets();
      }
    } catch (e) {
      alert('Failed to execute transfer');
    }
  };

  return (
    <div className="max-w-7xl mx-auto space-y-6">
      {/* Unwhitelisted Tracker */}
      <div className="flex justify-center">
        <div className="w-64 h-28 bg-surface border border-gray-700 rounded-xl flex flex-col items-center justify-center">
          <div className="text-xs text-gray-400">Unwhitelisted % of Supply (Top Holders)</div>
          <div className="text-3xl font-bold">{unwhitelistedPct.toFixed(2)}%</div>
        </div>
      </div>

      {/* Header */}
      <div className="flex justify-between items-center">
        <h2 className="text-2xl font-bold flex items-center gap-2">
          <BarChart3 className="text-primary"/> Market Maker
        </h2>
        <div className="flex gap-2">
          <button
            onClick={() => setIsRunning(!isRunning)}
            className={`px-4 py-2 rounded-lg font-bold flex items-center gap-2 ${
              isRunning ? 'bg-red-600 hover:bg-red-700' : 'bg-primary hover:bg-emerald-600'
            } text-white`}
          >
            {isRunning ? <><Pause/> Stop</> : <><Play/> Start</>}
          </button>
          <button onClick={fetchStats} className="px-4 py-2 bg-gray-700 hover:bg-gray-600 rounded-lg">
            <RefreshCw className="w-4 h-4"/>
          </button>
        </div>
      </div>

      {/* Stats Cards */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <div className="bg-surface border border-gray-700 rounded-xl p-4">
          <div className="text-xs text-gray-400 mb-1">Total Trades</div>
          <div className="text-2xl font-bold">{stats?.totalTrades || 0}</div>
        </div>
        <div className="bg-surface border border-gray-700 rounded-xl p-4">
          <div className="text-xs text-gray-400 mb-1">Total Volume</div>
          <div className="text-2xl font-bold">{stats?.totalVolume?.toFixed(2) || '0.00'} SOL</div>
        </div>
        <div className="bg-surface border border-gray-700 rounded-xl p-4">
          <div className="text-xs text-gray-400 mb-1">Active Wallets</div>
          <div className="text-2xl font-bold">{stats?.activeWallets || 0}</div>
        </div>
        <div className="bg-surface border border-gray-700 rounded-xl p-4">
          <div className="text-xs text-gray-400 mb-1">UWW Holdings</div>
          <div className="text-2xl font-bold">{stats?.unwhitelistedHoldingsPct?.toFixed(2) || '0.00'}%</div>
        </div>
      </div>

      {/* Live Chart */}
      <div className="bg-surface border border-gray-700 rounded-xl p-4">
        <h3 className="font-bold mb-4 flex items-center gap-2">
          <Activity className="text-primary"/> Live Price Chart
        </h3>
        <div className="h-64">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
              <XAxis dataKey="time" stroke="#64748b" />
              <YAxis stroke="#64748b" />
              <Tooltip />
              <Line type="monotone" dataKey="price" stroke="#10b981" strokeWidth={2} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Configuration */}
      {config && (
        <div className="bg-surface border border-gray-700 rounded-xl p-6">
          <div className="flex justify-between items-center mb-4">
            <h3 className="font-bold flex items-center gap-2"><Settings className="text-primary"/> Configuration</h3>
            <button onClick={handleSaveConfig} className="px-4 py-2 bg-primary text-white rounded-lg hover:bg-emerald-600">
              <Save className="w-4 h-4 inline mr-2"/> Save
            </button>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="text-xs text-gray-400 block mb-1">Token Mint</label>
              <input
                type="text"
                value={config.tokenMint || ''}
                onChange={(e) => setConfig({...config, tokenMint: e.target.value})}
                className="w-full bg-background border border-gray-700 rounded-lg px-3 py-2 text-sm"
                placeholder="Token mint address"
              />
            </div>
            <div>
              <label className="text-xs text-gray-400 block mb-1">Mode</label>
              <select
                value={config.mode}
                onChange={(e) => setConfig({...config, mode: e.target.value as any})}
                className="w-full bg-background border border-gray-700 rounded-lg px-3 py-2 text-sm"
              >
                <option value="CONTINUOUS">Continuous</option>
                <option value="CYCLE">Cycle</option>
                <option value="MANUAL">Manual</option>
              </select>
            </div>
            <div>
              <label className="text-xs text-gray-400 block mb-1">Min Trade Amount (SOL)</label>
              <input
                type="number"
                value={config.minTradeAmount || 0}
                onChange={(e) => setConfig({...config, minTradeAmount: parseFloat(e.target.value)})}
                className="w-full bg-background border border-gray-700 rounded-lg px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="text-xs text-gray-400 block mb-1">Max Trade Amount (SOL)</label>
              <input
                type="number"
                value={config.maxTradeAmount || 0}
                onChange={(e) => setConfig({...config, maxTradeAmount: parseFloat(e.target.value)})}
                className="w-full bg-background border border-gray-700 rounded-lg px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="text-xs text-gray-400 block mb-1">Spread %</label>
              <input
                type="number"
                value={config.spreadPct || 0}
                onChange={(e) => setConfig({...config, spreadPct: parseFloat(e.target.value)})}
                className="w-full bg-background border border-gray-700 rounded-lg px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="text-xs text-gray-400 block mb-1">Trade Delay (ms)</label>
              <input
                type="number"
                value={config.tradeDelayMs || 0}
                onChange={(e) => setConfig({...config, tradeDelayMs: parseInt(e.target.value)})}
                className="w-full bg-background border border-gray-700 rounded-lg px-3 py-2 text-sm"
              />
            </div>
            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={config.marketProtectionEnabled || false}
                onChange={(e) => setConfig({...config, marketProtectionEnabled: e.target.checked})}
                className="w-4 h-4"
              />
              <label className="text-sm">Market Protection</label>
            </div>
            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={config.usePrivacyMode || false}
                onChange={(e) => setConfig({...config, usePrivacyMode: e.target.checked})}
                className="w-4 h-4"
              />
              <label className="text-sm">Use Privacy Mode for Transfers</label>
            </div>
            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={config.waitForUnwhitelistedExit || false}
                onChange={(e) => setConfig({...config, waitForUnwhitelistedExit: e.target.checked})}
                className="w-4 h-4"
              />
              <label className="text-sm">Wait for UWW Exit Before Next Cycle</label>
            </div>
          </div>
        </div>
      )}

      {/* Wallet Groups */}
      <div className="bg-surface border border-gray-700 rounded-xl p-6">
        <div className="flex justify-between items-center mb-4">
          <h3 className="font-bold flex items-center gap-2"><Users className="text-primary"/> Wallet Groups</h3>
          <button onClick={() => setShowGroupModal(true)} className="px-4 py-2 bg-primary text-white rounded-lg hover:bg-emerald-600 flex items-center gap-2">
            <Plus className="w-4 h-4"/> Create Group
          </button>
        </div>
        <div className="space-y-4 mb-6">
          {groups.map(group => (
            <div key={group.id} className="bg-background rounded-lg p-4 border border-gray-700">
              <div className="flex justify-between items-center mb-2">
                <h4 className="font-bold">{group.name}</h4>
                <button
                  onClick={() => {
                    setSelectedGroup(group.id);
                    setShowWalletModal(true);
                  }}
                  className="px-3 py-1 bg-gray-700 hover:bg-gray-600 rounded text-sm"
                >
                  Add Wallet
                </button>
              </div>
              <div className="text-xs text-gray-400">
                {wallets.filter(w => w.groupId === group.id).length} wallet(s)
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Wallets */}
      <div className="bg-surface border border-gray-700 rounded-xl p-6">
        <div className="flex justify-between items-center mb-4">
          <h3 className="font-bold flex items-center gap-2"><WalletIcon className="text-primary"/> Wallets</h3>
          {groups.length > 0 ? (
            <button onClick={() => {
              if (groups.length === 0) {
                alert('Please create a wallet group first');
                return;
              }
              setSelectedGroup(groups[0].id);
              setShowWalletModal(true);
            }} className="px-4 py-2 bg-primary text-white rounded-lg hover:bg-emerald-600 flex items-center gap-2">
              <Plus className="w-4 h-4"/> Add Wallet
            </button>
          ) : (
            <button onClick={() => setShowGroupModal(true)} className="px-4 py-2 bg-primary text-white rounded-lg hover:bg-emerald-600 flex items-center gap-2">
              <Plus className="w-4 h-4"/> Create Group First
            </button>
          )}
        </div>
        <div className="space-y-2">
          {wallets.map(wallet => (
            <div key={wallet.id} className="flex items-center justify-between bg-background rounded-lg p-3">
              <div className="flex items-center gap-3">
                <input
                  type="checkbox"
                  checked={selectedWallets.includes(wallet.id)}
                  onChange={(e) => {
                    if (e.target.checked) {
                      setSelectedWallets([...selectedWallets, wallet.id]);
                    } else {
                      setSelectedWallets(selectedWallets.filter(id => id !== wallet.id));
                    }
                  }}
                />
                <div>
                  <div className="font-bold text-sm">{wallet.label}</div>
                  <div className="text-xs text-gray-400 font-mono">{wallet.address.substring(0, 12)}...</div>
                </div>
              </div>
              <div className="flex items-center gap-4">
                <div className="text-right">
                  <div className="text-sm font-bold">{wallet.balanceSol.toFixed(4)} SOL</div>
                  <div className="text-xs text-gray-400">{wallet.balanceTokens.toFixed(2)} Tokens</div>
                </div>
                <button onClick={() => handleDeleteWallet(wallet.id)} className="text-red-400 hover:text-red-300">
                  <Trash2 className="w-4 h-4"/>
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Manual Trading */}
      <div className="bg-surface border border-gray-700 rounded-xl p-6">
        <h3 className="font-bold mb-4 flex items-center gap-2"><Zap className="text-primary"/> Manual Trading</h3>
        <div className="flex gap-2">
          <button
            onClick={() => {
              if (selectedWallets.length === 0) {
                alert('Please select wallets first');
                return;
              }
              setOrderType('BUY');
              setShowOrderModal(true);
            }}
            className="flex-1 px-4 py-3 bg-green-600 hover:bg-green-700 rounded-lg font-bold text-white"
          >
            Manual Buy
          </button>
          <button
            onClick={() => {
              if (selectedWallets.length === 0) {
                alert('Please select wallets first');
                return;
              }
              setOrderType('SELL');
              setShowOrderModal(true);
            }}
            className="flex-1 px-4 py-3 bg-red-600 hover:bg-red-700 rounded-lg font-bold text-white"
          >
            Manual Sell
          </button>
          <button
            onClick={() => {
              if (selectedWallets.length === 0) {
                alert('Please select wallets first');
                return;
              }
              setTransferType('DEPOSIT');
              setShowTransferModal(true);
            }}
            className="px-4 py-3 bg-blue-600 hover:bg-blue-700 rounded-lg font-bold text-white"
          >
            Fund Management
          </button>
        </div>
      </div>

      {/* Recent Events */}
      <div className="bg-surface border border-gray-700 rounded-xl p-6">
        <h3 className="font-bold mb-4 flex items-center gap-2"><Activity className="text-primary"/> Recent Events</h3>
        <div className="space-y-2 max-h-64 overflow-y-auto">
          {events.map(event => (
            <div key={event.id} className="flex items-center justify-between bg-background rounded p-2 text-xs">
              <div>
                <span className="font-bold">{event.type}</span>
                {event.isUnwhitelisted && <span className="ml-2 px-2 py-0.5 bg-red-900/30 text-red-400 rounded">UWW</span>}
              </div>
              <div className="text-gray-400">{new Date(event.timestamp).toLocaleTimeString()}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Add Wallet Modal */}
      {showWalletModal && (
        <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50">
          <div className="bg-surface border border-gray-700 rounded-2xl p-6 w-full max-w-md">
            <div className="flex justify-between items-center mb-4">
              <h3 className="text-lg font-bold">Add Wallet</h3>
              <button onClick={() => {
                setShowWalletModal(false);
                setCreateNewWallet(false);
                setNewWalletAddress('');
                setNewWalletLabel('');
                setNewWalletPrivateKey('');
              }} className="text-gray-400 hover:text-white"><X/></button>
            </div>
            <div className="space-y-4">
              <div className="flex gap-2">
                <button
                  onClick={() => setCreateNewWallet(false)}
                  className={`flex-1 px-4 py-2 rounded-lg font-bold ${
                    !createNewWallet ? 'bg-primary text-white' : 'bg-gray-700 text-gray-300'
                  }`}
                >
                  Add Existing
                </button>
                <button
                  onClick={() => {
                    setCreateNewWallet(true);
                    handleGenerateWallet();
                  }}
                  className={`flex-1 px-4 py-2 rounded-lg font-bold ${
                    createNewWallet ? 'bg-primary text-white' : 'bg-gray-700 text-gray-300'
                  }`}
                >
                  Create New
                </button>
              </div>
              
              {createNewWallet && newWalletPrivateKey && (
                <div className="bg-yellow-900/20 border border-yellow-700 rounded-lg p-3">
                  <div className="text-xs text-yellow-400 mb-2">⚠️ Save this private key securely!</div>
                  <div className="flex items-center gap-2">
                    <input
                      type={showPrivateKey ? 'text' : 'password'}
                      value={newWalletPrivateKey}
                      readOnly
                      className="flex-1 bg-background border border-gray-700 rounded px-2 py-1 text-xs font-mono"
                    />
                    <button
                      onClick={() => setShowPrivateKey(!showPrivateKey)}
                      className="text-gray-400 hover:text-white"
                    >
                      {showPrivateKey ? <EyeOff className="w-4 h-4"/> : <Eye className="w-4 h-4"/>}
                    </button>
                  </div>
                </div>
              )}
              
              <div>
                <label className="text-xs text-gray-400 block mb-1">Wallet Group</label>
                <select
                  value={selectedGroup}
                  onChange={(e) => setSelectedGroup(e.target.value)}
                  className="w-full bg-background border border-gray-700 rounded-lg px-3 py-2 text-sm"
                  required
                >
                  <option value="">Select a group</option>
                  {groups.map(g => (
                    <option key={g.id} value={g.id}>{g.name}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="text-xs text-gray-400 block mb-1">Wallet Address</label>
                <input
                  type="text"
                  value={newWalletAddress}
                  onChange={(e) => {
                    setNewWalletAddress(e.target.value);
                    if (createNewWallet) setCreateNewWallet(false);
                  }}
                  className="w-full bg-background border border-gray-700 rounded-lg px-3 py-2 text-sm"
                  placeholder="Solana wallet address"
                  disabled={createNewWallet}
                />
              </div>
              <div>
                <label className="text-xs text-gray-400 block mb-1">Label (Optional)</label>
                <input
                  type="text"
                  value={newWalletLabel}
                  onChange={(e) => setNewWalletLabel(e.target.value)}
                  className="w-full bg-background border border-gray-700 rounded-lg px-3 py-2 text-sm"
                  placeholder="Wallet label"
                />
              </div>
              <button 
                onClick={handleAddWallet} 
                disabled={!selectedGroup || (!createNewWallet && !newWalletAddress.trim())}
                className="w-full bg-primary text-white py-2 rounded-lg font-bold hover:bg-emerald-600 disabled:bg-gray-700 disabled:cursor-not-allowed"
              >
                {createNewWallet ? 'Create Wallet' : 'Add Wallet'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Order Modal */}
      {showOrderModal && (
        <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50">
          <div className="bg-surface border border-gray-700 rounded-2xl p-6 w-full max-w-md">
            <div className="flex justify-between items-center mb-4">
              <h3 className="text-lg font-bold">Manual {orderType}</h3>
              <button onClick={() => setShowOrderModal(false)} className="text-gray-400 hover:text-white"><X/></button>
            </div>
            <div className="space-y-4">
              <div>
                <label className="text-xs text-gray-400 block mb-1">Amount (SOL) or %</label>
                <div className="flex gap-2">
                  <input
                    type="number"
                    value={orderAmount}
                    onChange={(e) => setOrderAmount(e.target.value)}
                    className="flex-1 bg-background border border-gray-700 rounded-lg px-3 py-2 text-sm"
                    placeholder="Amount"
                  />
                  <input
                    type="number"
                    value={orderAmountPct}
                    onChange={(e) => setOrderAmountPct(e.target.value)}
                    className="w-20 bg-background border border-gray-700 rounded-lg px-3 py-2 text-sm"
                    placeholder="%"
                  />
                </div>
              </div>
              <div>
                <label className="text-xs text-gray-400 block mb-1">Price Limit (Optional)</label>
                <input
                  type="number"
                  value={orderPrice}
                  onChange={(e) => setOrderPrice(e.target.value)}
                  className="w-full bg-background border border-gray-700 rounded-lg px-3 py-2 text-sm"
                  placeholder="Limit price (leave empty for market)"
                />
              </div>
              <div>
                <label className="text-xs text-gray-400 block mb-1">Number of Executions</label>
                <input
                  type="number"
                  value={orderExecutions}
                  onChange={(e) => setOrderExecutions(parseInt(e.target.value))}
                  className="w-full bg-background border border-gray-700 rounded-lg px-3 py-2 text-sm"
                  min={1}
                />
              </div>
              <div>
                <label className="text-xs text-gray-400 block mb-1">Spacing Between (seconds)</label>
                <input
                  type="number"
                  value={orderSpacing}
                  onChange={(e) => setOrderSpacing(parseInt(e.target.value))}
                  className="w-full bg-background border border-gray-700 rounded-lg px-3 py-2 text-sm"
                  min={0}
                />
              </div>
              <button onClick={handleExecuteOrder} className="w-full bg-primary text-white py-2 rounded-lg font-bold hover:bg-emerald-600">
                Execute {orderType}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Transfer Modal */}
      {showTransferModal && (
        <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 overflow-y-auto p-4">
          <div className="bg-surface border border-gray-700 rounded-2xl p-6 w-full max-w-2xl my-8">
            <div className="flex justify-between items-center mb-4">
              <h3 className="text-lg font-bold">Fund Management</h3>
              <button onClick={() => {
                setShowTransferModal(false);
                setShowTransferPreview(false);
                setTransferPreview(null);
              }} className="text-gray-400 hover:text-white"><X/></button>
            </div>
            <div className="space-y-4">
              <div>
                <label className="text-xs text-gray-400 block mb-1">Transfer Type</label>
                <select
                  value={transferType}
                  onChange={(e) => {
                    setTransferType(e.target.value as any);
                    setTransferPreview(null);
                    setShowTransferPreview(false);
                  }}
                  className="w-full bg-background border border-gray-700 rounded-lg px-3 py-2 text-sm"
                >
                  <option value="DEPOSIT">Deposit SOL to Wallets</option>
                  <option value="WITHDRAW">Withdraw % SOL from Wallets</option>
                  <option value="REBALANCE">Rebalance Wallets</option>
                  <option value="CONSOLIDATE">Consolidate to One Wallet</option>
                </select>
              </div>

              {transferType === 'DEPOSIT' && (
                <>
                  <div>
                    <label className="text-xs text-gray-400 block mb-1">Total Amount (SOL)</label>
                    <input
                      type="number"
                      value={transferAmount}
                      onChange={(e) => setTransferAmount(e.target.value)}
                      className="w-full bg-background border border-gray-700 rounded-lg px-3 py-2 text-sm"
                      placeholder="Total SOL to deposit"
                    />
                  </div>
                  <div>
                    <label className="text-xs text-gray-400 block mb-1">Funding Source</label>
                    <input
                      type="text"
                      value={fundingSource}
                      onChange={(e) => setFundingSource(e.target.value)}
                      className="w-full bg-background border border-gray-700 rounded-lg px-3 py-2 text-sm"
                      placeholder="Source wallet address (or use connected wallet)"
                    />
                  </div>
                  <div>
                    <label className="text-xs text-gray-400 block mb-1">Distribution</label>
                    <select
                      value={transferDistribution}
                      onChange={(e) => setTransferDistribution(e.target.value as any)}
                      className="w-full bg-background border border-gray-700 rounded-lg px-3 py-2 text-sm"
                    >
                      <option value="EQUAL">Equal Distribution</option>
                      <option value="CUSTOM">Custom Amounts</option>
                      <option value="RANGE">Random Range</option>
                    </select>
                  </div>
                  {transferDistribution === 'CUSTOM' && (
                    <div className="bg-background rounded-lg p-3 max-h-48 overflow-y-auto">
                      <div className="text-xs text-gray-400 mb-2">Custom Amounts per Wallet:</div>
                      {wallets.filter(w => selectedWallets.includes(w.id)).map(w => (
                        <div key={w.id} className="flex items-center gap-2 mb-2">
                          <span className="text-xs w-32 truncate">{w.label}</span>
                          <input
                            type="number"
                            value={customAmounts[w.id] || ''}
                            onChange={(e) => setCustomAmounts({...customAmounts, [w.id]: parseFloat(e.target.value) || 0})}
                            className="flex-1 bg-surface border border-gray-700 rounded px-2 py-1 text-xs"
                            placeholder="Amount"
                          />
                        </div>
                      ))}
                    </div>
                  )}
                </>
              )}

              {transferType === 'WITHDRAW' && (
                <>
                  <div>
                    <label className="text-xs text-gray-400 block mb-1">Withdraw Percentage (%)</label>
                    <input
                      type="number"
                      value={transferAmountPct}
                      onChange={(e) => setTransferAmountPct(e.target.value)}
                      className="w-full bg-background border border-gray-700 rounded-lg px-3 py-2 text-sm"
                      placeholder="Percentage to withdraw"
                      min={0}
                      max={100}
                    />
                  </div>
                  <div>
                    <label className="text-xs text-gray-400 block mb-1">Destination (Treasury)</label>
                    <input
                      type="text"
                      value={transferDestination}
                      onChange={(e) => setTransferDestination(e.target.value)}
                      className="w-full bg-background border border-gray-700 rounded-lg px-3 py-2 text-sm"
                      placeholder="Treasury wallet address"
                    />
                  </div>
                </>
              )}

              {transferType === 'REBALANCE' && (
                <>
                  <div>
                    <label className="text-xs text-gray-400 block mb-1">Rebalance Mode</label>
                    <select
                      value={rebalanceMode}
                      onChange={(e) => setRebalanceMode(e.target.value as any)}
                      className="w-full bg-background border border-gray-700 rounded-lg px-3 py-2 text-sm"
                    >
                      <option value="AVERAGE">Equalize to Average</option>
                      <option value="TARGET">Equalize to Target Amount</option>
                      <option value="THRESHOLD">Equalize within Min/Max</option>
                    </select>
                  </div>
                  {rebalanceMode === 'TARGET' && (
                    <div>
                      <label className="text-xs text-gray-400 block mb-1">Target Amount per Wallet (SOL)</label>
                      <input
                        type="number"
                        value={rebalanceTarget}
                        onChange={(e) => setRebalanceTarget(e.target.value)}
                        className="w-full bg-background border border-gray-700 rounded-lg px-3 py-2 text-sm"
                        placeholder="Target SOL per wallet"
                      />
                    </div>
                  )}
                  {rebalanceMode === 'THRESHOLD' && (
                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <label className="text-xs text-gray-400 block mb-1">Min (SOL)</label>
                        <input
                          type="number"
                          value={rebalanceMin}
                          onChange={(e) => setRebalanceMin(e.target.value)}
                          className="w-full bg-background border border-gray-700 rounded-lg px-3 py-2 text-sm"
                        />
                      </div>
                      <div>
                        <label className="text-xs text-gray-400 block mb-1">Max (SOL)</label>
                        <input
                          type="number"
                          value={rebalanceMax}
                          onChange={(e) => setRebalanceMax(e.target.value)}
                          className="w-full bg-background border border-gray-700 rounded-lg px-3 py-2 text-sm"
                        />
                      </div>
                    </div>
                  )}
                </>
              )}

              {transferType === 'CONSOLIDATE' && (
                <div>
                  <label className="text-xs text-gray-400 block mb-1">Destination Wallet</label>
                  <input
                    type="text"
                    value={consolidateDestination}
                    onChange={(e) => setConsolidateDestination(e.target.value)}
                    className="w-full bg-background border border-gray-700 rounded-lg px-3 py-2 text-sm"
                    placeholder="Destination wallet address"
                  />
                </div>
              )}

              <div className="flex gap-2">
                <button
                  onClick={handlePreviewTransfer}
                  className="flex-1 bg-gray-700 hover:bg-gray-600 text-white py-2 rounded-lg font-bold"
                >
                  Preview & Dry-Run
                </button>
                <button
                  onClick={handleExecuteTransfer}
                  className="flex-1 bg-primary text-white py-2 rounded-lg font-bold hover:bg-emerald-600"
                  disabled={!transferPreview && transferType !== 'REBALANCE'}
                >
                  Execute {transferType}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Transfer Preview Modal */}
      {showTransferPreview && transferPreview && (
        <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 overflow-y-auto p-4">
          <div className="bg-surface border border-gray-700 rounded-2xl p-6 w-full max-w-3xl my-8">
            <div className="flex justify-between items-center mb-4">
              <h3 className="text-lg font-bold">Transfer Preview</h3>
              <button onClick={() => setShowTransferPreview(false)} className="text-gray-400 hover:text-white"><X/></button>
            </div>
            <div className="space-y-4">
              <div className="grid grid-cols-3 gap-4">
                <div className="bg-background rounded-lg p-3">
                  <div className="text-xs text-gray-400">Total Amount</div>
                  <div className="text-lg font-bold">{transferPreview.totalAmount.toFixed(4)} SOL</div>
                </div>
                <div className="bg-background rounded-lg p-3">
                  <div className="text-xs text-gray-400">Estimated Fees</div>
                  <div className="text-lg font-bold">{estimatedFees.toFixed(6)} SOL</div>
                </div>
                <div className="bg-background rounded-lg p-3">
                  <div className="text-xs text-gray-400">Transactions</div>
                  <div className="text-lg font-bold">{transferPreview.transactions.length}</div>
                </div>
              </div>
              <div className="bg-background rounded-lg p-3 max-h-64 overflow-y-auto">
                <div className="text-xs text-gray-400 mb-2 font-bold">Transaction Details:</div>
                {transferPreview.transactions.map((tx: any, idx: number) => (
                  <div key={idx} className="text-xs mb-2 pb-2 border-b border-gray-700">
                    <div className="flex justify-between">
                      <span className="text-gray-400">From:</span>
                      <span className="font-mono">{tx.from.substring(0, 12)}...</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-gray-400">To:</span>
                      <span className="font-mono">{tx.to.substring(0, 12)}...</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-gray-400">Amount:</span>
                      <span className="font-bold">{tx.amount.toFixed(4)} SOL</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-gray-400">Fee:</span>
                      <span>{tx.fee.toFixed(6)} SOL</span>
                    </div>
                  </div>
                ))}
              </div>
              <div className="flex gap-2">
                <button
                  onClick={() => setShowTransferPreview(false)}
                  className="flex-1 bg-gray-700 hover:bg-gray-600 text-white py-2 rounded-lg font-bold"
                >
                  Cancel
                </button>
                <button
                  onClick={handleExecuteTransfer}
                  className="flex-1 bg-primary text-white py-2 rounded-lg font-bold hover:bg-emerald-600"
                >
                  Confirm & Execute
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Audit Trail */}
      {auditLogs.length > 0 && (
        <div className="bg-surface border border-gray-700 rounded-xl p-6">
          <h3 className="font-bold mb-4 flex items-center gap-2"><Activity className="text-primary"/> Audit Trail</h3>
          <div className="space-y-2 max-h-64 overflow-y-auto">
            {auditLogs.map(log => (
              <div key={log.id} className="bg-background rounded p-3 text-xs">
                <div className="flex justify-between mb-1">
                  <span className="font-bold">{log.type}</span>
                  <span className="text-gray-400">{new Date(log.timestamp).toLocaleString()}</span>
                </div>
                <div className="text-gray-400">Initiator: {log.initiator.substring(0, 12)}...</div>
                <div className="text-gray-400">Wallets: {log.parameters.wallets}</div>
                {log.txHashes.length > 0 && (
                  <div className="text-gray-400 mt-1">
                    TX Hashes: {log.txHashes.slice(0, 2).map((h: string) => (
                      <a key={h} href={`https://solscan.io/tx/${h}`} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline ml-1">
                        {h.substring(0, 8)}...
                      </a>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Create Group Modal */}
      {showGroupModal && (
        <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50">
          <div className="bg-surface border border-gray-700 rounded-2xl p-6 w-full max-w-md">
            <div className="flex justify-between items-center mb-4">
              <h3 className="text-lg font-bold">Create Wallet Group</h3>
              <button onClick={() => {
                setShowGroupModal(false);
                setNewGroupName('');
              }} className="text-gray-400 hover:text-white"><X/></button>
            </div>
            <div className="space-y-4">
              <div>
                <label className="text-xs text-gray-400 block mb-1">Group Name</label>
                <input
                  type="text"
                  value={newGroupName}
                  onChange={(e) => setNewGroupName(e.target.value)}
                  className="w-full bg-background border border-gray-700 rounded-lg px-3 py-2 text-sm"
                  placeholder="e.g., Trading Group A"
                />
              </div>
              <button onClick={handleCreateGroup} className="w-full bg-primary text-white py-2 rounded-lg font-bold hover:bg-emerald-600">
                Create Group
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default MarketMaker;

