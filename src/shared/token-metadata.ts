import { assetSchema, type Asset } from './model';

// API metadata only; never derive an asset identity from a ticker or an image URL.
export function assetFromToken(token: any): Asset | undefined {
  if (!token || typeof token.address !== 'string') return;
  const image = [token.info?.imageThumbUrl, token.info?.imageSmallUrl, token.info?.imageLargeUrl]
    .find(v => typeof v === 'string' && v.startsWith('https://'));
  const parsed = assetSchema.safeParse({
    tokenAddress: token.address.startsWith('0x') ? token.address.toLowerCase() : token.address, networkId: token.networkId,
    symbol: String(token.symbol || token.address.slice(0, 6)).slice(0, 40),
    name: typeof token.name === 'string' ? token.name.slice(0, 200) : undefined,
    decimals: Number.isInteger(token.decimals) && token.decimals >= 0 && token.decimals <= 30 ? token.decimals : undefined,
    logoUrl: image,
  });
  return parsed.success ? parsed.data : undefined;
}
