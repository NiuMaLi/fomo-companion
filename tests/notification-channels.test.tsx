import 'fake-indexeddb/auto';
import React from 'react';
import { createHmac } from 'node:crypto';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { database, readSettings, type DB } from '../src/storage/database';
import { DEFAULT_SETTINGS } from '../src/shared/model';
import { emptyNotificationTarget, notificationEnabled, notificationTargetSchema, type NotificationTarget } from '../src/shared/notifications';
import { notify, testNotification } from '../src/notifications/notify';
import { NotificationChannel } from '../src/components/NotificationChannel';
import { LanguageContext } from '../src/components/Language';
import { translator } from '../src/shared/i18n';

const targets: NotificationTarget[] = [
  { provider: 'feishu', webhook: 'https://open.feishu.cn/open-apis/bot/v2/hook/test-channel-config', secret: '' },
  { provider: 'dingtalk', webhook: 'https://oapi.dingtalk.com/robot/send?access_token=test-dingtalk-access', secret: '' },
  { provider: 'wecom', webhook: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=test-wecom-key' },
  { provider: 'telegram', botToken: '123456789:TEST_ONLY_BOT_TOKEN_1234567890', chatId: '-1001234567890' },
];
const fill = { channel: 'orders' as const, orderId: 'order', accountId: 'account', symbol: 'ETH', direction: 'sell' as const,
  transactionHash: 'confirmed-hash', confirmedAt: Date.parse('2026-10-20T23:30:00Z'), priceUsd: '2000', quantity: '0.1', amountUsd: '200', remainingQuantity: '0' };
const alert = { channel: 'alerts' as const, code: 'expired', message: '登录凭据失效' };
let db: DB;
const send = vi.fn<typeof fetch>();
beforeEach(async () => { db = await database(crypto.randomUUID()); send.mockReset(); });
afterEach(() => { db.close(); vi.restoreAllMocks(); });
const success = (target: NotificationTarget) => target.provider === 'telegram' ? { ok: true, result: { message_id: 1 } }
  : target.provider === 'feishu' ? { code: 0 } : { errcode: 0, errmsg: 'ok' };
const settings = async (orders: NotificationTarget, alerts: NotificationTarget = { provider: 'disabled' }) =>
  db.put('state', { ...DEFAULT_SETTINGS, notifications: { orders, alerts } }, 'settings');

it.each(targets)('$provider 使用对应协议发送完整成交数据，重开后不重复通知', async target => {
  await settings(target);
  send.mockImplementation(async () => Response.json(success(target)));
  expect(await notify(db, fill, send)).toBe('sent');
  const [url, options] = send.mock.calls[0]!;
  const body = JSON.parse(options!.body as string);
  const text = target.provider === 'feishu' ? body.content.text : target.provider === 'telegram' ? body.text : body.text.content;
  for (const value of ['FOMO', 'ETH / USDC', '卖出', '$2000', '0.1 ETH', '200 USDC', '0 ETH', 'confirmed-hash']) expect(text).toContain(value);
  expect(options).toMatchObject({ method: 'POST', redirect: 'error', credentials: 'omit' });
  if (target.provider === 'telegram') {
    expect(url).toBe(`https://api.telegram.org/bot${target.botToken}/sendMessage`);
    expect(body).toEqual({ chat_id: target.chatId, text });
    expect(body).not.toHaveProperty('parse_mode');
  } else if ('webhook' in target) {
    expect(url).toBe(target.webhook);
    expect(body[target.provider === 'feishu' ? 'msg_type' : 'msgtype']).toBe('text');
  }
  const name = db.name; db.close(); db = await database(name);
  expect((await readSettings(db)).notifications.orders).toEqual(target);
  expect(await notify(db, fill, send)).toBe('suppressed');
  expect(send).toHaveBeenCalledTimes(1);
});

it.each(targets)('$provider 正确发送系统告警并保持五分钟冷却，空订单配置不回退', async target => {
  await settings({ provider: 'disabled' }, target);
  send.mockImplementation(async () => Response.json(success(target)));
  expect(await notify(db, fill, send, 1000)).toBe('disabled');
  expect(await notify(db, alert, send, 1000)).toBe('sent');
  expect(JSON.stringify(JSON.parse(send.mock.calls[0]![1]!.body as string))).toContain('登录凭据失效');
  expect(await notify(db, alert, send, 2000)).toBe('suppressed');
  expect(await notify(db, alert, send, 301001)).toBe('sent');
  expect(send).toHaveBeenCalledTimes(2);
});

it.each(targets)('$provider HTTP 成功但业务拒绝不标记成功、不重发、不泄露响应', async target => {
  await settings(target, target);
  send.mockResolvedValue(Response.json({ code: 1, errcode: 1, ok: false, description: 'private-provider-response' }));
  expect(await notify(db, fill, send)).toBe('failed');
  expect(await notify(db, fill, send)).toBe('suppressed');
  send.mockRejectedValue(new Error(JSON.stringify(target)));
  expect(await notify(db, alert, send)).toBe('failed');
  expect(send).toHaveBeenCalledTimes(2);
  expect(JSON.stringify(await db.getAll('logs'))).not.toMatch(/private-provider-response|test-channel-config|test-dingtalk-access|test-wecom-key|TEST_ONLY_BOT_TOKEN/);
});

it.each(targets)('$provider 不接受缺少成功标志的响应或 HTTP 错误', async target => {
  await settings(target);
  send.mockResolvedValue(Response.json({}));
  expect(await notify(db, fill, send)).toBe('failed');
  send.mockResolvedValue(Response.json(success(target), { status: 403 }));
  expect(await notify(db, { ...fill, orderId: 'http-error' }, send)).toBe('failed');
});

it.each(['disabled', 'feishu', 'dingtalk', 'wecom', 'telegram'] as const)('%s 未配置时不发送，也不记录补发标记', async provider => {
  const target = emptyNotificationTarget(provider);
  await settings(target, target);
  expect(notificationEnabled(target)).toBe(false);
  expect(await notify(db, fill, send)).toBe('disabled');
  expect(await notify(db, alert, send)).toBe('disabled');
  expect(send).not.toHaveBeenCalled();
  expect((await db.getAllKeys('state')).filter(key => String(key).startsWith('notice:'))).toEqual([]);
});

it('两类通知使用不同平台；切换平台不突破已有成交去重', async () => {
  await settings(targets[1]!, targets[3]!);
  send.mockResolvedValueOnce(Response.json({ errcode: 0 })).mockResolvedValueOnce(Response.json({ ok: true }));
  await notify(db, fill, send); await notify(db, alert, send);
  expect(String(send.mock.calls[0]![0])).toContain('oapi.dingtalk.com');
  expect(String(send.mock.calls[1]![0])).toContain('api.telegram.org');
  await settings(targets[2]!);
  expect(await notify(db, fill, send)).toBe('suppressed');
  expect(send).toHaveBeenCalledTimes(2);
});

it.each(['feishu', 'dingtalk'] as const)('%s 按平台规范生成独立时间戳和 HMAC-SHA256 签名', async provider => {
  const target = { ...targets.find(target => target.provider === provider)!, secret: 'SEC-test-only-signing-secret' } as NotificationTarget;
  await settings(target);
  send.mockResolvedValue(Response.json(success(target)));
  const now = Date.parse('2026-10-20T23:30:00Z');
  expect(await notify(db, fill, send, now)).toBe('sent');
  const [url, options] = send.mock.calls[0]!;
  const body = JSON.parse(options!.body as string);
  if (provider === 'feishu') {
    expect(body.timestamp).toBe(String(Math.floor(now / 1000)));
    expect(body.sign).toBe(createHmac('sha256', `${body.timestamp}\nSEC-test-only-signing-secret`).update('').digest('base64'));
  } else {
    const parsed = new URL(String(url));
    expect(parsed.searchParams.get('timestamp')).toBe(String(now));
    expect(parsed.searchParams.get('sign')).toBe(createHmac('sha256', 'SEC-test-only-signing-secret').update(`${now}\nSEC-test-only-signing-secret`).digest('base64'));
    expect(parsed.searchParams.get('access_token')).toBe('test-dingtalk-access');
  }
  expect(JSON.stringify(await db.getAll('logs'))).not.toContain('SEC-test-only-signing-secret');
});

it.each(targets.filter(target => target.provider !== 'telegram'))('$provider 校验专属 HTTPS 域名、路径、参数，不允许混用或跳转', target => {
  if (!('webhook' in target)) return;
  expect(notificationTargetSchema.safeParse(target).success).toBe(true);
  for (const webhook of [target.webhook.replace('https:', 'http:'), target.webhook.replace('https://', 'https://x@'),
    target.webhook + '#private', target.webhook + (target.webhook.includes('?') ? '&' : '?') + 'redirect=https://example.com',
    target.webhook.replace(/\/\//, '//evil.example/'), ...targets.filter(other => 'webhook' in other && other.provider !== target.provider).map(other => 'webhook' in other ? other.webhook : '')]) {
    expect(notificationTargetSchema.safeParse({ ...target, webhook }).success, webhook).toBe(false);
  }
});

it('Telegram 要求有效 Token 与 Chat ID 成对填写，保留负数和公开频道名', () => {
  const target = targets[3]!;
  for (const chatId of ['-1001234567890', '12345678', '@public_channel']) expect(notificationTargetSchema.safeParse({ ...target, chatId }).success).toBe(true);
  for (const patch of [{ botToken: '' }, { chatId: '' }, { botToken: 'https://evil.example/token' }, { chatId: '1&text=bad' }]) {
    expect(notificationTargetSchema.safeParse({ ...target, ...patch }).success).toBe(false);
  }
});

it('旧版飞书配置跨重开兼容，交易开关、语言和订单不改变', async () => {
  const order = { id: 'existing', accountId: 'account', asset: { symbol: 'ETH', tokenAddress: 'test-token', networkId: 1 }, kind: 'limit-buy' as const,
    targetPrice: '1000', amountUsd: '10', createdAt: 1, status: 'waiting' as const };
  await db.put('orders', order);
  await db.put('state', { ...DEFAULT_SETTINGS, automatic: true, realTrading: true, language: 'en', notifications: {
    ordersWebhook: 'https://open.feishu.cn/open-apis/bot/v2/hook/test-legacy-orders', alertsWebhook: 'https://open.feishu.cn/open-apis/bot/v2/hook/test-legacy-alerts',
  } }, 'settings');
  const saved = await readSettings(db);
  expect(saved).toMatchObject({ automatic: true, realTrading: true, language: 'en', notifications: {
    orders: { provider: 'feishu', webhook: expect.stringContaining('test-legacy-orders') }, alerts: { provider: 'feishu', webhook: expect.stringContaining('test-legacy-alerts') },
  } });
  await db.put('state', saved, 'settings');
  const name = db.name; db.close(); db = await database(name);
  expect(await readSettings(db)).toEqual(saved);
  expect(await db.get('orders', order.id)).toEqual(order);
});

it.each(targets)('$provider 配置表单包含对应字段、教程、可访问标签，支持英文', target => {
  const html = renderToStaticMarkup(<LanguageContext.Provider value={{ language: 'en', t: translator('en') }}>
    <NotificationChannel channel="orders" value={target} onChange={() => {}} onTest={async () => ({ sent: true, message: '' })}/>
  </LanguageContext.Provider>);
  expect(html).toContain('Order notifications');
  expect(html).toContain('Delivery channel');
  expect(html).toContain('Setup guide');
  expect(html).toContain('Official documentation');
  expect(html).toContain('Send test notification');
  expect(html).toContain('type="button"');
  expect(html).not.toMatch(/[\u3400-\u9fff]/);
  if (target.provider === 'telegram') {
    expect(html).toContain('Bot Token'); expect(html).toContain('Chat ID'); expect(html).not.toContain('>Webhook<');
  } else {
    expect(html).toContain('>Webhook<'); expect(html).not.toContain('>Chat ID<');
  }
});

it.each(targets)('$provider 测试当前草稿，两类测试均可重复发送，不保存或干扰正式通知去重', async target => {
  const stored = await readSettings(db);
  await db.put('state', { at: 1000, status: 'sent' }, 'notice:alert:expired');
  const before = await db.getAllKeys('state');
  send.mockImplementation(async () => Response.json(success(target)));
  for (const channel of ['orders', 'alerts', 'orders'] as const) {
    expect(await testNotification(db, channel, target, send, fill.confirmedAt)).toMatchObject({ sent: true });
    const body = JSON.parse(send.mock.lastCall![1]!.body as string);
    const text = target.provider === 'feishu' ? body.content.text : target.provider === 'telegram' ? body.text : body.text.content;
    expect(text).toContain('FOMO 通知连通性测试');
    expect(text).toContain(channel === 'orders' ? '类型：订单通知' : '类型：告警通知');
    expect(text).toContain('不代表订单成交或系统异常');
    expect(text).toContain('GMT');
    expect(text).not.toContain('confirmed-hash');
  }
  expect(send).toHaveBeenCalledTimes(3);
  expect(await readSettings(db)).toEqual(stored);
  expect(await db.getAllKeys('state')).toEqual(before);
  expect(await db.get('state', 'notice:alert:expired')).toEqual({ at: 1000, status: 'sent' });
  expect(await db.getAll('orders')).toEqual([]);
  expect((await db.getAll('logs')).every(log => log.category === 'operation' && log.code === 'notification-test')).toBe(true);
});

it.each(targets)('$provider 测试失败只返回安全错误码，隐藏原始响应和异常中的凭据', async target => {
  send.mockResolvedValue(Response.json({ code: 17, errcode: 17, ok: false, error_code: 17, description: JSON.stringify(target) }));
  expect(await testNotification(db, 'orders', target, send)).toMatchObject({ sent: false, message: expect.stringContaining('17') });
  send.mockResolvedValue(Response.json({ description: JSON.stringify(target) }, { status: 403 }));
  expect(await testNotification(db, 'alerts', target, send)).toMatchObject({ sent: false, message: expect.stringContaining('HTTP 403') });
  send.mockRejectedValue(new Error(JSON.stringify(target)));
  const failed = await testNotification(db, 'orders', target, send);
  expect(failed).toMatchObject({ sent: false, message: expect.stringContaining('结果未知') });
  expect(JSON.stringify({ failed, logs: await db.getAll('logs') })).not.toMatch(/TEST_ONLY_BOT_TOKEN|test-channel-config|test-dingtalk-access|test-wecom-key/);
});

it('关闭、空白和非法测试配置不发送，英文测试正文和结果可翻译', async () => {
  for (const provider of ['disabled', 'feishu', 'dingtalk', 'wecom', 'telegram'] as const) {
    expect((await testNotification(db, 'orders', emptyNotificationTarget(provider), send)).sent).toBe(false);
  }
  expect((await testNotification(db, 'orders', { provider: 'feishu', webhook: 'https://evil.example/test', secret: '' }, send)).sent).toBe(false);
  expect(send).not.toHaveBeenCalled();
  await db.put('state', { ...DEFAULT_SETTINGS, language: 'en' }, 'settings');
  send.mockResolvedValue(Response.json({ ok: true }));
  const result = await testNotification(db, 'alerts', targets[3]!, send);
  const text = JSON.parse(send.mock.calls[0]![1]!.body as string).text;
  expect(text).toContain('FOMO notification connectivity test');
  expect(text).toContain('Type: Alert notifications');
  expect(text).not.toMatch(/[\u3400-\u9fff]/);
  expect(translator('en')(result.message)).toContain('accepted the test message');
  expect(translator('en')('通知接口返回 HTTP 403，请检查机器人配置或网络')).toContain('HTTP 403');
});
