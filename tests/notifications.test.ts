import 'fake-indexeddb/auto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { database, readSettings, type DB } from '../src/storage/database';
import { DEFAULT_SETTINGS, notificationsSchema } from '../src/shared/model';
import { notify } from '../src/notifications/notify';
const ordersWebhook = 'https://open.feishu.cn/open-apis/bot/v2/hook/test-orders-channel';
const alertsWebhook = 'https://open.feishu.cn/open-apis/bot/v2/hook/test-alerts-channel';
const alert = { channel: 'alerts' as const, code: 'auth-expired', message: '登录凭据失效' };
const fill = { channel: 'orders' as const, orderId: 'confirmed-order', accountId: 'account', symbol: 'SOL', transactionHash: 'confirmed-chain-hash', confirmedAt: 1800000000000 };
let db: DB;
const send = vi.fn<typeof fetch>();
beforeEach(async () => { db = await database(crypto.randomUUID()); send.mockReset().mockResolvedValue(new Response('{"code":0}')); });
afterEach(() => { db.close(); vi.restoreAllMocks(); });
it('未配置不请求、不记录待补发通知', async () => {
  expect(await notify(db, alert, send)).toBe('disabled');
  expect(await notify(db, fill, send)).toBe('disabled');
  expect(send).not.toHaveBeenCalled();
  expect((await db.getAllKeys('state')).filter(k => String(k).startsWith('notice:'))).toEqual([]);
});
it('两类通知使用独立地址，不向另一渠道回退', async () => {
  await db.put('state', { ...DEFAULT_SETTINGS, notifications: { ordersWebhook, alertsWebhook: '' } }, 'settings');
  expect(await notify(db, alert, send)).toBe('disabled');
  await notify(db, fill, send);
  expect(send.mock.calls[0]?.[0]).toBe(ordersWebhook);
  await db.put('state', { ...DEFAULT_SETTINGS, notifications: { ordersWebhook, alertsWebhook } }, 'settings');
  await notify(db, alert, send);
  expect(send.mock.calls[1]?.[0]).toBe(alertsWebhook);
  const options = send.mock.calls[1]?.[1]!;
  expect(JSON.parse(options.body as string)).toMatchObject({ msg_type: 'text', content: { text: expect.stringContaining('登录凭据失效') } });
  expect(options.redirect).toBe('error');
});
it.each([
  ['Asia/Shanghai', 'zh-CN', '2026-10-21 07:30:00 GMT+08:00', '2026-10-21 07:31:00 GMT+08:00'],
  ['Asia/Shanghai', 'en', '2026-10-21 07:30:00 GMT+08:00', '2026-10-21 07:31:00 GMT+08:00'],
  ['America/New_York', 'en', '2026-10-20 19:30:00 GMT-04:00', '2026-10-20 19:31:00 GMT-04:00'],
  ['UTC', 'zh-CN', '2026-10-20 23:30:00 GMT', '2026-10-20 23:31:00 GMT'],
] as const)('两类通知跟随系统时区 %s、语言 %s，并标注时区', async (timeZone, language, confirmedTime, alertTime) => {
  const DateTimeFormat = Intl.DateTimeFormat;
  vi.spyOn(Intl, 'DateTimeFormat').mockImplementation((locales, options) => new DateTimeFormat(locales, { ...options, timeZone }));
  await db.put('state', { ...DEFAULT_SETTINGS, language, notifications: { ordersWebhook, alertsWebhook } }, 'settings');
  const confirmedAt = Date.parse('2026-10-20T23:30:00Z');
  const now = confirmedAt + 60000;
  await notify(db, { ...fill, confirmedAt }, send, now);
  await notify(db, alert, send, now);
  expect(JSON.parse(send.mock.calls[0]![1]!.body as string).content.text).toContain(confirmedTime);
  expect(JSON.parse(send.mock.calls[1]![1]!.body as string).content.text).toContain(alertTime);
});
it('并发、重启后成交通知不重复，同类告警五分钟内去重', async () => {
  await db.put('state', { ...DEFAULT_SETTINGS, notifications: { ordersWebhook, alertsWebhook } }, 'settings');
  await Promise.all([notify(db, fill, send, 1000), notify(db, fill, send, 1000)]);
  const name = db.name; db.close(); db = await database(name);
  await notify(db, fill, send, 1000000);
  expect(send).toHaveBeenCalledTimes(1);
  await notify(db, alert, send, 1000);
  await notify(db, alert, send, 2000);
  await notify(db, alert, send, 301001);
  expect(send).toHaveBeenCalledTimes(3);
});
it('HTTP 200 业务错误记录失败，不递归告警，不记录地址或原始异常', async () => {
  await db.put('state', { ...DEFAULT_SETTINGS, notifications: { ordersWebhook, alertsWebhook } }, 'settings');
  send.mockResolvedValue(new Response('{"code":19024,"StatusCode":0,"msg":"sensitive"}'));
  expect(await notify(db, alert, send)).toBe('failed');
  expect(send).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(await db.getAll('logs'))).not.toMatch(/sensitive|test-alerts-channel/);
  send.mockRejectedValue(new Error(alertsWebhook));
  expect(await notify(db, fill, send)).toBe('failed');
  expect(await notify(db, fill, send)).toBe('suppressed');
  expect(send).toHaveBeenCalledTimes(2);
});
it('校验飞书地址并持久保存；清空可以关闭', async () => {
  for (const value of ['http://open.feishu.cn/open-apis/bot/v2/hook/test-orders-channel', 'https://evil.example/hook/test-orders-channel', ordersWebhook + '?secret=1', ordersWebhook.replace('open.feishu.cn', 'x@open.feishu.cn')]) {
    expect(notificationsSchema.safeParse({ ordersWebhook: value, alertsWebhook: '' }).success).toBe(false);
  }
  const notifications = notificationsSchema.parse({ ordersWebhook: ' ' + ordersWebhook + ' ', alertsWebhook: '' });
  await db.put('state', { ...DEFAULT_SETTINGS, notifications }, 'settings');
  const name = db.name; db.close(); db = await database(name);
  expect((await readSettings(db)).notifications).toEqual({ orders: { provider: 'feishu', webhook: ordersWebhook, secret: '' }, alerts: { provider: 'feishu', webhook: '', secret: '' } });
});

it('成交通知包含实际价格、数量、价值和零剩余仓位；未知不冒充零', async () => {
  await db.put('state', { ...DEFAULT_SETTINGS, notifications: { ordersWebhook, alertsWebhook: '' } }, 'settings');
  await notify(db, { ...fill, direction: 'sell', priceUsd: '101.25', quantity: '0.03', amountUsd: '3.0375', remainingQuantity: '0' }, send);
  const text = JSON.parse(send.mock.calls[0]![1]!.body as string).content.text;
  for (const value of ['SOL / USDC', '卖出', '$101.25', '0.03 SOL', '3.0375 USDC', '0 SOL']) expect(text).toContain(value);
  await notify(db, { ...fill, orderId: 'legacy' }, send);
  expect(JSON.parse(send.mock.calls[1]![1]!.body as string).content.text).toContain('币对剩余仓位（确认核对时）：未获取');
});


it('英文通知使用保存的语言并保留实际数值，未知值不冒充零', async () => {
  await db.put('state', { ...DEFAULT_SETTINGS, language: 'en', notifications: { ordersWebhook, alertsWebhook } }, 'settings');
  await notify(db, { ...fill, direction: 'sell', priceUsd: '101.25', quantity: '0.03', amountUsd: '3.0375', remainingQuantity: '0' }, send);
  const text = JSON.parse(send.mock.calls[0]![1]!.body as string).content.text;
  for (const value of ['FOMO order filled', 'Side: Sell', 'Fill price: $101.25', '0.03 SOL', '3.0375 USDC', 'Remaining position at reconciliation: 0 SOL']) expect(text).toContain(value);
  expect(text).not.toMatch(/[\u3400-\u9fff]/);
  await notify(db, { ...fill, orderId: 'legacy-english' }, send);
  expect(JSON.parse(send.mock.calls[1]![1]!.body as string).content.text).toContain('Remaining position at reconciliation: Unavailable');
  await notify(db, { channel: 'alerts', code: 'english', message: 'FOMO 登录凭据失效，请回到网站检查登录状态' }, send);
  expect(JSON.parse(send.mock.calls[2]![1]!.body as string).content.text).toContain('FOMO system alert');
});
