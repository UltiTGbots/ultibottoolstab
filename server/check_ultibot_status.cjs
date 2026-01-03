const Database = require('better-sqlite3');
const db = new Database('./shadowcash.sqlite');

console.log('🔍 ULTIBOT CONFIGURATION CHECK:');
const config = db.prepare('SELECT enabled, dry_run, token_mint, wallets_per_cycle, buy_sol_per_wallet_lamports, use_privacy_mode FROM ultibot_config WHERE id=1').get();
console.log('Enabled:', config.enabled);
console.log('Dry Run:', config.dry_run);
console.log('Token Mint:', config.token_mint);
console.log('Wallets per Cycle:', config.wallets_per_cycle);
console.log('SOL per Wallet:', (config.buy_sol_per_wallet_lamports / 1000000000).toFixed(6) + ' SOL');
console.log('Privacy Mode:', config.use_privacy_mode);

console.log('\n🔍 BOT STATE:');
const state = db.prepare('SELECT running, last_error FROM ultibot_state WHERE id=1').get();
console.log('Running:', state.running);
console.log('Last Error:', state.last_error);

console.log('\n🔍 RECENT CYCLES:');
const cycles = db.prepare('SELECT id, status, created_at_ms FROM ultibot_cycles ORDER BY created_at_ms DESC LIMIT 3').all();
cycles.forEach(cycle => {
  console.log('Cycle', cycle.id + ':', cycle.status, '| Created:', new Date(cycle.created_at_ms).toLocaleString());
});

console.log('\n🔍 RECENT WALLETS:');
const wallets = db.prepare('SELECT id, cycle_id, pubkey, status FROM ultibot_wallets ORDER BY id DESC LIMIT 5').all();
wallets.forEach(wallet => {
  console.log('Wallet', wallet.id + ':', wallet.status, '| Pubkey:', wallet.pubkey.substring(0,8) + '...');
});

db.close();
