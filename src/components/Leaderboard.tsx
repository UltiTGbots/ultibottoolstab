import React, { useState, useEffect } from 'react';
import { Trophy, Users, DollarSign } from './Icons';

interface LeaderboardEntry {
  promo_code: string;
  referrals_count: number;
  referred_volume_sol: number;
  twitter_handle?: string;
  tiktok_handle?: string;
  facebook_handle?: string;
  wallet?: string;
}

export const Leaderboard: React.FC = () => {
  const [entries, setEntries] = useState<LeaderboardEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [sortBy, setSortBy] = useState<'referrals' | 'volume'>('referrals');

  useEffect(() => {
    fetchLeaderboard();
    const interval = setInterval(fetchLeaderboard, 10000); // Refresh every 10s
    return () => clearInterval(interval);
  }, []);

  const fetchLeaderboard = async () => {
    try {
      const res = await fetch('/api/leaderboard');
      const data = await res.json();
      setEntries(data);
      setLoading(false);
    } catch (err) {
      console.error('Failed to fetch leaderboard:', err);
      setLoading(false);
    }
  };

  const sortedEntries = [...entries].sort((a, b) => {
    if (sortBy === 'referrals') {
      return b.referrals_count - a.referrals_count;
    }
    return b.referred_volume_sol - a.referred_volume_sol;
  });

  const getDisplayName = (entry: LeaderboardEntry) => {
    if (entry.twitter_handle) return `@${entry.twitter_handle}`;
    if (entry.tiktok_handle) return `@${entry.tiktok_handle}`;
    if (entry.facebook_handle) return entry.facebook_handle;
    if (entry.wallet) return `${entry.wallet.substring(0, 4)}...${entry.wallet.substring(entry.wallet.length - 4)}`;
    return entry.promo_code;
  };

  return (
    <div className="bg-surface border border-gray-700 rounded-xl p-6">
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-2">
          <Trophy className="h-6 w-6 text-yellow-500" />
          <h2 className="text-xl font-bold">Referral Leaderboard</h2>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => setSortBy('referrals')}
            className={`px-4 py-2 rounded-lg text-sm font-bold transition-all ${
              sortBy === 'referrals'
                ? 'bg-primary text-white'
                : 'bg-gray-800 text-gray-400 hover:bg-gray-700'
            }`}
          >
            <Users className="h-4 w-4 inline mr-1" />
            Referrals
          </button>
          <button
            onClick={() => setSortBy('volume')}
            className={`px-4 py-2 rounded-lg text-sm font-bold transition-all ${
              sortBy === 'volume'
                ? 'bg-primary text-white'
                : 'bg-gray-800 text-gray-400 hover:bg-gray-700'
            }`}
          >
            <DollarSign className="h-4 w-4 inline mr-1" />
            Volume
          </button>
        </div>
      </div>

      {loading ? (
        <div className="text-center py-8 text-gray-400">Loading leaderboard...</div>
      ) : sortedEntries.length === 0 ? (
        <div className="text-center py-8 text-gray-400">No referrals yet. Be the first!</div>
      ) : (
        <div className="space-y-2">
          {sortedEntries.map((entry, idx) => (
            <div
              key={entry.promo_code}
              className="flex items-center justify-between p-4 bg-background rounded-lg border border-gray-800 hover:border-gray-700 transition-all"
            >
              <div className="flex items-center gap-4">
                <div className={`w-8 h-8 rounded-full flex items-center justify-center font-bold text-sm ${
                  idx === 0 ? 'bg-yellow-500 text-black' :
                  idx === 1 ? 'bg-gray-400 text-black' :
                  idx === 2 ? 'bg-orange-600 text-white' :
                  'bg-gray-800 text-gray-400'
                }`}>
                  {idx + 1}
                </div>
                <div>
                  <div className="font-bold">{getDisplayName(entry)}</div>
                  <div className="text-xs text-gray-500">Code: {entry.promo_code}</div>
                </div>
              </div>
              <div className="flex items-center gap-6">
                <div className="text-right">
                  <div className="text-sm text-gray-400">Referrals</div>
                  <div className="font-bold text-lg">{entry.referrals_count}</div>
                </div>
                <div className="text-right">
                  <div className="text-sm text-gray-400">Volume</div>
                  <div className="font-bold text-lg">{entry.referred_volume_sol.toFixed(2)} SOL</div>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

