import { SOL_ASSET } from './fixtures';
import { expect, it, vi } from 'vitest';

it('在禁止动态代码生成的页面中仍可校验真实元数据和建单消息', async () => {
  vi.stubGlobal('Function', function () { throw new EvalError('unsafe-eval blocked'); });
  try {
    const { commandSchema, feedSchema } = await import('../src/shared/model');
    const { assetFromToken } = await import('../src/shared/token-metadata');
    const asset = assetFromToken({ address: SOL_ASSET.tokenAddress, networkId: SOL_ASSET.networkId, symbol: 'SOL', decimals: 9, info: { imageThumbUrl: 'https://example.org/sol.png' } });
    expect(asset?.logoUrl).toBe('https://example.org/sol.png');
    expect(feedSchema.safeParse({ type: 'context', asset }).success).toBe(true);
    expect(commandSchema.safeParse({ type: 'create', draft: { asset, kind: 'limit-buy', targetPrice: '100', amountUsd: '9' } }).success).toBe(true);
  } finally { vi.unstubAllGlobals(); }
});
