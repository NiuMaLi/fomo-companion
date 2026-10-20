import Decimal from 'decimal.js';
import { draftSchema, sameAsset, type Asset, type Draft, type Order, type Price, type Session } from '../shared/model';
import { readSettings, type DB } from '../storage/database';
import { reservedQuantity, validateProtection } from './protection';
import { orderSnapshot } from '../storage/logs';

const d = (v: string | number) => new Decimal(v);
export function percentage(target: string, baseline?: string): string | undefined {
  try { if (!baseline || !d(baseline).gt(0)) return; return d(target).div(baseline).minus(1).mul(100).toFixed(2); } catch { return; }
}
export function triggered(order: Pick<Order, 'kind' | 'targetPrice'>, price: string) {
  return order.kind === 'limit-buy' || order.kind === 'stop-loss' ? d(price).lte(order.targetPrice) : d(price).gte(order.targetPrice);
}
export function fresh(price: Price | undefined, now: number, maxAge: number): price is Price {
  return !!price && d(price.priceUsd).gt(0) && price.timestamp <= now + 5000 &&
    now - price.timestamp <= maxAge && now - price.receivedAt <= maxAge;
}
export function assetQuantity(session: Session, asset: Asset) {
  return session.positions.filter(p => sameAsset(p, asset)).reduce((total, p) => total.plus(p.quantity), d(0)).toFixed();
}
export async function createOrder(db: DB, raw: Draft, session: Session, price: Price, now = Date.now()) {
  const draft = draftSchema.parse(raw), settings = await readSettings(db);
  if (!fresh(price, now, settings.maxPriceAgeMs)) throw new Error('行情已过期，请等待新的报价');
  if (now - session.receivedAt > 45000) throw new Error('账户数据已过期，请刷新账户');
  if (!sameAsset(draft.asset, price)) throw new Error('币种已切换，请重新确认目标价格');
  if (!d(draft.targetPrice).gt(0)) throw new Error('目标价格必须大于零');
  validateProtection(draft);
  // Reservation checks and writes share one transaction to prevent concurrent overselling.
  const tx = db.transaction(['orders', 'logs'], 'readwrite');
  const old = await tx.objectStore('orders').getAll(), quantity = assetQuantity(session, draft.asset);
  let sellQuantity: string | undefined;
  const waiting = old.filter(o => o.accountId === session.accountId && sameAsset(o.asset, draft.asset) && ['waiting', 'preparing', 'signed', 'submitted', 'unknown'].includes(o.status) && !o.legacy);
  let failure: string | undefined;
  if (draft.kind === 'limit-buy') {
    if (!draft.amountUsd || !d(draft.amountUsd).gt(0)) failure = '买入金额必须大于零';
    else if (d(draft.amountUsd).div(draft.targetPrice).toDecimalPlaces(draft.asset.decimals ?? 9, Decimal.ROUND_DOWN).lte(0)) failure = '预计数量低于代币精度';
  } else {
    if (!draft.sellPercent || !d(draft.sellPercent).gt(0) || d(draft.sellPercent).gt(100)) failure = '卖出比例应大于 0 且不超过 100%';
    else {
      sellQuantity = d(quantity).mul(draft.sellPercent).div(100).toDecimalPlaces(draft.asset.decimals ?? 9, Decimal.ROUND_DOWN).toFixed();
      if (!d(sellQuantity).gt(0)) failure = '持仓不足或卖出数量低于代币精度';
      const reserved = reservedQuantity(waiting);
      if (reserved.plus(sellQuantity).gt(quantity)) failure = '持仓已被其他卖单预留，请先取消相关订单';
    }
  }
  if (failure) { await tx.done; throw new Error(failure); }
  const order: Order = { ...draft, slippageBps: draft.slippageBps ?? 0, id: crypto.randomUUID(), accountId: session.accountId, quantity: sellQuantity, createdAt: now, status: 'waiting' };
  await tx.objectStore('orders').put(order);
  await tx.objectStore('logs').put({ id: crypto.randomUUID(), at: now, category: 'trade', level: 'info', code: 'order-created',
    message: '条件单已保存，尚未提交交易', orderId: order.id, accountId: order.accountId, symbol: order.asset.symbol,
    order: orderSnapshot(order, { observedPrice: price.priceUsd, mode: settings.realTrading ? 'live' : 'monitor' }) });
  await tx.done;
  return order;
}

// Monitoring has no balance mutation and never declares an execution or a fill.
export async function evaluate(db: DB, session: Session, price: Price, now = Date.now()) {
  const settings = await readSettings(db);
  if (!settings.automatic || !fresh(price, now, settings.maxPriceAgeMs) || now - session.receivedAt > 45000) return;
  const tx = db.transaction(['orders', 'logs'], 'readwrite');
  for (const order of await tx.objectStore('orders').getAll()) {
    if (order.legacy || order.accountId !== session.accountId || !sameAsset(order.asset, price) || order.status !== 'waiting' || order.triggeredAt || !triggered(order, price.priceUsd)) continue;
    await tx.objectStore('orders').put({ ...order, triggeredAt: now });
    await tx.objectStore('logs').put({ id: crypto.randomUUID(), at: now, category: 'trade', level: 'info', code: 'target-reached',
      accountId: order.accountId, orderId: order.id, symbol: order.asset.symbol,
      order: orderSnapshot({ ...order, triggeredAt: now }, { observedPrice: price.priceUsd, mode: settings.realTrading ? 'live' : 'monitor' }),
      message: settings.realTrading ? '价格达到目标，等待真实执行校验' : '价格曾达到目标；真实下单关闭，未提交交易' });
  }
  await tx.done;
}
