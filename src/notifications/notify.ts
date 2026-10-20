import { readSettings, type DB } from '../storage/database';
import { redact, writeLog } from '../storage/logs';
import { translator } from '../shared/i18n';
import { notificationEnabled, notificationTargetSchema, type NotificationTarget } from '../shared/notifications';
import { deliverNotification } from './transports';

export type Notice =
  | { channel: 'alerts'; code: string; message: string }
  | { channel: 'orders'; orderId: string; accountId: string; symbol: string; transactionHash: string; confirmedAt: number;
      direction?: 'buy' | 'sell'; priceUsd?: string; quantity?: string; amountUsd?: string; remainingQuantity?: string };
type Delivery = { at: number; status: 'sending' | 'sent' | 'failed' };

// Use the browser's local time zone independently of the notification language.
function notificationTime(value: number) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    hourCycle: 'h23', timeZoneName: 'longOffset',
  }).formatToParts(value);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find(item => item.type === type)!.value;
  return `${part('year')}-${part('month')}-${part('day')} ${part('hour')}:${part('minute')}:${part('second')} ${part('timeZoneName')}`;
}

// Called only with sanitized system errors or a confirmed execution receipt, never a quote/trigger.
export async function notify(db: DB, notice: Notice, send: typeof fetch = fetch, now = Date.now()) {
  const settings = await readSettings(db);
  const t = translator(settings.language);
  const target = settings.notifications[notice.channel];
  if (!notificationEnabled(target)) return 'disabled' as const;
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
      7: notice.orderId, 8: notice.transactionHash, 9: notificationTime(notice.confirmedAt),
    })
    : t('FOMO 系统告警\n{0}\n时间：{1}', { 0: t(redact(notice.message)), 1: notificationTime(now) });
  try {
    await deliverNotification(target, text, send, now);
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

export type NotificationTestResult = { sent: boolean; message: string };

// A manual test uses the supplied draft, never saves it or touches real notice deduplication.
export async function testNotification(db: DB, channel: 'orders' | 'alerts', target: NotificationTarget,
  send: typeof fetch = fetch, now = Date.now()): Promise<NotificationTestResult> {
  const parsed = notificationTargetSchema.safeParse(target);
  if (!parsed.success || !notificationEnabled(parsed.data)) return { sent: false, message: '请先完整填写有效的通知配置' };
  const t = translator((await readSettings(db)).language);
  const text = t('FOMO 通知连通性测试\n类型：{0}\n这是一条测试消息，用于验证机器人配置，不代表订单成交或系统异常。\n时间：{1}', {
    0: t(channel === 'orders' ? '订单通知' : '告警通知'), 1: notificationTime(now),
  });
  let result: NotificationTestResult;
  try {
    await deliverNotification(parsed.data, text, send, now);
    result = { sent: true, message: '机器人接口已接受测试消息，请检查目标聊天' };
  } catch (error) {
    result = { sent: false, message: error instanceof Error ? error.message : '通知发送失败或结果未知，请检查网络及机器人配置' };
  }
  await writeLog(db, { category: 'operation', level: result.sent ? 'info' : 'error', code: 'notification-test',
    message: result.sent ? channel === 'orders' ? '订单测试通知已发送' : '告警测试通知已发送'
      : channel === 'orders' ? '订单测试通知发送失败或结果未知，请检查机器人配置和网络' : '告警测试通知发送失败或结果未知，请检查机器人配置和网络' });
  return result;
}
