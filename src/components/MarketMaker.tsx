import React, { useState, useEffect } from 'react';
import { 
  Activity, Play, Pause, Settings, X, Plus, RefreshCw, 
  Trash2, BarChart3, Eye, EyeOff, Users,
  ChevronLeft, ChevronRight, ChevronDown, CheckCircle2, Edit, AlertTriangle, Settings2
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

// Stats Card Component
const StatsCard: React.FC<{ title: string; value: string | number; subtitle?: string; icon?: React.ReactNode }> = ({ title, value, subtitle, icon }) => (
  <div className="rounded-lg bg-surface border border-gray-700 p-4">
    <div className="flex items-center justify-between mb-2">
      <h3 className="text-sm font-medium text-gray-400">{title}</h3>
      {icon && <div className="text-gray-400">{icon}</div>}
    </div>
    <p className="text-2xl font-bold mb-1">{value}</p>
    {subtitle && <p className="text-xs text-gray-500">{subtitle}</p>}
  </div>
);

// Group Card Component
const GroupCard: React.FC<{
  group: any;
  onEdit?: (group: any) => void;
  onDelete?: (group: any) => void;
}> = ({ group, onEdit, onDelete }) => {
  const [isExpanded, setIsExpanded] = useState(group.status === 'Live');

  return (
    <div className="rounded-md border border-gray-700 bg-gray-800 p-3 hover:border-primary/50 transition-colors">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2 flex-1">
          <button
            onClick={() => setIsExpanded(!isExpanded)}
            className="text-gray-400 hover:text-white"
          >
            {isExpanded ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
          </button>
          <h4 className="font-semibold text-sm text-white">{group.name}</h4>
          {group.status === 'Live' && (
            <div className="h-2 w-2 rounded-full bg-emerald-500 animate-pulse" />
          )}
        </div>
      </div>
      
      <p className="text-xs text-gray-400 mb-2 ml-6">
        {group.walletCount || 0} wallets
      </p>

      {isExpanded && (
        <div className="ml-6 space-y-3 mt-3 border-t border-gray-700 pt-3">
          <div className="flex items-center gap-1.5">
            {group.status === 'Live' && (
              <button className="flex items-center gap-1 text-xs bg-emerald-600 text-white px-2 py-1 rounded-md justify-center">
                <CheckCircle2 className="w-3 h-3" />
                Live
              </button>
            )}
            <button 
              onClick={() => onEdit?.(group)}
              className="flex-1 border border-blue-500 text-blue-500 hover:bg-blue-500 hover:text-white px-2 py-1 rounded-md text-xs transition-colors"
            >
              <Edit className="w-3 h-3 inline mr-1" />
              Edit
            </button>
            <button 
              onClick={() => onDelete?.(group)}
              className="flex-1 border border-red-500 text-red-500 hover:bg-red-500 hover:text-white px-2 py-1 rounded-md text-xs transition-colors"
            >
              <Trash2 className="w-3 h-3 inline mr-1" />
              Delete
            </button>
          </div>
        </div>
      )}

      <p className="text-xs text-gray-500 mt-2 ml-6">
        Last updated: {new Date(group.updatedAt || group.createdAt).toLocaleString()}
      </p>
    </div>
  );
};

// Trading Controls Component
const TradingControls: React.FC<{
  config: MarketMakerConfig | null;
  onConfigChange: (config: Partial<MarketMakerConfig>) => void;
  onExecuteBuy: () => void;
  onPause: () => void;
  onResume: () => void;
  onForceSell: () => void;
  isRunning: boolean;
}> = ({ config, onConfigChange, onExecuteBuy, onPause, onResume, onForceSell, isRunning }) => {
  const [minRange, setMinRange] = useState(2);
  const [maxRange, setMaxRange] = useState(100);
  const [minDelay, setMinDelay] = useState(1);
  const [maxDelay, setMaxDelay] = useState(2);

  return (
    <div className="rounded-lg bg-surface border border-gray-700 p-4 space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-semibold flex items-center gap-2">
          <Settings2 className="w-5 h-5" />
          Trading Controls
        </h3>
      </div>

      {/* Action Buttons */}
      <div className="flex gap-2">
        <button 
          onClick={onPause}
          className="flex-1 flex items-center justify-center gap-2 h-10 rounded-md px-4 bg-orange-600 hover:bg-orange-700 text-white text-sm"
        >
          <Pause className="w-4 h-4" />
          Pause
        </button>
        <button 
          onClick={onResume}
          className="flex-1 flex items-center justify-center gap-2 h-10 rounded-md px-4 bg-emerald-600 hover:bg-emerald-700 text-white text-sm"
        >
          <Play className="w-4 h-4" />
          Resume
        </button>
        <button 
          onClick={onForceSell}
          className="flex-1 flex items-center justify-center gap-2 h-10 rounded-md px-4 bg-red-600 hover:bg-red-700 text-white text-sm whitespace-nowrap"
        >
          <AlertTriangle className="w-4 h-4" />
          Force Sell
        </button>
      </div>

      {/* Percentage Range */}
      <div>
        <label className="text-xs text-gray-400 mb-1.5 block">Percentage Range (%)</label>
        <div className="grid grid-cols-2 gap-2">
          <div>
            <input
              type="number"
              value={minRange}
              onChange={(e) => setMinRange(Number(e.target.value))}
              className="w-full bg-background border border-gray-700 rounded-lg px-3 py-2 text-sm"
              placeholder="Min"
            />
            <span className="text-xs text-gray-500 mt-1 block">Min</span>
          </div>
          <div>
            <input
              type="number"
              value={maxRange}
              onChange={(e) => setMaxRange(Number(e.target.value))}
              className="w-full bg-background border border-gray-700 rounded-lg px-3 py-2 text-sm"
              placeholder="Max"
            />
            <span className="text-xs text-gray-500 mt-1 block">Max</span>
          </div>
        </div>
      </div>

      {/* Timing Delay */}
      <div>
        <label className="text-xs text-gray-400 mb-1.5 block">Timing Delay (seconds)</label>
        <div className="grid grid-cols-2 gap-2">
          <div>
            <input
              type="number"
              value={minDelay}
              onChange={(e) => setMinDelay(Number(e.target.value))}
              className="w-full bg-background border border-gray-700 rounded-lg px-3 py-2 text-sm"
              placeholder="Min"
            />
            <span className="text-xs text-gray-500 mt-1 block">Min</span>
          </div>
          <div>
            <input
              type="number"
              value={maxDelay}
              onChange={(e) => setMaxDelay(Number(e.target.value))}
              className="w-full bg-background border border-gray-700 rounded-lg px-3 py-2 text-sm"
              placeholder="Max"
            />
            <span className="text-xs text-gray-500 mt-1 block">Max</span>
          </div>
        </div>
      </div>

      {/* Execute Button */}
      <button 
        onClick={onExecuteBuy}
        className="w-full bg-emerald-600 hover:bg-emerald-700 text-white flex items-center justify-center gap-2 py-3 font-bold text-base rounded-md"
      >
        Execute Buy
        <ChevronRight className="w-5 h-5" />
      </button>

      {/* Quick Actions */}
      <div className="flex gap-2">
        <button className="flex-1 rounded-md border-2 border-emerald-500 text-emerald-500 px-3 py-2 text-sm hover:bg-emerald-500 hover:text-white transition-colors flex items-center justify-center gap-2">
          <span>Buy</span>
          <ChevronDown className="w-4 h-4" />
        </button>
        <button className="flex-1 rounded-md border-2 border-red-500 text-red-500 px-3 py-2 text-sm hover:bg-red-500 hover:text-white transition-colors flex items-center justify-center gap-2">
          <span>Sell</span>
          <ChevronDown className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
};

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
  const [stats, setStats] = useState<any>(null);
  const [chartData, setChartData] = useState<any[]>([]);
  const [isRunning, setIsRunning] = useState(false);
  const [isSidebarOpen, setIsSidebarOpen] = useState(true);
  const [showWalletModal, setShowWalletModal] = useState(false);
  const [showGroupModal, setShowGroupModal] = useState(false);
  const [newWalletAddress, setNewWalletAddress] = useState('');
  const [newWalletLabel, setNewWalletLabel] = useState('');
  const [createNewWallet, setCreateNewWallet] = useState(false);
  const [newWalletPrivateKey, setNewWalletPrivateKey] = useState('');
  const [selectedGroup, setSelectedGroup] = useState<string>('');
  const [newGroupName, setNewGroupName] = useState('');

  // Fetch data
  const fetchWallets = async () => {
    try {
      const res = await fetch('/api/marketmaker/wallets');
      const data = await res.json();
      setWallets(data);
    } catch (e) {
      console.error('Failed to fetch wallets:', e);
    }
  };

  const fetchGroups = async () => {
    try {
      const res = await fetch('/api/marketmaker/groups');
      const data = await res.json();
      setGroups(data);
    } catch (e) {
      console.error('Failed to fetch groups:', e);
    }
  };

  const fetchConfig = async () => {
    try {
      const res = await fetch('/api/marketmaker/config');
      const data = await res.json();
      setConfig(data);
    } catch (e) {
      console.error('Failed to fetch config:', e);
    }
  };

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
        fetchGroups();
      }
    } catch (e) {
      alert('Failed to delete wallet');
    }
  };

  // Delete group
  const handleDeleteGroup = async (group: any) => {
    if (!confirm(`Delete group "${group.name}"? This cannot be undone.`)) return;
    try {
      const res = await fetch(`/api/marketmaker/groups/${group.id}`, { method: 'DELETE' });
      if (res.ok) {
        addLog(`🗑️ Group deleted: ${group.name}`);
        fetchGroups();
      }
    } catch (e) {
      alert('Failed to delete group');
    }
  };

  const sidebarWidth = isSidebarOpen ? '16rem' : '0';

  return (
    <div className="relative w-full bg-background">
      {/* Sidebar */}
      <aside 
        className="fixed left-0 top-0 h-screen border-r border-gray-700 bg-gray-900 flex flex-col transition-all duration-300 z-10"
        style={{ width: sidebarWidth, overflow: 'hidden' }}
      >
        {/* Header */}
        <div className="border-b border-gray-700 p-4 flex items-center justify-between">
          <div>
            <h2 className="text-xl font-bold text-white">Ulti MM</h2>
            <p className="text-xs text-gray-400 mt-1">Market Maker</p>
          </div>
          <button
            onClick={() => setIsSidebarOpen(false)}
            className="text-gray-400 hover:text-white transition-colors p-1"
            aria-label="Toggle sidebar"
          >
            <ChevronLeft className="w-5 h-5" />
          </button>
        </div>

        {/* Groups Section */}
        <div className="flex-1 overflow-y-auto p-3">
          <div className="flex items-center justify-between mb-3 mt-4">
            <h3 className="text-sm font-bold text-white">Groups</h3>
          </div>
          <div className="space-y-2">
            {groups.map((group) => (
              <GroupCard 
                key={group.id} 
                group={group} 
                onDelete={handleDeleteGroup}
              />
            ))}
          </div>
          <button 
            onClick={() => setShowGroupModal(true)}
            className="w-full mt-3 rounded-md border-2 border-dashed border-gray-700 px-4 py-2 text-sm text-gray-400 hover:border-primary hover:text-primary transition-colors flex items-center justify-center gap-2"
          >
            <Plus className="w-4 h-4" />
            Create Group
          </button>
        </div>
      </aside>

      {/* Toggle button when sidebar is closed */}
      {!isSidebarOpen && (
        <button
          onClick={() => setIsSidebarOpen(true)}
          className="fixed left-2 top-4 z-20 text-gray-400 hover:text-white transition-colors bg-gray-800 p-2 rounded-md border border-gray-700"
          aria-label="Open sidebar"
        >
          <ChevronRight className="w-5 h-5" />
        </button>
      )}

      {/* Main Content */}
      <main 
        className="flex-1 overflow-y-auto transition-all duration-300 min-h-screen"
        style={{ marginLeft: sidebarWidth }}
      >
        <header 
          className="sticky top-0 z-10 h-16 border-b border-gray-700 bg-gray-800 flex items-center justify-between px-6 transition-all duration-300"
        >
          <div className="flex items-center gap-4">
            <h1 className="text-xl font-bold">Ulti MM Dashboard</h1>
            <div className="flex items-center gap-2">
              <div className="h-2 w-2 rounded-full bg-emerald-500" />
              <span className="text-sm text-gray-300">Connected</span>
            </div>
          </div>
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
        </header>

        <div className="mt-16 p-6 space-y-6">
          {/* Unwhitelisted Tracker */}
          <div className="flex justify-center">
            <div className="w-64 h-28 bg-surface border border-gray-700 rounded-xl flex flex-col items-center justify-center">
              <div className="text-xs text-gray-400">Unwhitelisted % of Supply (Top Holders)</div>
              <div className="text-3xl font-bold">{unwhitelistedPct.toFixed(2)}%</div>
            </div>
          </div>

          {/* Top Stats Row */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <StatsCard
              title="Total Volume (24h)"
              value={`${stats?.totalVolume?.toFixed(2) || '0.00'} SOL`}
              subtitle={`${stats?.totalTransactions || 0} transactions`}
            />
            <StatsCard
              title="Total SOL"
              value={`${stats?.totalSol?.toFixed(2) || '0.00'} SOL`}
              subtitle={`${stats?.totalTokens || 0} tokens`}
            />
            <div className="rounded-lg bg-surface border border-gray-700 p-4">
              <h3 className="text-sm font-medium text-gray-400 mb-2">Total PnL</h3>
              <div className="space-y-2">
                <div>
                  <p className="text-lg font-bold">${stats?.totalPnL?.toFixed(2) || '0.00'}</p>
                  <p className="text-xs text-gray-500">{stats?.pnlPercent?.toFixed(2) || '0.00'}%</p>
                </div>
              </div>
            </div>
          </div>

          {/* Main Content Grid */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            {/* Left Column - Stats */}
            <div className="lg:col-span-2 space-y-6">
              {/* Aggregate Stats */}
              <div>
                <h2 className="text-xl font-bold mb-4">Aggregate</h2>
                <div className="grid grid-cols-3 gap-4">
                  <StatsCard
                    title="Total Volume (24h)"
                    value={`${stats?.totalVolume?.toFixed(2) || '0.00'} SOL`}
                    subtitle={`${stats?.totalTransactions || 0} transactions`}
                  />
                  <StatsCard
                    title="Total SOL"
                    value={`${stats?.totalSol?.toFixed(2) || '0.00'} SOL`}
                  />
                  <StatsCard
                    title="Token Count"
                    value={stats?.totalTokens || 0}
                  />
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
            </div>

            {/* Right Column - Trading Controls */}
            <div>
              <TradingControls
                config={config}
                onConfigChange={(updates) => setConfig({ ...config!, ...updates })}
                onExecuteBuy={() => addLog('Execute Buy clicked')}
                onPause={() => setIsRunning(false)}
                onResume={() => setIsRunning(true)}
                onForceSell={() => addLog('Force Sell clicked')}
                isRunning={isRunning}
              />
            </div>
          </div>
        </div>
      </main>

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

      {/* Add Wallet Modal */}
      {showWalletModal && (
        <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50">
          <div className="bg-surface border border-gray-700 rounded-2xl p-6 w-full max-w-md">
            <div className="flex justify-between items-center mb-4">
              <h3 className="text-lg font-bold">Add Wallet</h3>
              <button onClick={() => {
                setShowWalletModal(false);
                setNewWalletAddress('');
                setNewWalletLabel('');
                setCreateNewWallet(false);
              }} className="text-gray-400 hover:text-white"><X/></button>
            </div>
            <div className="space-y-4">
              <div className="flex gap-2">
                <button
                  onClick={() => {
                    setCreateNewWallet(false);
                    setNewWalletAddress('');
                    setNewWalletPrivateKey('');
                  }}
                  className={`flex-1 px-4 py-2 rounded-lg font-bold ${
                    !createNewWallet ? 'bg-primary text-white' : 'bg-gray-700 text-gray-300'
                  }`}
                >
                  Add Existing
                </button>
                <button
                  onClick={handleGenerateWallet}
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
                      type="password"
                      value={newWalletPrivateKey}
                      readOnly
                      className="flex-1 bg-background border border-gray-700 rounded px-2 py-1 text-xs font-mono"
                    />
                  </div>
                </div>
              )}
              
              <div>
                <label className="text-xs text-gray-400 block mb-1">Wallet Address</label>
                <input
                  type="text"
                  value={newWalletAddress}
                  onChange={(e) => setNewWalletAddress(e.target.value)}
                  onFocus={() => {
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
              <div>
                <label className="text-xs text-gray-400 block mb-1">Select Group</label>
                <select
                  value={selectedGroup}
                  onChange={(e) => setSelectedGroup(e.target.value)}
                  className="w-full bg-background border border-gray-700 rounded-lg px-3 py-2 text-sm"
                >
                  <option value="">Select a group</option>
                  {groups.map(g => (
                    <option key={g.id} value={g.id}>{g.name}</option>
                  ))}
                </select>
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
    </div>
  );
};

export default MarketMaker;

