import { assetKey, type Asset, type Session } from './model';

// FOMO's route/network mapping, verified against its public chain module (2026-10-19).
// Unknown routes must never fall back to another network.
export const FOMO_CHAINS: Record<string, number> = {
  ethereum: 1, bnb: 56, monad: 143, robinhood: 4663,
  arc: 5042, base: 8453, solana: 1399811149,
};
export const SUPPORTED_CHAINS_HEADER = Object.values(FOMO_CHAINS).join(',');
export function transactionUrl(hash: string, networkId: number) {
  const explorers: Record<number, string> = { 1: 'https://etherscan.io', 56: 'https://bscscan.com', 143: 'https://monadscan.com',
    4663: 'https://robinhoodchain.blockscout.com', 5042: 'https://explorer.arc.io', 8453: 'https://basescan.org', 1399811149: 'https://solscan.io' };
  return explorers[networkId] ? `${explorers[networkId]}/tx/${encodeURIComponent(hash)}` : undefined;
}
export function assetFromPath(path: string): Asset | undefined {
  const match = /^\/tokens\/([a-z]+)\/([^/]+)\/?$/.exec(path);
  if (!match) return;
  const networkId = Object.hasOwn(FOMO_CHAINS, match[1]!) ? FOMO_CHAINS[match[1]!] : undefined;
  if (!networkId) return;
  const address = match[2]!;
  if (match[1] === 'solana' ? !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address) : !/^0x[0-9a-fA-F]{40}$/.test(address)) return;
  const tokenAddress = address.startsWith('0x') ? address.toLowerCase() : address;
  return { tokenAddress, networkId, symbol: `${tokenAddress.slice(0, 4)}…${tokenAddress.slice(-4)}` };
}
export function minimumFor(session: Session, asset: Pick<Asset, 'networkId'>) {
  const all = session.minimumsByNetwork;
  return all ? all[String(asset.networkId)] ?? all.default ?? { buy: '2', sell: '2' }
    : { buy: session.minimumBuyUsd, sell: session.minimumSellUsd };
}
export function matchesTicker(ticker: string | undefined, asset: Asset) {
  const parts = ticker?.split(':');
  return !!parts && parts.length === 2 && assetKey({ tokenAddress: parts[0]!, networkId: Number(parts[1]) }) === assetKey(asset);
}
