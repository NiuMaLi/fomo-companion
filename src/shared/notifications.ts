import { z } from 'zod';

const field = z.string().trim().max(500);
function validWebhook(value: string, provider: 'feishu' | 'dingtalk' | 'wecom') {
  if (!value) return true;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.port || url.username || url.password || url.hash) return false;
    if (provider === 'feishu') return url.hostname === 'open.feishu.cn' && !url.search &&
      /^\/open-apis\/bot\/v2\/hook\/[A-Za-z0-9_-]{10,200}$/.test(url.pathname);
    const key = provider === 'dingtalk' ? 'access_token' : 'key';
    return url.hostname === (provider === 'dingtalk' ? 'oapi.dingtalk.com' : 'qyapi.weixin.qq.com') &&
      url.pathname === (provider === 'dingtalk' ? '/robot/send' : '/cgi-bin/webhook/send') &&
      [...url.searchParams.keys()].length === 1 && /^[A-Za-z0-9_-]{10,256}$/.test(url.searchParams.get(key) ?? '');
  } catch { return false; }
}
const webhook = (provider: 'feishu' | 'dingtalk' | 'wecom') => field.refine(value => validWebhook(value, provider),
  '请输入所选渠道的有效机器人 Webhook，或留空关闭通知');
export const notificationTargetSchema = z.discriminatedUnion('provider', [
  z.object({ provider: z.literal('disabled') }),
  z.object({ provider: z.literal('feishu'), webhook: webhook('feishu'), secret: field.default('') }),
  z.object({ provider: z.literal('dingtalk'), webhook: webhook('dingtalk'), secret: field.default('') }),
  z.object({ provider: z.literal('wecom'), webhook: webhook('wecom') }),
  z.object({ provider: z.literal('telegram'),
    botToken: field.refine(value => !value || /^\d{5,20}:[A-Za-z0-9_-]{20,120}$/.test(value), '请输入有效的 Telegram Bot Token'),
    chatId: field.refine(value => !value || /^(?:-?\d{1,25}|@[A-Za-z][A-Za-z0-9_]{4,31})$/.test(value), '请输入有效的 Telegram Chat ID'),
  }),
]).refine(target => target.provider !== 'telegram' || !!target.botToken === !!target.chatId,
  'Telegram Bot Token 和 Chat ID 需要同时填写，或同时留空关闭通知');
export type NotificationTarget = z.infer<typeof notificationTargetSchema>;
export type NotificationProvider = NotificationTarget['provider'];
export const emptyNotificationTarget = (provider: NotificationProvider): NotificationTarget => {
  switch (provider) {
    case 'disabled': return { provider };
    case 'telegram': return { provider, botToken: '', chatId: '' };
    case 'wecom': return { provider, webhook: '' };
    default: return { provider, webhook: '', secret: '' };
  }
};
export const notificationEnabled = (target: NotificationTarget) => target.provider === 'disabled' ? false
  : target.provider === 'telegram' ? !!target.botToken && !!target.chatId : !!target.webhook;

// Preserve the two pre-existing Feishu destinations without changing any trading settings.
export const notificationsSchema = z.union([
  z.object({ orders: notificationTargetSchema, alerts: notificationTargetSchema }),
  z.object({ ordersWebhook: webhook('feishu'), alertsWebhook: webhook('feishu') }).transform(legacy => ({
    orders: { provider: 'feishu' as const, webhook: legacy.ordersWebhook, secret: '' },
    alerts: { provider: 'feishu' as const, webhook: legacy.alertsWebhook, secret: '' },
  })),
]);
