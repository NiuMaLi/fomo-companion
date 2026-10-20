import { readSettings, type DB } from '../storage/database';
import { redact, writeLog } from '../storage/logs';
import { translator } from '../shared/i18n';

export type Notice =
  | { channel: 'alerts'; code: string; message: string }
  | { channel: 'orders'; orderId: string; accountId: string; symbol: string; transactionHash: string; confirmedAt: number;
      direction?: 'buy' | 'sell'; priceUsd?: string; quantity?: string; amountUsd?: string; remainingQuantity?: string };
type Delivery = { at: number; status: 'sending' | 'sent' | 'failed' };

// Called only with sanitized system errors or a confirmed execution receipt, never a quote/trigger.
export async function notify(db: DB, notice: Notice, send: typeof fetch = fetch, now = Date.now()) {
  const settings = await readSettings(db);
  const t = translator(settings.language);
  const url = notice.channel === 'orders' ? settings.notifications.ordersWebhook : settings.notifications.alertsWebhook;
  if (!url) return 'disabled' as const;
  const key = notice.channel === 'orders' ? `notice:order:${notice.accountId}:${notice.orderId}` : `notice:alert:${notice.code}`;
  const tx = db.transaction('state', 'readwrite');
  const previous = await tx.store.get(key) as Delivery | undefined;
  if (previous && (notice.channel === 'orders' || now - previous.at < 300000)) { await tx.done; return 'suppressed' as const; }
  // Persist before sending. A timeout or worker restart must not duplicate a fill notification.
  await tx.store.put({ at: now, status: 'sending' } satisfies Delivery, key);
  await tx.done;
  const text = notice.channel === 'orders'
    ? t('FOMO 订单成交\n币对：{0} / USDC\n方向：{1}\n成交价格：{2}\n成交数量：{3} {4}\n成交价值：{5} USDC\n币对剩余仓位（确认核对时）：{6}\n订单：{7}\n交易：{8}\n确认时间：{9}', {
      0: notice.symbol, 1: t(notice.direction === 'buy' ? '买入' : notice.direction === 'sell' ? '卖出' : '未记录'),
      2: notice.priceUsd === undefined ? t('未记录') : '$' + notice.priceUsd, 3: notice.quantity ?? t('未记录'), 4: notice.symbol,
      5: notice.amountUsd ?? t('未记录'), 6: notice.remainingQuantity === undefined ? t('未获取') : notice.remainingQuantity + ' ' + notice.symbol,
      7: notice.orderId, 8: notice.transactionHash, 9: new Date(notice.confirmedAt).toISOString(),
    })
    : t('FOMO 系统告警\n{0}\n时间：{1}', { 0: t(redact(notice.message)), 1: new Date(now).toISOString() });
  try {
    const response = await send(url, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ msg_type: 'text', content: { text } }), redirect: 'error', credentials: 'omit', signal: AbortSignal.timeout(8000) });
    if (!response.ok) throw new Error('http');
    const result = await response.json() as { code?: number; StatusCode?: number };
    if ((result.code ?? result.StatusCode) !== 0) throw new Error('rejected');
    await db.put('state', { at: now, status: 'sent' } satisfies Delivery, key);
    await writeLog(db, { category: 'system', level: 'info', code: 'notification-sent', message: notice.channel === 'orders' ? '订单通知已发送' : '告警通知已发送' });
    return 'sent' as const;
  } catch {
    await db.put('state', { at: now, status: 'failed' } satisfies Delivery, key);
    await writeLog(db, { category: 'system', level: 'error', code: 'notification-failed',
      message: notice.channel === 'orders' ? '订单通知发送失败或结果未知；未自动重发，请检查机器人配置和网络' : '告警通知发送失败或结果未知；请检查机器人配置和网络' });
    return 'failed' as const;
  }
}
