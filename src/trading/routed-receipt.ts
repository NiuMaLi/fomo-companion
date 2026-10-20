import Decimal from 'decimal.js';
import { SOLANA_NETWORK, transactionHashSchema, type ExecutionRequest, type ExecutionResult } from '../shared/execution';
import { assetKey } from '../shared/model';

type Request = Extract<ExecutionRequest, { action: 'receipt' }>;
const sameHash = (a: string, b: string) => a.startsWith('0x') && b.startsWith('0x') ? a.toLowerCase() === b.toLowerCase() : a === b;
const id = (address: string, network: number) => assetKey({ tokenAddress: address, networkId: network });

// Never associate fills by timestamp, expected output, or changes in total position.
// The platform's indexed signature must match a proven route transaction hash.
export function indexedFill(detail: any, request: Request, hashes: string[]): ExecutionResult | undefined {
  if (detail?.userId !== request.accountId || !request.reference || !request.kind) return;
  const buy = request.kind === 'limit-buy';
  for (const swap of detail.swaps ?? []) {
    if (typeof swap.signature !== 'string' || !hashes.some(hash => sameHash(hash, swap.signature))) continue;
    if (id(swap.inTokenAddress, swap.inNetworkId) !== request.reference.inTokenId || id(swap.outTokenAddress, swap.outNetworkId) !== request.reference.outTokenId) continue;
    if (id(buy ? swap.outTokenAddress : swap.inTokenAddress, buy ? swap.outNetworkId : swap.inNetworkId) !== assetKey(request.asset)) continue;
    try {
      const quantity = new Decimal(String(buy ? swap.outHumanAmount : swap.inHumanAmount));
      const usd = new Decimal(String(buy ? swap.humanUsdAmountIn : swap.humanUsdAmountOut));
      if (!quantity.isFinite() || !usd.isFinite() || !quantity.gt(0) || !usd.gt(0)) continue;
      return { state: 'confirmed', direction: buy ? 'buy' : 'sell', quantity: quantity.toFixed(), amountUsd: usd.toFixed(), priceUsd: usd.div(quantity).toFixed() };
    } catch { /* Incomplete indexing is pending, never a fabricated fill. */ }
  }
}

export async function routedReceipt(request: Request, io: {
  json: (url: string, init?: RequestInit, authenticated?: boolean) => Promise<any>;
  account: () => string | undefined;
  direct: (request: Request) => Promise<ExecutionResult>;
}): Promise<ExecutionResult> {
  if (io.account() !== request.accountId || !request.reference) return { state: 'pending' };
  const reference = { ...request.reference };
  let hash = request.transactionHash;
  const rpc = async (url: string, method: string, params: unknown[]) => {
    const b = await io.json(url, { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) }, true);
    if (b.error) throw new Error('Receipt RPC unavailable');
    return b.result;
  };
  if (reference.userOperationHash && reference.originNetworkId !== SOLANA_NETWORK) {
    const receipt = await rpc(`https://bundler.prod-edge.fomo.family/v2/${reference.originNetworkId}/rpc`, 'eth_getUserOperationReceipt', [reference.userOperationHash]);
    if (receipt?.success === false) return { state: 'failed', reference, message: '链上智能账户交易执行失败' };
    if (transactionHashSchema.safeParse(receipt?.receipt?.transactionHash).success) hash = receipt.receipt.transactionHash;
  }
  if (reference.source === 'solana') return hash ? io.direct({ ...request, transactionHash: hash, reference: undefined }) : { state: 'pending', reference };
  const statusPath = reference.source === 'relay' && reference.relaySwapId
    ? `/swaps/v2/status?relaySwapId=${encodeURIComponent(reference.relaySwapId)}`
    : reference.source === 'mobula' && reference.intentId ? `/swaps/v3/status?provider=mobula&intentId=${encodeURIComponent(reference.intentId)}&wait=true` : undefined;
  if (!statusPath) return { state: 'pending', reference, transactionHash: hash };
  const response = await io.json(`https://prod-api.fomo.family${statusPath}`);
  const status = response?.success ? response.responseObject : undefined;
  if (status?.status === 'FAILED') return { state: 'failed', reference, transactionHash: hash, message: '平台确认路线执行失败；请核对退款与账户余额' };
  if (status?.status !== 'SUCCESS') return { state: 'pending', reference, transactionHash: hash };
  const hashes = hash ? [hash] : [];
  if (reference.source === 'relay') {
    const routes = await io.json(`https://api.relay.link/requests/v2?id=${encodeURIComponent(reference.relaySwapId!)}`);
    const route = routes?.requests?.find((item: any) => item.id === reference.relaySwapId);
    if (route?.status !== 'success') return { state: 'pending', reference, transactionHash: hash };
    const input = route.data?.inTxs ?? [], output = route.data?.outTxs ?? [];
    // The persisted request ID identifies this intent even when the worker lost the
    // submission response. An unrelated supplied origin hash must never be accepted.
    if (hash && !input.some((tx: any) => Number(tx.chainId) === reference.originNetworkId && sameHash(String(tx.hash), hash!))) return { state: 'pending', reference, transactionHash: hash };
    for (const tx of [...input, ...output]) if (transactionHashSchema.safeParse(tx.hash).success) hashes.push(tx.hash);
    if (!hash) hash = input.find((tx: any) => Number(tx.chainId) === reference.originNetworkId && transactionHashSchema.safeParse(tx.hash).success)?.hash;
  } else {
    // Mobula responses may expose settlement hashes as indexing progresses. Keep
    // the intent pending if the platform has not provided an exact association.
    for (const value of [status.txHash, status.transactionHash, status.originTxHash, status.destinationTxHash]) {
      if (transactionHashSchema.safeParse(value).success) hashes.push(value);
    }
  }
  if (!hashes.length) return { state: 'pending', reference };
  let cursor: string | undefined;
  for (let page = 0; page < 3; page++) {
    const query = new URLSearchParams({ userId: request.accountId, tokenAddress: request.asset.tokenAddress, networkId: String(request.asset.networkId), orderBy: 'closedAt' });
    if (cursor) query.set('lastTradeId', cursor);
    const list = await io.json(`https://prod-api.fomo.family/trades?${query}`);
    if (!list?.success) break;
    const rows = [...(list.responseObject?.activeTrades ?? []), ...(list.responseObject?.closedTrades ?? [])];
    for (const row of rows.slice(0, 8)) {
      if (typeof row.trade?.id !== 'string') continue;
      const body = await io.json(`https://prod-api.fomo.family/trades/${encodeURIComponent(row.trade.id)}`);
      if (!body?.success) continue;
      const fill = indexedFill(body.responseObject, request, hashes);
      if (!fill || io.account() !== request.accountId) continue;
      try {
        const balance = await io.json(`https://prod-api.fomo.family/v2/users/${encodeURIComponent(request.accountId)}/balances`);
        if (balance?.success && Array.isArray(balance.responseObject?.balances)) {
          const entries = balance.responseObject.balances.filter((entry: any) => {
            const token = entry.tokenFilterResult?.token;
            return token && id(token.address, token.networkId) === assetKey(request.asset);
          });
          // An absent row is unknown: an index can temporarily omit a position.
          if (entries.length) fill.remainingQuantity = entries.reduce((sum: Decimal, e: any) => sum.plus(String(e.balance?.shiftedBalance ?? e.userToken?.humanAmountRemaining)), new Decimal(0)).toFixed();
        }
      } catch { /* Keep a proven fill even if the remaining position is unavailable. */ }
      return { ...fill, reference, transactionHash: hash };
    }
    cursor = rows.at(-1)?.trade?.id;
    if (!list.responseObject?.hasNextPage || !cursor) break;
  }
  return { state: 'pending', reference, transactionHash: hash, message: '路线已完成，等待可精确关联的真实成交索引' };
}
