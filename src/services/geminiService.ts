
import { GoogleGenAI } from "@google/genai";
import { TradeConfig, WalletGroup } from "../types";

export const analyzeStrategyRisk = async (
  config: TradeConfig,
  groups: WalletGroup[],
  recentVolume: number
): Promise<string> => {
  const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
  
  // Summarize strategy
  const strategySummary = groups.map(g => ({
    group: g.name,
    walletCount: g.wallets.length,
    isActive: g.isActive,
    phase: g.phase,
    totalSol: g.wallets.reduce((acc, w) => acc + w.balanceSol, 0).toFixed(2),
    totalTokens: g.wallets.reduce((acc, w) => acc + w.balanceTokens, 0).toLocaleString()
  }));

  const prompt = `
    Analyze the following high-frequency "Profit Builder" algorithmic trading configuration for Solana.
    
    Token Address: ${config.monitoredTokenAddress || 'Not Set'}
    Target Market Cap: $${config.targetMarketCapSell.toLocaleString()}
    
    PROFIT BUILDER STRATEGY:
    - Initial Buy: ${config.strategy.initialBuySolPct}% of allocated SOL
    - Intruder Trigger: > ${config.strategy.intruderTriggerPct}% of Supply
    - Defense Action: Sell ${config.strategy.groupSellPctMin}-${config.strategy.groupSellPctMax}% of Token Holdings
    - Target Supply Buy: ${config.strategy.targetSupplyBuyMin}-${config.strategy.targetSupplyBuyMax}% of Supply per Cycle
    - Cycling: Wallets sell until tokens=0, then sweep principal back to Funding Wallet and Retire. Next Group activates.
    - Cycle Pause: ${config.strategy.cyclePauseTimeSec} seconds delay between cycles.
    
    Active Groups:
    ${JSON.stringify(strategySummary, null, 2)}

    Provide a risk assessment focusing on:
    1. Selling pressure impact on the bonding curve given the tiered sell-off.
    2. Liquidity risks when switching from Group A to Group B.
    3. Suggest optimization for the "Profit Builder" percentage parameters.
  `;

  try {
    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: prompt,
    });
    return response.text || "Analysis failed to generate text.";
  } catch (error) {
    console.error("Gemini Analysis Error:", error);
    return "Unable to perform AI analysis at this time.";
  }
};
