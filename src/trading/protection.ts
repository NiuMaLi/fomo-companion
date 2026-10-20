import Decimal from 'decimal.js';
import type { Draft, Order } from '../shared/model';

export const activeOrder = (order: Order) => !order.legacy && ['waiting', 'preparing', 'signed', 'submitted', 'unknown'].includes(order.status);

// Two alternative exits reserve the larger leg, since only one can fill.
export function reservedQuantity(orders: Order[]) {
  const groups = new Map<string, Decimal>();
  for (const order of orders.filter(o => activeOrder(o) && o.kind !== 'limit-buy')) {
    const key = order.ocoGroupId ?? order.id;
    groups.set(key, Decimal.max(groups.get(key) ?? 0, order.quantity ?? 0));
  }
  return [...groups.values()].reduce((sum, quantity) => sum.plus(quantity), new Decimal(0));
}

export function validateProtection(draft: Draft) {
  if (!draft.protection) return;
  if (draft.kind !== 'limit-buy') throw new Error('附带止盈止损仅适用于限价买入');
  for (const [key, leg] of Object.entries(draft.protection)) {
    if (!leg) continue;
    const label = key === 'takeProfit' ? '止盈' : '止损';
    if (!new Decimal(leg.targetPrice).gt(0)) throw new Error(`${label}价格必须大于零`);
    if (!new Decimal(leg.sellPercent).gt(0) || new Decimal(leg.sellPercent).gt(100)) throw new Error(`${label}卖出比例应大于 0 且不超过 100%`);
    if (key === 'takeProfit' ? new Decimal(leg.targetPrice).lte(draft.targetPrice) : new Decimal(leg.targetPrice).gte(draft.targetPrice))
      throw new Error(`${label}价格应${key === 'takeProfit' ? '高' : '低'}于买入限价`);
  }
}

// Called inside the parent confirmation transaction. Stable IDs also prevent replay duplicates.
export function protectionOrders(parent: Order, now: number): Order[] {
  if (parent.kind !== 'limit-buy' || !parent.fillQuantity || !parent.protection) return [];
  return Object.entries(parent.protection).flatMap(([key, leg]) => {
    if (!leg) return [];
    const quantity = new Decimal(parent.fillQuantity!).mul(leg.sellPercent).div(100)
      .toDecimalPlaces(parent.asset.decimals ?? 9, Decimal.ROUND_DOWN).toFixed();
    return [{ id: `${parent.id}:${key}`, parentOrderId: parent.id, ocoGroupId: parent.id,
      accountId: parent.accountId, asset: parent.asset, kind: key === 'takeProfit' ? 'take-profit' : 'stop-loss',
      slippageBps: parent.slippageBps, targetPrice: leg.targetPrice, sellPercent: leg.sellPercent, quantity, createdAt: now,
      status: new Decimal(quantity).gt(0) ? 'waiting' : 'blocked',
      reason: new Decimal(quantity).gt(0) ? undefined : '本笔实买数量按比例舍入后不足代币精度，未启用保护单' } satisfies Order];
  });
}
