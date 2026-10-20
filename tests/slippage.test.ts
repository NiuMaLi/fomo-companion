import 'fake-indexeddb/auto';
import { expect, it } from 'vitest';
import { DEFAULT_SETTINGS, draftSchema, type Order } from '../src/shared/model';
import { database, readSettings } from '../src/storage/database';
import { createOrder } from '../src/trading/engine';
import { createCoordinator } from '../src/trading/coordinator';
import { protectionOrders } from '../src/trading/protection';
import { parseQuote, parseRoutedQuote, quoteRequest, type Prepare } from '../src/trading/quote';
import { executionRequestSchema, ExecutionError } from '../src/shared/execution';
import { SOL_ASSET } from './fixtures';
const order = (slippageBps?: number): Order => ({ id: crypto.randomUUID(), accountId: 'test', asset: SOL_ASSET, kind: 'limit-buy', targetPrice: '110', amountUsd: '4', slippageBps, status: 'waiting', createdAt: Date.now() });
const prepare = (slippageBps?: number): Prepare => ({ action: 'prepare', attemptId: crypto.randomUUID(), order: order(slippageBps), slippageBps, maxPriceAgeMs: 15000 });
const quote = (bps = 300, out = '.04') => ({ success: true, responseObject: { source: 'solana', originChainType: 'SOLANA', tradeInfo: { slippageBps: bps }, v1Swap: { expectedOutHumanAmount: out, dynamicSlippageBps: bps, lastValidBlockHeight: 1000, swapTransaction: 'base64', feePayerAddress: 'payer', feePayerSignature: 'sig' } } });
it('单笔滑点持久保存，空值及零关闭且不继承旧全局设置', async () => {
  const name = crypto.randomUUID(); let db = await database(name); const now = Date.now();
  await db.put('state', { ...DEFAULT_SETTINGS, slippageBps: 500 }, 'settings');
  const session = { accountId: 'test', positions: [], minimumBuyUsd: '2', minimumSellUsd: '2', receivedAt: now };
  const price = { ...SOL_ASSET, priceUsd: '100', timestamp: now, receivedAt: now };
  for (const value of [undefined, 0, 75, 200]) await createOrder(db, order(value), session, price, now);
  db.close(); db = await database(name);
  expect((await db.getAll('orders')).map(o => o.slippageBps).sort((a,b)=>a!-b!)).toEqual([0,0,75,200]);
  expect((await db.getAll('logs')).every(l => l.order?.slippageBps !== undefined)).toBe(true);
  await db.put('state', DEFAULT_SETTINGS, 'settings'); expect((await readSettings(db)).slippageBps).toBeUndefined(); db.close();
});
it('委托和执行协议接受未配置或零，拒绝非法值；请求省略关闭的滑点参数', () => {
  for (const value of [undefined, 0, 1, 500]) {
    expect(draftSchema.safeParse(order(value)).success).toBe(true);
    expect(executionRequestSchema.safeParse(prepare(value)).success).toBe(true);
    const body=quoteRequest(prepare(value));
    if (!value) expect(body).not.toHaveProperty('slippageBps'); else expect(body.slippageBps).toBe(value);
  }
  for (const value of [-1, .5, 501, NaN]) {
    expect(draftSchema.safeParse(order(value)).success).toBe(false);
    expect(executionRequestSchema.safeParse(prepare(value)).success).toBe(false);
  }
});
for (const parse of [parseQuote, parseRoutedQuote]) it(`${parse.name} 空值或零不会当成零容忍，正值仍保护；限价保留目标检查`, () => {
  for (const value of [undefined, 0]) {
    expect(parse(quote(300), prepare(value), '100').priceUsd).toBe('100');
    const stop = prepare(value); stop.order = { ...stop.order, kind: 'stop-loss', quantity: '.04', targetPrice: '100' };
    expect(parse(quote(300, '3.2'), stop, '100').priceUsd).toBe('80');
    const limit = prepare(value); limit.order.targetPrice = '99';
    expect(() => parse(quote(), limit, '100')).toThrow('目标价格');
  }
  expect(() => parse(quote(300), prepare(100), '100')).toThrow('滑点');
  expect(parse(quote(50), prepare(100), '100').priceUsd).toBe('100');
  const stop=prepare(100);stop.order={...stop.order,kind:'stop-loss',quantity:'.04',targetPrice:'100'};
  expect(() => parse(quote(50, '3.2'),stop,'100')).toThrow('目标价格');
});
it('附带止盈止损继承本笔滑点，关闭状态也继承', () => {
  for (const value of [0, 75]) {
    const children=protectionOrders({...order(value),fillQuantity:'.04',protection:{takeProfit:{targetPrice:'120',sellPercent:'30'},stopLoss:{targetPrice:'90',sellPercent:'100'}}},Date.now());
    expect(children.map(o=>o.slippageBps)).toEqual([value,value]);
  }
});
it('执行协调器只传订单自己的滑点，旧全局设置不会成为缺省值', async () => {
  for (const value of [undefined, 0, 75, 200]) {
    const db=await database(crypto.randomUUID());await db.put('state',{...DEFAULT_SETTINGS,automatic:true,realTrading:true,slippageBps:500},'settings');
    const item=order(value);await db.put('orders',item);let requested: Prepare|undefined;
    const c=createCoordinator({db:Promise.resolve(db),allowed:()=>true,page:()=>1,call:async(_tab,request)=>{if(request.action==='prepare')requested=request;throw new ExecutionError('test','stop before signing');}});
    const now=Date.now();await c.tick({accountId:'test',positions:[],minimumBuyUsd:'2',minimumSellUsd:'2',receivedAt:now},{...SOL_ASSET,priceUsd:'100',timestamp:now,receivedAt:now},1);
    for(let i=0;i<50 && (await db.get('orders',item.id))?.status!=='failed';i++)await new Promise(r=>setTimeout(r,5));
    expect(requested).toBeDefined();expect(requested!.slippageBps).toBe(value||undefined);db.close();
  }
});
