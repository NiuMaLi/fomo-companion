import Decimal from 'decimal.js';
import { ExecutionError, SOLANA_NETWORK, USDC_ADDRESS, USDC_ID, type ExecutionRequest } from '../shared/execution';
import { assetKey } from '../shared/model';

export type Prepare = Extract<ExecutionRequest, { action: 'prepare' }>;
const d = (v: string | number) => new Decimal(v);
export function quoteRequest(request: Prepare) {
  const { order } = request, buy = order.kind === 'limit-buy';
  const decimals = buy ? 6 : order.asset.decimals;
  if (decimals === undefined) throw new ExecutionError('precision', '缺少代币精度，请刷新代币信息后重新建单');
  const human = d((buy ? order.amountUsd : order.quantity) ?? '0');
  const atomic = human.mul(d(10).pow(decimals));
  if (!atomic.isInteger() || !atomic.gt(0)) throw new ExecutionError('amount', '交易金额或数量不符合代币精度');
  const token = assetKey(order.asset);
  return { inTokenId: buy ? USDC_ID : token, outTokenId: buy ? token : USDC_ID, amount: atomic.toFixed(0), retry: 0, ...(request.slippageBps && request.slippageBps > 0 ? { slippageBps: request.slippageBps } : {}) };
}
// An absent/zero cap omits the custom platform parameter and disables the local
// slippage cap. Limit targets still check the expected quote; stop losses do not
// apply a quote deviation cap in this mode. Platform transaction limits remain.
// Source-independent quote checks. The platform chooses origin chain and routing
// from its USDC cash pool; the target asset's network is not a local allowlist.
export function parseRoutedQuote(body: any, request: Prepare, livePrice: string) {
  if (!body?.success) {
    const minimum = body?.errorCode === 'ERR_SWAP_BELOW_MINIMUM';
    throw new ExecutionError(minimum ? 'minimum' : 'quote', minimum ? '交易金额低于平台当前最低金额' : 'FOMO 未返回可执行报价', !minimum);
  }
  const payload = body.responseObject;
  const raw = payload?.source === 'solana' ? payload.v1Swap : payload?.source === 'relay' ? payload.v2Swap : payload?.source === 'mobula' ? payload.mobulaSwap : undefined;
  if (!raw || !['SOLANA', 'EVM'].includes(payload.originChainType)) throw new ExecutionError('route', '平台未返回可识别的交易路线');
  const expected = d(String(raw.expectedOutHumanAmount ?? '0'));
  const maximum = request.slippageBps ?? 0;
  const bps = maximum > 0 ? Number(raw.dynamicSlippageBps ?? payload.tradeInfo?.slippageBps ?? maximum) : 0;
  if (!expected.isFinite() || !expected.gt(0) || !Number.isInteger(bps) || bps < 0 || bps > maximum) throw new ExecutionError('quote-format', '报价数量或滑点无法校验');
  const buy = request.order.kind === 'limit-buy', input = d((buy ? request.order.amountUsd : request.order.quantity)!);
  const minimumOut = expected.mul(d(1).minus(d(bps).div(10000)));
  const worstPrice = buy ? input.div(minimumOut) : minimumOut.div(input), target = d(request.order.targetPrice);
  if (buy ? worstPrice.gt(target) : request.order.kind === 'stop-loss' ? maximum > 0 && worstPrice.lt(d(livePrice).mul(d(1).minus(d(maximum).div(10000)))) : worstPrice.lt(target))
    throw new ExecutionError('target', maximum > 0 ? '含滑点的报价尚未满足目标价格，等待下一次报价' : '报价尚未满足目标价格，等待下一次报价', true);
  if (raw.priceImpactPct !== undefined && (!Number.isFinite(raw.priceImpactPct) || Math.abs(raw.priceImpactPct) > .05)) throw new ExecutionError('impact', '报价价格影响超过 5%，已阻止下单');
  return { payload, raw, priceUsd: (buy ? input.div(expected) : expected.div(input)).toFixed(),
    quantity: buy ? expected.toFixed() : input.toFixed(), amountUsd: buy ? input.toFixed() : expected.toFixed() };
}
export function parseQuote(body: any, request: Prepare, livePrice: string) {
  if (!body?.success) {
    const minimum = body?.errorCode === 'ERR_SWAP_BELOW_MINIMUM';
    throw new ExecutionError(minimum ? 'minimum' : 'quote', minimum ? '交易金额低于平台当前最低金额' : 'FOMO 未返回可执行报价', !minimum);
  }
  const payload = body.responseObject, raw = payload?.v1Swap;
  if (payload?.source !== 'solana' || payload?.originChainType !== 'SOLANA' || !raw || raw.jitoTipTx) throw new ExecutionError('route', '此报价需要尚未支持的跨链或捆绑执行路线');
  const expected = d(String(raw.expectedOutHumanAmount ?? '0'));
  const maximum = request.slippageBps ?? 0;
  const bps = maximum > 0 ? Number(raw.dynamicSlippageBps ?? payload.tradeInfo?.slippageBps) : 0;
  if (!expected.isFinite() || !expected.gt(0) || !Number.isInteger(bps) || bps < 0 || bps > maximum ||
    !Number.isSafeInteger(raw.lastValidBlockHeight) || typeof raw.swapTransaction !== 'string' || raw.swapTransaction.length > 5500 ||
    typeof raw.feePayerSignature !== 'string' || typeof raw.feePayerAddress !== 'string') throw new ExecutionError('quote-format', '报价字段、有效期或滑点无法校验');
  if (raw.priceImpactPct !== undefined && (!Number.isFinite(raw.priceImpactPct) || Math.abs(raw.priceImpactPct) > .05)) throw new ExecutionError('impact', '报价价格影响超过 5%，已阻止下单');
  const minimumOut = expected.mul(d(1).minus(d(bps).div(10000))), buy = request.order.kind === 'limit-buy';
  const input = d((buy ? request.order.amountUsd : request.order.quantity)!);
  const worstPrice = buy ? input.div(minimumOut) : minimumOut.div(input);
  const target = d(request.order.targetPrice);
  if (buy ? worstPrice.gt(target) : request.order.kind === 'stop-loss' ? maximum > 0 && worstPrice.lt(d(livePrice).mul(d(1).minus(d(maximum).div(10000)))) : worstPrice.lt(target)) {
    throw new ExecutionError('target', maximum > 0 ? '含滑点的报价尚未满足目标价格，等待下一次报价' : '报价尚未满足目标价格，等待下一次报价', true);
  }
  const price = buy ? input.div(expected) : expected.div(input);
  return { transaction: raw.swapTransaction as string, feePayerAddress: raw.feePayerAddress as string, feePayerSignature: raw.feePayerSignature as string,
    lastValidBlockHeight: raw.lastValidBlockHeight as number, priceUsd: price.toFixed(),
    quantity: buy ? expected.toFixed() : input.toFixed(), amountUsd: buy ? input.toFixed() : expected.toFixed() };
}
