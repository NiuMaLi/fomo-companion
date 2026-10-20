import type { Asset } from '../shared/model';

// Historical v1 data had no asset field and only contained SOL.
// This identity is only for migration, never a product default.
export const LEGACY_SOL_ASSET: Asset = {
  tokenAddress: 'So11111111111111111111111111111111111111112',
  networkId: 1399811149, symbol: 'SOL', decimals: 9,
};
