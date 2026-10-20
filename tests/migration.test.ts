import 'fake-indexeddb/auto';
import { openDB } from 'idb';
import { expect, it } from 'vitest';
import { database, readSettings } from '../src/storage/database';
import { DEFAULT_SETTINGS } from '../src/shared/model';
import { SOL_ASSET } from './fixtures';

for (const version of [1, 2]) it(`v${version} 升级移除模拟仓位，旧单归档且不自动实盘`, async () => {
  const name = crypto.randomUUID();
  const old = await openDB(name, version, { upgrade(db) { db.createObjectStore('orders', { keyPath: 'id' }); db.createObjectStore('events', { keyPath: 'id' }); db.createObjectStore('state'); } });
  await old.put('orders', { id: 'legacy', accountId: 'test', ...(version === 2 ? { asset: SOL_ASSET } : {}), kind: 'limit-buy', targetPrice: '100', amountUsd: '9', status: 'waiting', createdAt: 1 });
  await old.put('orders', { id: 'old-fill', accountId: 'test', asset: SOL_ASSET, status: 'simulated', createdAt: 1 });
  await old.put('state', { accountId: 'test', quantity: '0.09', initializedAt: 1 }, 'paper:test');
  await old.put('state', { mode: 'paper', automatic: true, maxPriceAgeMs: 15000, webhook: 'old-private-address' }, 'settings');
  old.close();
  const db = await database(name);
  expect(await db.get('orders', 'legacy')).toMatchObject({ asset: SOL_ASSET, status: 'archived', legacy: true });
  expect(await db.get('orders', 'old-fill')).toMatchObject({ status: 'simulated', legacy: true });
  expect(await db.get('state', 'paper:test')).toBeUndefined();
  expect(await readSettings(db)).toEqual(DEFAULT_SETTINGS);
  expect((await db.getAll('logs'))[0]?.code).toBe('upgrade');
  db.close();
});

it('v3 升级保留通知配置、归档待触发单并关闭实盘和监控', async () => {
  const name = crypto.randomUUID();
  const old = await openDB(name, 3, { upgrade(db) {
    db.createObjectStore('orders', { keyPath: 'id' }); db.createObjectStore('events', { keyPath: 'id' }); db.createObjectStore('state');
    db.createObjectStore('logs', { keyPath: 'id' }).createIndex('at', 'at');
  } });
  await old.put('orders', { id: 'old', accountId: 'test', asset: SOL_ASSET, status: 'waiting' });
  await old.put('state', { ...DEFAULT_SETTINGS, slippageBps: undefined, automatic: true, realTrading: true,
    notifications: { ordersWebhook: 'https://open.feishu.cn/open-apis/bot/v2/hook/test-address', alertsWebhook: '' } }, 'settings');
  old.close(); const db = await database(name);
  expect((await db.get('orders', 'old'))?.status).toBe('archived');
  expect(await readSettings(db)).toMatchObject({ automatic: false, realTrading: false, slippageBps: undefined,
    notifications: { orders: { provider: 'feishu', webhook: 'https://open.feishu.cn/open-apis/bot/v2/hook/test-address' } } });
  db.close();
});
