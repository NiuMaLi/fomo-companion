import Decimal from 'decimal.js';
import { NATIVE_SOL_ADDRESS, USDC_ADDRESS, type ExecutionResult } from '../shared/execution';
import type { Asset } from '../shared/model';

// A confirmed signature alone proves inclusion; token deltas prove the swap's actual result.
export function parseReceipt(raw: any, address: string, asset: Asset): ExecutionResult {
  if (!raw?.meta || !raw.transaction?.message || raw.meta.err) return { state: raw?.meta?.err ? 'failed' : 'pending', message: raw?.meta?.err ? '链上交易执行失败' : '等待链上交易详情' };
  const meta = raw.meta;
  const sum = (items: any[], mint: string) => (items ?? []).filter(item => item.owner === address && item.mint === mint)
      .reduce((value, item) => value.plus(new Decimal(String(item.uiTokenAmount.amount)).div(new Decimal(10).pow(item.uiTokenAmount.decimals))), new Decimal(0));
  const delta = (mint: string) => sum(meta.postTokenBalances, mint).minus(sum(meta.preTokenBalances, mint));
  try {
    let quantity = delta(asset.tokenAddress);
    let remaining = sum(meta.postTokenBalances, asset.tokenAddress);
    if (asset.tokenAddress === NATIVE_SOL_ADDRESS) {
      const keys = raw.transaction.message.accountKeys.map((key: string | { pubkey: string }) => typeof key === 'string' ? key : key.pubkey);
      const index = keys.indexOf(address);
      if (index < 0 || meta.postBalances[index] === undefined || meta.preBalances[index] === undefined) return { state: 'pending' };
      // If the user is fee payer, transaction fees are separate from the exchanged quantity.
      quantity = quantity.plus(new Decimal(String(meta.postBalances[index])).minus(String(meta.preBalances[index])).plus(index === 0 ? String(meta.fee) : '0').div(1e9));
      remaining = remaining.plus(new Decimal(String(meta.postBalances[index])).div(1e9));
    }
    const usd = delta(USDC_ADDRESS);
    if (quantity.isZero() || usd.isZero() || quantity.isPositive() === usd.isPositive()) return { state: 'pending', message: '已上链，等待核对代币实际变化' };
    return { state: 'confirmed', direction: quantity.isPositive() ? 'buy' : 'sell', quantity: quantity.abs().toFixed(), amountUsd: usd.abs().toFixed(), priceUsd: usd.div(quantity).abs().toFixed(), remainingQuantity: remaining.toFixed() };
  } catch { return { state: 'pending', message: '等待可校验的链上余额变化' }; }
}
