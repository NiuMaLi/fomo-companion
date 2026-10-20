import 'fake-indexeddb/auto';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, type Order } from '../src/shared/model';
import { ExecutionError, USDC_ADDRESS, USDC_ID, type ExecutionResult } from '../src/shared/execution';
import { attachFeeSignature, base58, transaction, verifySignedTransaction } from '../src/trading/solana-transaction';
import { parseQuote, quoteRequest, type Prepare } from '../src/trading/quote';
import { parseReceipt } from '../src/trading/receipt';
import { createCoordinator, recoverExecution } from '../src/trading/coordinator';
import { database } from '../src/storage/database';
import { SOL_ASSET } from './fixtures';

const makeOrder = (patch: Partial<Order> = {}): Order => ({ id: crypto.randomUUID(), accountId: 'test', asset: SOL_ASSET,
  kind: 'limit-buy', targetPrice: '110', amountUsd: '4', status: 'waiting', createdAt: Date.now(), ...patch });
const prepare = (patch: Partial<Order> = {}): Prepare => ({ action: 'prepare', attemptId: crypto.randomUUID(), order: makeOrder(patch), slippageBps: 100, maxPriceAgeMs: 15000 });
const quote = (patch = {}) => ({ success: true, responseObject: { source: 'solana', originChainType: 'SOLANA', tradeInfo: { slippageBps: 100 },
  v1Swap: { expectedOutHumanAmount: .04, dynamicSlippageBps: 100, lastValidBlockHeight: 1000,
    swapTransaction: 'base64', feePayerSignature: 'signature', feePayerAddress: 'address', ...patch } } });
const hash = '3'.repeat(88);
const price = () => ({ ...SOL_ASSET, priceUsd: '100', timestamp: Date.now(), receivedAt: Date.now() });
const session = () => ({ accountId: 'test', positions: [], minimumBuyUsd: '2', minimumSellUsd: '2', receivedAt: Date.now() });
const eventually = async (predicate: () => Promise<boolean>) => {
  for (let i = 0; i < 100; i++) { if (await predicate()) return; await new Promise(r => setTimeout(r, 5)); }
  throw new Error('Expected coordinator state did not arrive');
};

describe('报价与金额精度', () => {
  it('买入以 USDC 六位原子单位报价，卖出使用代币精度', () => {
    expect(quoteRequest(prepare())).toMatchObject({ inTokenId: USDC_ID, amount: '4000000' });
    expect(quoteRequest(prepare({ kind: 'limit-sell', quantity: '.04' }))).toMatchObject({ outTokenId: USDC_ID, amount: '40000000' });
    expect(() => quoteRequest(prepare({ kind: 'limit-sell', quantity: '.0000000001' }))).toThrow('精度');
    expect(quoteRequest(prepare({ asset: { tokenAddress: '0x4200000000000000000000000000000000000006', networkId: 8453, symbol: 'ETH', decimals: 18 } }))).toMatchObject({ outTokenId: '0x4200000000000000000000000000000000000006:8453', amount: '4000000' });
  });
  it('限价按最差滑点价格判断；止损仍限制执行偏差', () => {
    expect(parseQuote(quote(), prepare(), '100').priceUsd).toBe('100');
    expect(() => parseQuote(quote(), prepare({ targetPrice: '100' }), '100')).toThrow('目标价格');
    const sell = quote({ expectedOutHumanAmount: 4 });
    expect(parseQuote(sell, prepare({ kind: 'limit-sell', quantity: '.04', targetPrice: '99' }), '100').amountUsd).toBe('4');
    expect(() => parseQuote(sell, prepare({ kind: 'limit-sell', quantity: '.04', targetPrice: '100' }), '100')).toThrow('目标价格');
    expect(() => parseQuote(quote({ expectedOutHumanAmount: 3.9 }), prepare({ kind: 'stop-loss', quantity: '.04' }), '100')).toThrow('目标价格');
  });
  it('拒绝捆绑交易、超出滑点与过大价格影响', () => {
    expect(() => parseQuote(quote({ jitoTipTx: 'unsupported' }), prepare(), '100')).toThrow('捆绑');
    expect(() => parseQuote(quote({ dynamicSlippageBps: 200 }), prepare(), '100')).toThrow('滑点');
    expect(() => parseQuote(quote({ priceImpactPct: .06 }), prepare(), '100')).toThrow('5%');
  });
});

it('平台拒绝最低额时照实显示，不重试放大金额', () => {
  expect(() => parseQuote({ success: false, errorCode: 'ERR_SWAP_BELOW_MINIMUM' }, prepare({ amountUsd: '0.1' }), '100')).toThrow('平台当前最低金额');
});

describe('交易字节和签名校验', () => {
  async function envelope(versioned: boolean | 'v1' = true) {
    const payer = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
    const user = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
    const payerKey = new Uint8Array(await crypto.subtle.exportKey('raw', payer.publicKey));
    const userKey = new Uint8Array(await crypto.subtle.exportKey('raw', user.publicKey));
    const message = versioned === 'v1' ? new Uint8Array([129, 2, ...new Uint8Array(40), ...payerKey, ...userKey, 0]) : new Uint8Array([...(versioned ? [128] : []), 2, 0, 0, 2, ...payerKey, ...userKey, ...new Uint8Array(32), 0, ...(versioned ? [0] : [])]);
    const bytes = versioned === 'v1' ? new Uint8Array([...message, ...new Uint8Array(128)]) : new Uint8Array([2, ...new Uint8Array(128), ...message]);
    const feeSignature = new Uint8Array(await crypto.subtle.sign('Ed25519', payer.privateKey, message));
    const unsigned = attachFeeSignature(bytes, base58(payerKey), feeSignature);
    const signed = unsigned.slice();
    signed.set(new Uint8Array(await crypto.subtle.sign('Ed25519', user.privateKey, message)), transaction(signed).signatureOffset + 64);
    return { unsigned, signed, userKey };
  }
  for (const versioned of [true, false, 'v1'] as const) it(`校验 ${versioned ? 'v0' : 'legacy'} 消息及所有签名，保留代付签名`, async () => {
    const { unsigned, signed, userKey } = await envelope(versioned);
    expect(transaction(signed).signers).toHaveLength(2);
    expect(await verifySignedTransaction(unsigned, signed, userKey)).toBe(base58(transaction(signed).signatures[0]!));
    const changed = signed.slice(); changed[transaction(changed).messageOffset + 10] = changed[transaction(changed).messageOffset + 10]! ^ 1;
    await expect(verifySignedTransaction(unsigned, changed, userKey)).rejects.toThrow('内容');
    const feeChanged = signed.slice(); feeChanged[transaction(feeChanged).signatureOffset] = feeChanged[transaction(feeChanged).signatureOffset]! ^ 1;
    await expect(verifySignedTransaction(unsigned, feeChanged, userKey)).rejects.toThrow('已有签名');
    await expect(verifySignedTransaction(unsigned, unsigned, userKey)).rejects.toThrow('缺少');
    const bad = signed.slice(); bad[transaction(bad).signatureOffset + 64] = bad[transaction(bad).signatureOffset + 64]! ^ 1;
    await expect(verifySignedTransaction(unsigned, bad, userKey)).rejects.toThrow('签名校验');
  });
  it('拒绝截断的交易头', () => {
    expect(() => transaction(new Uint8Array([16, ...new Uint8Array(110)]))).toThrow();
  });
});

describe('链上成交回执', () => {
  const balance = (mint: string, amount: string) => ({ mint, owner: 'wallet', uiTokenAmount: { amount, decimals: mint === USDC_ADDRESS ? 6 : 9 } });
  it('确认 SPL 代币买入／卖出方向和实际金额，排除其他钱包', () => {
    const asset = { ...SOL_ASSET, tokenAddress: 'other-mint' };
    const raw = { transaction: { message: {} }, meta: { err: null,
      preTokenBalances: [balance(USDC_ADDRESS, '10000000')], postTokenBalances: [balance(USDC_ADDRESS, '6000000'), balance(asset.tokenAddress, '40000000')] } };
    expect(parseReceipt(raw, 'wallet', asset)).toMatchObject({ state: 'confirmed', direction: 'buy', quantity: '0.04', amountUsd: '4', priceUsd: '100', remainingQuantity: '0.04' });
    expect(parseReceipt({ ...raw, meta: { ...raw.meta, preTokenBalances: raw.meta.postTokenBalances, postTokenBalances: raw.meta.preTokenBalances } }, 'wallet', asset)).toMatchObject({ direction: 'sell' });
    expect(parseReceipt(raw, 'someone-else', asset).state).toBe('pending');
    expect(parseReceipt({ ...raw, meta: { err: { InstructionError: [0, 'Failed'] } } }, 'wallet', asset).state).toBe('failed');
  });
  it('SOL 使用 lamports 变化，扣除本人支付的链上手续费', () => {
    const raw = { transaction: { message: { accountKeys: [{ pubkey: 'wallet' }] } }, meta: { err: null, fee: 5000,
      preBalances: [100000000], postBalances: [139995000], preTokenBalances: [balance(USDC_ADDRESS, '10000000')], postTokenBalances: [balance(USDC_ADDRESS, '6000000')] } };
    expect(parseReceipt(raw, 'wallet', SOL_ASSET)).toMatchObject({ state: 'confirmed', direction: 'buy', quantity: '0.04', amountUsd: '4', remainingQuantity: '0.139995' });
  });
});

describe('持久交易协调器', () => {
  async function fixture() {
    const db = await database(crypto.randomUUID());
    await db.put('state', { ...DEFAULT_SETTINGS, automatic: true, realTrading: true }, 'settings');
    const order = makeOrder(); await db.put('orders', order);
    return { db, order };
  }
  it('并发触发仅执行一次；持久化哈希完成后才提交；只有真实回执标记成交', async () => {
    const { db, order } = await fixture(); const actions: string[] = [];
    const call = vi.fn(async (_tab, req): Promise<ExecutionResult> => {
      actions.push(req.action);
      if (req.action === 'prepare') return { state: 'prepared' };
      if (req.action === 'sign') return { state: 'signed', transactionHash: hash };
      if (req.action === 'submit') {
        expect(await db.get('orders', order.id)).toMatchObject({ transactionHash: hash, status: 'submitted' });
        return { state: 'submitted', transactionHash: hash };
      }
      return { state: 'confirmed', direction: 'buy', quantity: '.04', amountUsd: '4', priceUsd: '100' };
    });
    const c = createCoordinator({ db: Promise.resolve(db), call, allowed: () => true, page: () => 1 });
    await Promise.all([c.tick(session(), price(), 1), c.tick(session(), price(), 1)]);
    await eventually(async () => (await db.get('orders', order.id))?.status === 'confirmed');
    expect(actions).toEqual(['prepare', 'sign', 'submit', 'receipt']);
    expect((await db.getAll('logs')).filter(l => l.code === 'order-confirmed')).toHaveLength(1);
    expect((await db.getAll('logs')).find(l => l.code === 'order-confirmed')?.order).toMatchObject({ status: 'confirmed', transactionHash: hash, executionPrice: '100', fillQuantity: '.04', fillUsd: '4', mode: 'live' });
    expect((await db.getAll('logs')).find(l => l.code === 'transaction-submitted')?.order).toMatchObject({ status: 'submitted', transactionHash: hash });
    expect(await db.get('orders', order.id)).toMatchObject({ notificationHandled: true, notifyOrder: false });
    db.close();
  });
  it('等待签名时关闭真实开关，签名返回后也不会提交', async () => {
    const { db, order } = await fixture(); let release!: (r: ExecutionResult) => void;
    const call = vi.fn(async (_tab, req): Promise<ExecutionResult> => req.action === 'prepare' ? { state: 'prepared' }
      : req.action === 'sign' ? new Promise(resolve => { release = resolve; }) : { state: 'submitted' });
    const c = createCoordinator({ db: Promise.resolve(db), call, allowed: () => true, page: () => 1 });
    await c.tick(session(), price(), 1); await eventually(async () => !!release);
    await db.put('state', DEFAULT_SETTINGS, 'settings'); release({ state: 'signed', transactionHash: hash });
    await eventually(async () => (await db.get('orders', order.id))?.status === 'failed');
    expect(call.mock.calls.map(c => c[1].action)).toEqual(['prepare', 'sign']); db.close();
  });
  it('重启恢复的未知交易只查询回执，不重新签名或广播，并阻止新交易', async () => {
    const { db, order } = await fixture();
    await db.put('orders', { ...order, status: 'submitted', transactionHash: hash });
    const next = makeOrder(); await db.put('orders', next);
    await recoverExecution(db);
    expect((await db.get('orders', order.id))?.status).toBe('unknown');
    const call = vi.fn(async (_tab: number, _request: import('../src/shared/execution').ExecutionRequest): Promise<ExecutionResult> => ({ state: 'pending' }));
    const c = createCoordinator({ db: Promise.resolve(db), call, allowed: () => true, page: () => 1 });
    await c.tick(session(), price(), 1); await c.reconcile();
    expect(call).toHaveBeenCalledTimes(1); expect(call.mock.calls[0]![1].action).toBe('receipt');
    expect((await db.get('orders', next.id))?.status).toBe('waiting'); db.close();
  });
  it('重启时准备中订单结束为失败；报价未达限价可以等下次，但不记录成交', async () => {
    const { db, order } = await fixture();
    await db.put('orders', { ...order, status: 'preparing' }); await recoverExecution(db);
    expect((await db.get('orders', order.id))?.status).toBe('failed');
    await db.put('orders', order);
    const call = vi.fn(async () => { throw new ExecutionError('target', '等待报价', true); });
    const c = createCoordinator({ db: Promise.resolve(db), call, allowed: () => true, page: () => 1 });
    await c.tick(session(), price(), 1);
    await eventually(async () => (await db.get('orders', order.id))?.status === 'waiting');
    expect((await db.getAll('logs')).some(l => l.code === 'order-confirmed')).toBe(false); db.close();
  });
});

describe('附带止盈止损执行', () => {
  const protection = { takeProfit: { targetPrice: '120', sellPercent: '30' }, stopLoss: { targetPrice: '90', sellPercent: '100' } };
  async function setup() {
    const db = await database(crypto.randomUUID());
    await db.put('state', { ...DEFAULT_SETTINGS, automatic: true, realTrading: true }, 'settings');
    const parent = makeOrder({ protection, status: 'submitted', transactionHash: hash });
    await db.put('orders', parent);
    return { db, parent };
  }
  it('成交和子单原子持久化，按实际成交量舍入，重启核对不重复生成', async () => {
    const { db, parent } = await setup(); const changed = vi.fn(async () => {});
    const call = vi.fn(async (): Promise<ExecutionResult> => ({ state: 'confirmed', direction: 'buy', quantity: '0.041234567', amountUsd: '4', priceUsd: '97.00599', remainingQuantity: '1.041234567' }));
    const c = createCoordinator({ db: Promise.resolve(db), call, allowed: () => true, page: () => 1, changed });
    await c.reconcile();
    const children = (await db.getAll('orders')).filter(o => o.parentOrderId === parent.id);
    expect(children).toHaveLength(2);
    expect(children.find(o => o.kind === 'take-profit')).toMatchObject({ status: 'waiting', quantity: '0.01237037', ocoGroupId: parent.id });
    expect(children.find(o => o.kind === 'stop-loss')?.quantity).toBe('0.041234567');
    expect((await db.get('orders', parent.id))?.remainingQuantity).toBe('1.041234567');
    expect(changed).toHaveBeenCalledTimes(1);
    const name = db.name; db.close(); const reopened = await database(name);
    await createCoordinator({ db: Promise.resolve(reopened), call, allowed: () => true, page: () => 1 }).reconcile();
    expect(await reopened.count('orders')).toBe(3); reopened.close();
  });
  it('父单失败不创建保护单，保护数量舍入为零时阻止执行', async () => {
    const { db, parent } = await setup();
    const c = createCoordinator({ db: Promise.resolve(db), call: async () => ({ state: 'failed' }), allowed: () => true, page: () => 1 });
    await c.reconcile(); expect(await db.count('orders')).toBe(1); expect((await db.get('orders', parent.id))?.status).toBe('failed'); db.close();
    const { protectionOrders } = await import('../src/trading/protection');
    expect(protectionOrders({ ...parent, fillQuantity: '0.000000001' }, Date.now()).find(o => o.kind === 'take-profit')?.status).toBe('blocked');
  });
  it('保护单并发触发只执行一侧，确认后取消同组另一侧，不影响独立单', async () => {
    const { db, parent } = await setup();
    await db.put('orders', { ...parent, status: 'confirmed' });
    const tp = makeOrder({ id: 'tp', kind: 'take-profit', targetPrice: '120', quantity: '0.012', parentOrderId: parent.id, ocoGroupId: parent.id });
    const sl = makeOrder({ id: 'sl', kind: 'stop-loss', targetPrice: '90', quantity: '0.04', parentOrderId: parent.id, ocoGroupId: parent.id });
    const independent = makeOrder({ targetPrice: '1' });
    await db.put('orders', tp); await db.put('orders', sl); await db.put('orders', independent);
    const call = vi.fn(async (_tab, req): Promise<ExecutionResult> => req.action === 'prepare' ? { state: 'prepared' } : req.action === 'sign' ? { state: 'signed', transactionHash: hash } : req.action === 'submit' ? { state: 'submitted' } : { state: 'confirmed', direction: 'sell', quantity: '0.012', amountUsd: '1.5', priceUsd: '125', remainingQuantity: '0.028' });
    const c = createCoordinator({ db: Promise.resolve(db), call, allowed: () => true, page: () => 1 });
    await Promise.all([c.tick(session(), { ...price(), priceUsd: '125' }, 1), c.tick(session(), { ...price(), priceUsd: '85' }, 1)]);
    await eventually(async () => (await db.get('orders', tp.id))?.status === 'confirmed');
    expect((await db.get('orders', sl.id))?.status).toBe('cancelled');
    expect((await db.get('orders', independent.id))?.status).toBe('waiting');
    expect(call.mock.calls.filter(c => c[1].action === 'submit')).toHaveLength(1); db.close();
  });
  it('一侧结果未知时，另一侧不能抢占执行或释放仓位', async () => {
    const { db, parent } = await setup(); await db.put('orders', { ...parent, status: 'confirmed' });
    const unknown = makeOrder({ kind: 'take-profit', status: 'unknown', quantity: '0.04', transactionHash: hash, ocoGroupId: parent.id });
    const sibling = makeOrder({ kind: 'stop-loss', targetPrice: '110', quantity: '0.04', ocoGroupId: parent.id });
    await db.put('orders', unknown); await db.put('orders', sibling);
    const call = vi.fn(async (): Promise<ExecutionResult> => ({ state: 'pending' }));
    const c = createCoordinator({ db: Promise.resolve(db), call, allowed: () => true, page: () => 1 });
    await c.tick(session(), price(), 1); expect(call).not.toHaveBeenCalled();
    expect((await db.get('orders', sibling.id))?.status).toBe('waiting'); db.close();
  });
});

it('重启待发送通知复用成交价量值与剩余快照，不重查成交或重复发送', async () => {
  const db = await database(crypto.randomUUID());
  const order = makeOrder({ status: 'confirmed', transactionHash: hash, confirmedAt: Date.now(), executionPrice: '100', fillQuantity: '0.04', fillUsd: '4', remainingQuantity: '0', notifyOrder: true, notificationHandled: false });
  await db.put('orders', order);
  await db.put('state', { ...DEFAULT_SETTINGS, notifications: { ordersWebhook: 'https://open.feishu.cn/open-apis/bot/v2/hook/test-only-webhook', alertsWebhook: '' } }, 'settings');
  const send = vi.fn(async () => Response.json({ code: 0 })); vi.stubGlobal('fetch', send);
  const call = vi.fn(async (): Promise<ExecutionResult> => ({ state: 'pending' }));
  try {
    const c = createCoordinator({ db: Promise.resolve(db), call, allowed: () => true, page: () => 1 });
    await c.reconcile(); await c.reconcile();
    expect(send).toHaveBeenCalledTimes(1); expect(call).not.toHaveBeenCalled();
    const body = JSON.parse((send.mock.calls[0] as any)[1].body).content.text;
    for (const value of ['$100', '0.04 SOL', '4 USDC', '0 SOL']) expect(body).toContain(value);
    expect((await db.get('orders', order.id))?.notificationHandled).toBe(true);
  } finally { vi.unstubAllGlobals(); db.close(); }
});
