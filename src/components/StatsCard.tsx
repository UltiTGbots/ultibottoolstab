import React from 'react';

interface StatsCardProps {
  label: string;
  value: string;
  subValue?: string;
  trend?: 'up' | 'down' | 'neutral';
  icon?: React.ReactNode;
}

const StatsCard: React.FC<StatsCardProps> = ({ label, value, subValue, trend, icon }) => {
  return (
    <div className="bg-surface border border-gray-700 rounded-xl p-5 shadow-lg flex items-start justify-between">
      <div>
        <p className="text-muted text-sm font-medium mb-1">{label}</p>
        <h3 className="text-2xl font-bold text-white">{value}</h3>
        {subValue && (
          <p className={`text-xs mt-1 ${trend === 'up' ? 'text-primary' : trend === 'down' ? 'text-accent' : 'text-gray-400'}`}>
            {subValue}
          </p>
        )}
      </div>
      {icon && (
        <div className="bg-gray-800 p-2 rounded-lg text-gray-400">
          {icon}
        </div>
      )}
    </div>
  );
};

export default StatsCard;
