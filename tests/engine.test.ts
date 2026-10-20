import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, type Price, type Session } from '../src/shared/model';
import { NETWORK, SOL, SOL_ASSET } from './fixtures';
import { database, type DB } from '../src/storage/database';
import { createOrder, evaluate, fresh, percentage, triggered } from '../src/trading/engine';

const now = 1800000000000;
const session: Session = { accountId: 'test-account', positions: [], minimumBuyUsd: '2', minimumSellUsd: '2', receivedAt: now };
const quote = (value = '100', at = now): Price => ({ tokenAddress: SOL, networkId: NETWORK, priceUsd: value, timestamp: at, receivedAt: at });
const holdings = (quantity = '0.09'): Session => ({ ...session, positions: [{ ...SOL_ASSET, quantity }] });
let db: DB;
beforeEach(async () => { db = await database(crypto.randomUUID()); await db.put('state', { ...DEFAULT_SETTINGS, automatic: true }, 'settings'); });
afterEach(() => db.close());

describe('价格与触发', () => {
  it('区分买卖、止盈、止损及相等边界', () => {
    for (const kind of ['limit-buy', 'stop-loss'] as const) {
      expect(triggered({ kind, targetPrice: '100' }, '99')).toBe(true);
      expect(triggered({ kind, targetPrice: '100' }, '101')).toBe(false);
      expect(triggered({ kind, targetPrice: '100' }, '100')).toBe(true);
    }
    for (const kind of ['limit-sell', 'take-profit'] as const) {
      expect(triggered({ kind, targetPrice: '100' }, '99')).toBe(false);
      expect(triggered({ kind, targetPrice: '100' }, '101')).toBe(true);
    }
  });
  it('计算涨跌幅并拒绝零基准', () => {
    expect(percentage('110', '100')).toBe('10.00'); expect(percentage('90', '100')).toBe('-10.00');
    expect(percentage('100', '0')).toBeUndefined();
  });
  it('拒绝旧行情和未来时间戳', () => {
    expect(fresh(quote('100', now - 20000), now, 15000)).toBe(false);
    expect(fresh(quote('100', now + 10000), now, 15000)).toBe(false);
  });
});

describe('真实余额与只监控', () => {
  it('SOL 仅是实盘测试范围，不限制产品买入金额', async () => {
    const order = await createOrder(db, { asset: SOL_ASSET, kind: 'limit-buy', targetPrice: '100', amountUsd: '25' }, session, quote(), now);
    await evaluate(db, session, quote(), now);
    expect((await db.get('orders', order.id))?.status).toBe('waiting');
    expect(await db.getAllKeys('state')).toEqual(['settings']);
    expect(session.positions).toEqual([]);
  });
  it('拒绝非正金额或非法卖出比例的订单', async () => {
    await expect(createOrder(db, { asset: SOL_ASSET, kind: 'limit-buy', targetPrice: '100', amountUsd: '0' }, session, quote(), now)).rejects.toThrow('大于零');
    await expect(createOrder(db, { asset: SOL_ASSET, kind: 'limit-sell', targetPrice: '100', sellPercent: '101' }, holdings(), quote(), now)).rejects.toThrow('比例');
    expect(await db.count('orders')).toBe(0); expect(await db.count('logs')).toBe(0);
  });
  it('卖单数量固定并预留，不能超卖真实持仓', async () => {
    const order = await createOrder(db, { asset: SOL_ASSET, kind: 'limit-sell', targetPrice: '110', sellPercent: '50' }, holdings(), quote(), now);
    expect(order.quantity).toBe('0.045');
    await expect(createOrder(db, { asset: SOL_ASSET, kind: 'take-profit', targetPrice: '110', sellPercent: '100' }, holdings(), quote(), now)).rejects.toThrow('预留');
  });
  it('重复并发推送及重新打开数据库只记录一次触达，绝不模拟成交', async () => {
    const order = await createOrder(db, { asset: SOL_ASSET, kind: 'limit-buy', targetPrice: '100', amountUsd: '9' }, session, quote(), now);
    await Promise.all([evaluate(db, session, quote(), now), evaluate(db, session, quote(), now)]);
    const name = db.name; db.close(); db = await database(name);
    await evaluate(db, session, quote(), now);
    expect((await db.getAll('logs')).filter(l => l.code === 'target-reached')).toHaveLength(1);
    expect(await db.get('orders', order.id)).toMatchObject({ status: 'waiting', triggeredAt: now });
    expect((await db.get('orders', order.id))?.executedAt).toBeUndefined();
    expect(await db.count('events')).toBe(0);
  });
  it('监控关闭、账户过期、行情过期和其他账户均不触发', async () => {
    await createOrder(db, { asset: SOL_ASSET, kind: 'limit-buy', targetPrice: '100', amountUsd: '9' }, session, quote(), now);
    await db.put('state', DEFAULT_SETTINGS, 'settings'); await evaluate(db, session, quote(), now);
    await db.put('state', { ...DEFAULT_SETTINGS, automatic: true }, 'settings');
    await evaluate(db, { ...session, receivedAt: now - 60000 }, quote(), now);
    await evaluate(db, session, quote('100', now - 60000), now);
    await evaluate(db, { ...session, accountId: 'other' }, quote(), now);
    expect((await db.getAll('logs')).filter(l => l.code === 'target-reached')).toHaveLength(0);
  });
  it('监控买单触达后仍不能用不存在的持仓卖出', async () => {
    await createOrder(db, { asset: SOL_ASSET, kind: 'limit-buy', targetPrice: '100', amountUsd: '9' }, session, quote(), now);
    await evaluate(db, session, quote(), now);
    await expect(createOrder(db, { asset: SOL_ASSET, kind: 'limit-sell', targetPrice: '100', sellPercent: '100' }, session, quote(), now)).rejects.toThrow('不足');
  });
});

describe('多币种', () => {
  const other = { tokenAddress: '3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh', networkId: NETWORK, symbol: 'BTC', decimals: 8 };
  it('按自身资产订阅触达，不由其他币种价格触发', async () => {
    const price = { ...quote(), tokenAddress: other.tokenAddress };
    const order = await createOrder(db, { asset: other, kind: 'limit-buy', targetPrice: '100', amountUsd: '25' }, session, price, now);
    await evaluate(db, session, quote(), now);
    expect((await db.get('orders', order.id))?.triggeredAt).toBeUndefined();
    await evaluate(db, session, price, now);
    expect((await db.get('orders', order.id))?.triggeredAt).toBe(now);
  });
  it('拒绝币种切换后的旧表单', async () => {
    await expect(createOrder(db, { asset: other, kind: 'limit-buy', targetPrice: '100', amountUsd: '9' }, session, quote(), now)).rejects.toThrow('币种已切换');
  });
  it('只读取对应币种真实余额并向下取整', async () => {
    const multi = { ...holdings(), positions: [...holdings().positions, { ...other, quantity: '1000.123456789' }] };
    const order = await createOrder(db, { asset: other, kind: 'limit-sell', targetPrice: '1', sellPercent: '50' }, multi, { ...quote('1'), tokenAddress: other.tokenAddress }, now);
    expect(order.quantity).toBe('500.06172839');
    expect(multi.positions[1]?.quantity).toBe('1000.123456789');
  });
  it('不以前端平台配置作为本地最低额限制', async () => {
    const asset = { tokenAddress: '0xcb585250f852c6c6bf90434ab21a00f02833a4af', networkId: 8453, symbol: 'TEST', decimals: 18 };
    const multi = { ...session, minimumsByNetwork: { '8453': { buy: '5', sell: '4' } } };
    expect((await createOrder(db, { asset, kind: 'limit-buy', targetPrice: '100', amountUsd: '3' }, multi, { ...quote(), ...asset }, now)).amountUsd).toBe('3');
  });
});

it('允许低于 2U 的买卖；拒绝零数量和不足精度', async () => {
  expect((await createOrder(db, { asset: SOL_ASSET, kind: 'limit-buy', targetPrice: '100', amountUsd: '0.1' }, session, quote(), now)).amountUsd).toBe('0.1');
  expect((await createOrder(db, { asset: SOL_ASSET, kind: 'limit-sell', targetPrice: '100', sellPercent: '1' }, holdings(), quote(), now)).quantity).toBe('0.0009');
  await expect(createOrder(db, { asset: SOL_ASSET, kind: 'limit-sell', targetPrice: '100', sellPercent: '0.00000001' }, holdings(), quote(), now)).rejects.toThrow('精度');
  await expect(createOrder(db, { asset: SOL_ASSET, kind: 'limit-buy', targetPrice: '100', amountUsd: '0.00000000001' }, session, quote(), now)).rejects.toThrow('精度');
});
it('无持仓可以买入并保存附带保护，未成交不启用子单', async () => {
  const protection = { takeProfit: { targetPrice: '120', sellPercent: '30' }, stopLoss: { targetPrice: '90', sellPercent: '100' } };
  const order = await createOrder(db, { asset: SOL_ASSET, kind: 'limit-buy', targetPrice: '100', amountUsd: '1', protection }, session, quote(), now);
  expect(order.protection).toEqual(protection); expect(await db.count('orders')).toBe(1);
  await expect(createOrder(db, { ...order, protection: { takeProfit: { targetPrice: '99', sellPercent: '100' } } }, session, quote(), now)).rejects.toThrow('高于');
  await expect(createOrder(db, { ...order, protection: { stopLoss: { targetPrice: '101', sellPercent: '100' } } }, session, quote(), now)).rejects.toThrow('低于');
  await expect(createOrder(db, { ...order, protection: { stopLoss: { targetPrice: '90', sellPercent: '101' } } }, session, quote(), now)).rejects.toThrow('比例');
  await expect(createOrder(db, { ...order, kind: 'limit-sell' }, session, quote(), now)).rejects.toThrow('仅适用');
});
it('互斥保护仅预留较大一侧，独立卖单仍受总仓位限制', async () => {
  const base = { accountId: session.accountId, asset: SOL_ASSET, targetPrice: '120', status: 'waiting' as const, createdAt: now, ocoGroupId: 'parent' };
  await db.put('orders', { ...base, id: 'tp', kind: 'take-profit', quantity: '0.03' });
  await db.put('orders', { ...base, id: 'sl', kind: 'stop-loss', targetPrice: '90', quantity: '0.05' });
  expect((await createOrder(db, { asset: SOL_ASSET, kind: 'limit-sell', targetPrice: '110', sellPercent: '40' }, holdings('0.1'), quote(), now)).quantity).toBe('0.04');
  await expect(createOrder(db, { asset: SOL_ASSET, kind: 'limit-sell', targetPrice: '110', sellPercent: '20' }, holdings('0.1'), quote(), now)).rejects.toThrow('预留');
});


it('创建与触达分别保存事件时快照；之后订单变化不改写历史', async () => {
  const order = await createOrder(db, { asset: SOL_ASSET, kind: 'limit-buy', targetPrice: '99', amountUsd: '0.1' }, session, quote(), now);
  await evaluate(db, session, quote('98', now + 1), now + 1);
  await db.put('orders', { ...order, status: 'cancelled' });
  const logs = await db.getAll('logs');
  expect(logs.find(l => l.code === 'order-created')?.order).toMatchObject({ status: 'waiting', observedPrice: '100', mode: 'monitor', amountUsd: '0.1' });
  expect(logs.find(l => l.code === 'order-created')?.order?.triggeredAt).toBeUndefined();
  expect(logs.find(l => l.code === 'target-reached')?.order).toMatchObject({ status: 'waiting', observedPrice: '98', triggeredAt: now + 1 });
});
