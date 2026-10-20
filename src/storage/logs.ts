import type { Log, LogOrder, Order } from '../shared/model';
import type { DB } from './database';

// Do not pass request/response bodies or credentials to the logger.
export function redact(message: string) {
  return message.replace(/https?:\/\/[^\s]+/gi, '[链接已隐藏]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[凭据已隐藏]')
    .replace(/\b(Bearer\s+)\S+/gi, '$1[已隐藏]').slice(0, 500);
}
// Deliberately whitelist order facts. Never spread account, wallet, request, or
// execution context objects into an audit snapshot or its exported form.
export function orderSnapshot(order: Order, context: Pick<LogOrder, 'observedPrice' | 'mode'> = {}): LogOrder {
  const { asset, kind, status, slippageBps, targetPrice, amountUsd, quantity, sellPercent, createdAt, triggeredAt, submittedAt, confirmedAt,
    executionPrice, fillQuantity, fillUsd, remainingQuantity, transactionHash, parentOrderId, ocoGroupId, protection, reason } = order;
  return structuredClone({ asset: { symbol: asset.symbol, tokenAddress: asset.tokenAddress, networkId: asset.networkId, decimals: asset.decimals },
    kind, status, slippageBps, targetPrice, amountUsd, quantity, sellPercent, createdAt, triggeredAt, submittedAt, confirmedAt, executionPrice,
    fillQuantity, fillUsd, remainingQuantity, transactionHash, parentOrderId, ocoGroupId,
    protection: protection ? { ...(protection.takeProfit ? { takeProfit: { targetPrice: protection.takeProfit.targetPrice, sellPercent: protection.takeProfit.sellPercent } } : {}),
      ...(protection.stopLoss ? { stopLoss: { targetPrice: protection.stopLoss.targetPrice, sellPercent: protection.stopLoss.sellPercent } } : {}) } : undefined,
    reason: reason ? redact(reason) : undefined, transactionNetworkId: order.executionReference?.originNetworkId ?? asset.networkId,
    observedPrice: context.observedPrice, mode: context.mode });
}
export async function writeLog(db: DB, entry: Omit<Log, 'id' | 'at'> & { id?: string; at?: number }) {
  const log: Log = { ...entry, id: entry.id ?? crypto.randomUUID(), at: entry.at ?? Date.now(), message: redact(entry.message) };
  const tx = db.transaction('logs', 'readwrite');
  await tx.store.put(log);
  let extra = (await tx.store.count()) - 2000;
  let cursor = extra > 0 ? await tx.store.index('at').openCursor() : null;
  while (cursor && extra-- > 0) { await cursor.delete(); cursor = await cursor.continue(); }
  await tx.done;
  return log;
}
