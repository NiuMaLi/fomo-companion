import 'fake-indexeddb/auto';
import { expect, it } from 'vitest';
import { database } from '../src/storage/database';
import { orderSnapshot, writeLog } from '../src/storage/logs';
it('日志在重开后保留，正文移除地址和凭据', async () => {
  const name = crypto.randomUUID(); let db = await database(name);
  await writeLog(db, { category: 'system', level: 'error', code: 'test', message: 'https://open.feishu.cn/open-apis/bot/v2/hook/private-id Bearer private-token eyJhbGciOiJIUzI1NiJ9.payload.signature' });
  db.close(); db = await database(name);
  const logs = await db.getAll('logs');
  expect(logs).toHaveLength(1);
  expect(logs[0]?.message).not.toMatch(/private-id|private-token|payload.signature/);
  db.close();
});


it('订单快照只保留公开订单事实，独立保存零值与保护单计划', async () => {
  const order = { id: 'order', accountId: 'private-account', asset: { symbol: 'ETH', tokenAddress: 'public-contract', networkId: 8453, decimals: 18, logoUrl: 'https://private.example/image', privateKey: 'private-key' },
    kind: 'limit-buy' as const, status: 'confirmed' as const, targetPrice: '0.000000012345678901', amountUsd: '0.1', createdAt: 1,
    executionPrice: '0.00000001', fillQuantity: '10000000', fillUsd: '0.1', remainingQuantity: '0', transactionHash: 'public-hash',
    protection: { takeProfit: { targetPrice: '0.00000002', sellPercent: '30', extra: 'private-extra' } },
    reason: 'Bearer private-token https://private.example/request', executionReference: { originNetworkId: 1, credential: 'private-credential' } };
  const snapshot = orderSnapshot(order as any, { mode: 'live', observedPrice: '0' });
  order.protection.takeProfit.sellPercent = '100'; order.asset.symbol = 'CHANGED';
  const name = crypto.randomUUID(); let db = await database(name);
  await writeLog(db, { category: 'trade', level: 'info', code: 'order-confirmed', message: '已成交', orderId: order.id, order: snapshot });
  db.close(); db = await database(name);
  const saved = (await db.getAll('logs'))[0]!.order!;
  expect(saved).toMatchObject({ asset: { symbol: 'ETH', networkId: 8453 }, targetPrice: '0.000000012345678901', remainingQuantity: '0', observedPrice: '0', transactionNetworkId: 1, protection: { takeProfit: { sellPercent: '30' } } });
  expect(JSON.stringify(saved)).not.toMatch(/private-|logoUrl|executionReference|accountId/);
  db.close();
});
