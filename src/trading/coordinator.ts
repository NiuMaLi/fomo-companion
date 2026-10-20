import Decimal from 'decimal.js';
import { sameAsset, type Order, type Price, type Session } from '../shared/model';
import { ExecutionError, type ExecutionRequest, type ExecutionResult } from '../shared/execution';
import { readSettings, type DB } from '../storage/database';
import { orderSnapshot, writeLog } from '../storage/logs';
import { notify } from '../notifications/feishu';
import { fresh, triggered } from './engine';
import { protectionOrders } from './protection';

const unsettled = ['signed', 'submitted', 'unknown'];
export async function recoverExecution(db: DB) {
  const tx = db.transaction('orders', 'readwrite');
  for (const order of await tx.store.getAll()) {
    if (order.status === 'preparing') await tx.store.put({ ...order, status: 'failed', reason: '执行过程中后台重启；尚未发出提交指令，请核对后重新建单' });
    if (order.status === 'signed' || order.status === 'submitted') await tx.store.put({ ...order, status: 'unknown', reason: '正在恢复链上状态核对；不会重新签名或重复下单' });
  }
  await tx.done;
}

export function createCoordinator(options: {
  db: Promise<DB>; call: (tab: number, request: ExecutionRequest) => Promise<ExecutionResult>;
  allowed: (accountId: string, tab: number) => boolean;
  page: (accountId: string) => number | undefined;
  changed?: () => Promise<void>;
}) {
  const busy = new Set<string>(), querying = new Set<string>(), checked = new Map<string, number>();
  const update = async (id: string, patch: Partial<Order>) => {
    const db = await options.db, tx = db.transaction('orders', 'readwrite'), old = await tx.store.get(id);
    if (old) await tx.store.put({ ...old, ...patch });
    await tx.done;
  };
  const orderLog = async (order: Order, code: string, message: string, level: 'info' | 'warning' | 'error' = 'info') => {
    const db = await options.db, latest = await db.get('orders', order.id) ?? order;
    return writeLog(db, { accountId: order.accountId, orderId: order.id, symbol: order.asset.symbol, category: 'trade', code, message, level, order: orderSnapshot(latest, { mode: 'live' }) });
  };
  async function checkPermission(order: Order, tab: number) {
    const settings = await readSettings(await options.db);
    if (!settings.automatic || !settings.realTrading || !options.allowed(order.accountId, tab)) throw new ExecutionError('paused', '自动监控或真实下单已暂停，未继续提交');
    return settings;
  }
  async function sendFillNotice(order: Order) {
    if (!order.transactionHash || !order.confirmedAt || !order.notifyOrder || order.notificationHandled) return;
    await notify(await options.db, { channel: 'orders', orderId: order.id, accountId: order.accountId, symbol: order.asset.symbol,
      transactionHash: order.transactionHash, confirmedAt: order.confirmedAt, direction: order.kind === 'limit-buy' ? 'buy' : 'sell',
      priceUsd: order.executionPrice, quantity: order.fillQuantity, amountUsd: order.fillUsd, remainingQuantity: order.remainingQuantity });
    await update(order.id, { notificationHandled: true });
  }
  async function reconcileOne(order: Order, force = false) {
    if ((!order.transactionHash && !order.executionReference) || querying.has(order.id) || !force && Date.now() - (checked.get(order.id) ?? 0) < 5000) return;
    const tab = options.page(order.accountId);
    if (tab === undefined) return;
    querying.add(order.id); checked.set(order.id, Date.now());
    try {
      const result = await options.call(tab, { action: 'receipt', accountId: order.accountId, asset: order.asset, transactionHash: order.transactionHash, reference: order.executionReference, kind: order.kind, quantity: order.quantity, amountUsd: order.amountUsd });
      if (result.transactionHash || result.reference) await update(order.id, {
        ...(result.transactionHash ? { transactionHash: result.transactionHash } : {}),
        ...(result.reference ? { executionReference: result.reference } : {}),
      });
      if (result.state === 'failed') {
        await update(order.id, { status: 'failed', reason: result.message ?? '链上交易执行失败' });
        await orderLog(order, 'transaction-failed', '链上交易执行失败；没有自动重新下单', 'error');
        await notify(await options.db, { channel: 'alerts', code: 'transaction-failed', message: `${order.asset.symbol} 交易链上执行失败，请查看交易日志` });
      } else if (result.state === 'confirmed' && result.priceUsd && result.quantity && result.amountUsd) {
        const buy = order.kind === 'limit-buy';
        const directionValid = result.direction === (buy ? 'buy' : 'sell');
        const amountValid = buy ? new Decimal(result.amountUsd).lte(new Decimal(order.amountUsd!).plus('0.000001'))
          : new Decimal(result.quantity).lte(new Decimal(order.quantity!).plus(new Decimal(10).pow(-(order.asset.decimals ?? 9))));
        if (!directionValid || !amountValid) {
          await update(order.id, { status: 'unknown', reason: '链上已确认，但成交方向或数量需要人工核对；不会重复提交' });
          return;
        }
        const db = await options.db, settings = await readSettings(db), tx = db.transaction(['orders', 'logs'], 'readwrite');
        const old = await tx.objectStore('orders').get(order.id);
        if (!old || old.status === 'confirmed') { await tx.done; return; }
        const confirmed: Order = { ...old, status: 'confirmed', reason: undefined, confirmedAt: Date.now(), executedAt: Date.now(), executionPrice: result.priceUsd,
          transactionHash: result.transactionHash ?? old.transactionHash, executionReference: result.reference ?? old.executionReference,
          fillQuantity: result.quantity, fillUsd: result.amountUsd, remainingQuantity: result.remainingQuantity,
          notifyOrder: !!settings.notifications.ordersWebhook, notificationHandled: !settings.notifications.ordersWebhook };
        await tx.objectStore('orders').put(confirmed);
        for (const child of protectionOrders(confirmed, confirmed.confirmedAt!)) {
          await tx.objectStore('orders').put(child);
          await tx.objectStore('logs').put({ id: crypto.randomUUID(), at: Date.now(), category: 'trade', level: child.status === 'blocked' ? 'warning' : 'info', code: 'protection-created',
            message: child.status === 'blocked' ? child.reason! : `买入已确认，启用附带${child.kind === 'take-profit' ? '止盈' : '止损'}：本笔实买的 ${child.sellPercent}%（${child.quantity} ${child.asset.symbol}）`,
            accountId: child.accountId, orderId: child.id, symbol: child.asset.symbol, order: orderSnapshot(child, { mode: 'live' }) });
        }
        if (confirmed.ocoGroupId) for (const sibling of await tx.objectStore('orders').getAll()) {
          if (sibling.id !== confirmed.id && sibling.accountId === confirmed.accountId && sibling.ocoGroupId === confirmed.ocoGroupId && sibling.status === 'waiting') {
            await tx.objectStore('orders').put({ ...sibling, status: 'cancelled', reason: '同组另一侧已成交，互斥保护单自动取消' });
            await tx.objectStore('logs').put({ id: crypto.randomUUID(), at: Date.now(), category: 'trade', level: 'info', code: 'protection-cancelled',
              message: '同组另一侧已成交，互斥保护单自动取消', accountId: sibling.accountId, orderId: sibling.id, symbol: sibling.asset.symbol,
              order: orderSnapshot({ ...sibling, status: 'cancelled', reason: '同组另一侧已成交，互斥保护单自动取消' }, { mode: 'live' }) });
          }
        }
        await tx.objectStore('logs').put({ id: crypto.randomUUID(), at: Date.now(), category: 'trade', level: 'info', code: 'order-confirmed',
          message: `链上已确认成交：${result.quantity} ${order.asset.symbol}，${result.amountUsd} USDC，成交价 $${result.priceUsd}`,
          accountId: order.accountId, orderId: order.id, symbol: order.asset.symbol, order: orderSnapshot(confirmed, { mode: 'live' }) });
        await tx.done;
        await options.changed?.().catch(() => {});
        await sendFillNotice(confirmed);
      } else if (Date.now() - (order.submittedAt ?? order.createdAt) > 60000) {
        await update(order.id, { status: 'unknown', reason: '链上结果待核对，持续查询；请勿重复建单' });
      }
    } catch { /* Keep the hash and intent. Query failures never create a second transaction. */ }
    finally { querying.delete(order.id); }
  }
  async function run(order: Order, tab: number) {
    let broadcastRequested = false, hash: string | undefined;
    try {
      const settings = await checkPermission(order, tab);
      const prepared = await options.call(tab, { action: 'prepare', attemptId: order.attemptId!, order,
        slippageBps: order.slippageBps || undefined, maxPriceAgeMs: settings.maxPriceAgeMs });
      if (prepared.state !== 'prepared') throw new ExecutionError('prepare', '报价未准备完成');
      await checkPermission(order, tab);
      if (prepared.native) {
        if (!prepared.reference) throw new ExecutionError('prepare', '未取得可恢复的多链执行标识');
        // Native EVM execution combines signing and broadcast. Persist the intent first;
        // every interruption after handoff is reconciled, never automatically repeated.
        await update(order.id, { status: 'submitted', executionReference: prepared.reference, submittedAt: Date.now() });
        await checkPermission(order, tab);
        broadcastRequested = true;
        const result = await options.call(tab, { action: 'execute-native', attemptId: order.attemptId! });
        const patch: Partial<Order> = { status: result.state === 'failed' ? 'failed' : result.state === 'submitted' ? 'submitted' : 'unknown', reason: result.message };
        if (result.transactionHash) patch.transactionHash = result.transactionHash;
        if (result.reference) patch.executionReference = result.reference;
        await update(order.id, patch);
        await orderLog(order, 'native-execution', result.state === 'failed' ? '平台多链执行已结束，详情见订单原因' : '已发起平台多链执行，等待真实成交核对；不会重复提交');
        if (result.state === 'failed') {
          await notify(await options.db, { channel: 'alerts', code: 'execution-interface', message: `${order.asset.symbol} 多链执行未完成，请查看交易日志与订单原因` });
          return;
        }
      } else {
      const signed = await options.call(tab, { action: 'sign', attemptId: order.attemptId! });
      if (signed.state !== 'signed' || !signed.transactionHash) throw new ExecutionError('signature', '未取得已校验的交易签名');
      hash = signed.transactionHash;
      // This durable write must finish before any submit instruction leaves the worker.
      await update(order.id, { status: 'signed', transactionHash: hash, lastValidBlockHeight: signed.lastValidBlockHeight });
      await orderLog(order, 'transaction-signed', '交易已签名并保存哈希，尚未确认提交');
      await checkPermission(order, tab);
      await update(order.id, { status: 'submitted', submittedAt: Date.now() });
      broadcastRequested = true;
      const submission = await options.call(tab, { action: 'submit', attemptId: order.attemptId!, transactionHash: hash });
      await update(order.id, { status: submission.state === 'submitted' ? 'submitted' : 'unknown', reason: submission.message });
      await orderLog(order, 'transaction-submitted', submission.state === 'submitted' ? '交易已提交，等待链上成交确认' : '提交结果未知，等待链上核对；不会重复下单');
      }
      for (let count = 0; count < 8; count++) {
        const latest = await (await options.db).get('orders', order.id);
        if (!latest || !unsettled.includes(latest.status)) break;
        await reconcileOne(latest, true);
        if ((await (await options.db).get('orders', order.id))?.status === 'confirmed') break;
        await new Promise(resolve => setTimeout(resolve, 3000));
      }
    } catch (error) {
      const retry = !hash && error instanceof ExecutionError && (error.retryable || error.code === 'paused' || error.code === 'revoked');
      const reason = broadcastRequested ? '交易提交结果未知，正在核对链上状态；不会重复下单'
        : error instanceof ExecutionError ? error.message : '交易准备或签名未完成，未提交交易';
      await update(order.id, { status: broadcastRequested ? 'unknown' : retry ? 'waiting' : 'failed', reason, nextAttemptAt: Date.now() + 10000 });
      await orderLog(order, broadcastRequested ? 'transaction-unknown' : retry ? 'execution-waiting' : 'execution-failed', reason, retry ? 'warning' : 'error');
      if (error instanceof ExecutionError && ['network', 'rpc', 'quote', 'auth', 'signature'].includes(error.code)) {
        await notify(await options.db, { channel: 'alerts', code: 'execution-interface', message: `${order.asset.symbol} 交易接口或钱包执行异常，请查看交易日志` });
      }
    } finally { busy.delete(order.accountId); }
  }
  async function tick(session: Session, price: Price, tab: number) {
    if (busy.has(session.accountId) || !options.allowed(session.accountId, tab)) return;
    const db = await options.db, settings = await readSettings(db);
    if (!settings.automatic || !settings.realTrading || !fresh(price, Date.now(), settings.maxPriceAgeMs) || Date.now() - session.receivedAt > 45000) return;
    busy.add(session.accountId);
    let claimed: Order | undefined;
    try {
      const tx = db.transaction('orders', 'readwrite');
      const orders = (await tx.store.getAll()).sort((a, b) => a.createdAt - b.createdAt);
      if (orders.some(o => o.accountId === session.accountId && (unsettled.includes(o.status) || o.status === 'preparing'))) {
        await tx.done; busy.delete(session.accountId); return;
      }
      const candidate = orders.find(o => !o.legacy && o.status === 'waiting' && o.accountId === session.accountId && sameAsset(o.asset, price) &&
        (o.nextAttemptAt ?? 0) <= Date.now() && triggered(o, price.priceUsd));
      if (candidate) {
        claimed = { ...candidate, status: 'preparing', attemptId: crypto.randomUUID(), reason: undefined };
        await tx.store.put(claimed);
      }
      await tx.done;
    } catch { busy.delete(session.accountId); return; }
    if (!claimed) { busy.delete(session.accountId); return; }
    void run(claimed, tab).catch(() => busy.delete(session.accountId));
  }
  async function reconcile() {
    for (const order of await (await options.db).getAll('orders')) {
      if (unsettled.includes(order.status)) await reconcileOne(order);
      if (order.status === 'confirmed') await sendFillNotice(order);
    }
  }
  return { tick, reconcile };
}
