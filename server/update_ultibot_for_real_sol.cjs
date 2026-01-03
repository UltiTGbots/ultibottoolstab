const Database = require('better-sqlite3');
const db = new Database('./shadowcash.sqlite');

console.log('🔄 UPDATING ULTIBOT FOR REAL SOL TESTING...\n');

// Update main configuration for real SOL testing
console.log('📝 Updating UltiBot configuration...');

// Option 1: Use SOL directly
const SOL_TOKEN = "So11111111111111111111111111111111111111112";

// Option 2: Use USDC for stable testing
// const SOL_TOKEN = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

try {
  // Update configuration for real testing
  const updateConfig = db.prepare(`
    UPDATE ultibot_config SET
      token_mint = ?,
      dry_run = 0,
      enabled = 1,
      wallets_per_cycle = 3,
      intruder_trigger_pct = 5,
      group_sell_pct_min = 15,
      group_sell_pct_max = 25,
      buy_sol_per_wallet_lamports = 5000000
    WHERE id = 1
  `);

  const result = updateConfig.run(SOL_TOKEN);
  console.log(`✅ Updated configuration: ${result.changes} row(s) affected`);

  // Clear any existing state
  const clearState = db.prepare(`
    UPDATE ultibot_state SET
      running = 0,
      last_error = NULL,
      last_tick_ms = NULL
    WHERE id = 1
  `);
  clearState.run();
  console.log('✅ Cleared bot state');

  // Mark any running cycles as complete
  const completeCycles = db.prepare(`
    UPDATE ultibot_cycles SET
      status = 'COMPLETE',
      ended_at_ms = ?
    WHERE status = 'RUNNING'
  `);
  const now = Date.now();
  const cycleResult = completeCycles.run(now);
  console.log(`✅ Completed ${cycleResult.changes} running cycle(s)`);

  // Verify the configuration
  console.log('\n🔍 VERIFICATION:');
  const config = db.prepare('SELECT * FROM ultibot_config WHERE id = 1').get();
  console.log(`  Token Mint: ${config.token_mint}`);
  console.log(`  Enabled: ${config.enabled}`);
  console.log(`  Dry Run: ${config.dry_run}`);
  console.log(`  Wallets per Cycle: ${config.wallets_per_cycle}`);
  console.log(`  SOL per Wallet: ${config.buy_sol_per_wallet_lamports / 1_000_000_000} SOL`);

} catch (error) {
  console.error('❌ Error updating configuration:', error.message);
}

db.close();

console.log('\n🎯 NEXT STEPS FOR REAL SOL TESTING:');
console.log('1. Set your FUNDING wallet private key in UltiBot UI');
console.log('2. Optionally set PROFIT wallet private key');
console.log('3. Enable Privacy Mode for anonymous transfers');
console.log('4. Start UltiBot from the UI');
console.log('5. Monitor the first cycle closely');
console.log('\n⚠️  SAFETY: Starting with 0.005 SOL per wallet (~$0.10)');
console.log('🔄 Increase amounts only after successful testing');



