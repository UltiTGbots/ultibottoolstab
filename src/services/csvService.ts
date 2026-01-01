
import { Wallet, AnonPayRecipient } from "../types";

export const parseWalletCSV = async (fileContent: string, targetGroupId: string): Promise<Wallet[]> => {
  const lines = fileContent.split(/\r?\n/);
  const newWallets: Wallet[] = [];

  // Helper to remove quotes and whitespace
  const clean = (str: string | undefined) => str?.replace(/['"]/g, '').trim() || '';

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    
    // Skip headers case-insensitive
    if (line.toLowerCase().startsWith('label')) continue;

    const parts = line.split(',');
    if (parts.length < 2) continue;

    const label = clean(parts[0]);
    const address = clean(parts[1]);
    const balanceStr = clean(parts[2]);
    const balance = balanceStr ? parseFloat(balanceStr) : 10.0;

    // Basic validation
    if (address.length < 10) continue; 

    newWallets.push({
      id: `import-${Date.now()}-${i}-${Math.random().toString(36).substring(2, 6)}`,
      groupId: targetGroupId,
      address,
      label: label || `Wallet ${newWallets.length + 1}`,
      isWhitelisted: true,
      balanceSol: balance,
      initialBalanceSol: balance,
      balanceTokens: 0,
      status: 'ACTIVE'
    });
  }

  return newWallets;
};

export const parseAnonPayCSV = async (fileContent: string, defaultAmount: number): Promise<AnonPayRecipient[]> => {
  const lines = fileContent.split(/\r?\n/);
  const recipients: AnonPayRecipient[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    
    // Skip headers
    if (line.toLowerCase().startsWith('address') || line.toLowerCase().startsWith('recipient')) continue;

    const parts = line.split(',');
    const address = parts[0].replace(/['"]/g, '').trim();
    
    if (address.length < 10) continue; // Basic validation

    let amount = defaultAmount;
    if (parts.length > 1) {
        const parsed = parseFloat(parts[1].replace(/['"]/g, '').trim());
        if (!isNaN(parsed)) amount = parsed;
    }

    recipients.push({
      id: `csv-${Date.now()}-${i}-${Math.random().toString(36).substring(2,6)}`,
      address,
      amount,
      status: 'PENDING'
    });
  }
  return recipients;
};
