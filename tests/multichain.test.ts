import 'fake-indexeddb/auto';
import { describe, expect, it, vi } from 'vitest';
import { FOMO_CHAINS, transactionUrl } from '../src/shared/chains';
import { DEFAULT_SETTINGS, assetKey, type Order } from '../src/shared/model';
import { USDC_ID, type ExecutionRequest, type ExecutionResult } from '../src/shared/execution';
import { quoteRequest, parseRoutedQuote, type Prepare } from '../src/trading/quote';
import { executeNative, evmCalls, nativeRoute } from '../src/trading/native-runtime';
import { indexedFill, routedReceipt } from '../src/trading/routed-receipt';
import { createCoordinator, recoverExecution } from '../src/trading/coordinator';
import { createOrder, evaluate } from '../src/trading/engine';
import { database } from '../src/storage/database';

const asset = { tokenAddress: '0x4200000000000000000000000000000000000006', networkId: 8453, symbol: 'ETH', decimals: 18 };
const hash = '0x' + 'a'.repeat(64), outHash = '0x' + 'b'.repeat(64), uoHash = '0x' + 'c'.repeat(64);
const order = (): Order => ({ id: crypto.randomUUID(), asset, accountId: 'test', kind: 'limit-buy', targetPrice: '110', amountUsd: '4', status: 'waiting', createdAt: Date.now() });
const prepare = (): Prepare => ({ action: 'prepare', attemptId: crypto.randomUUID(), order: order(), slippageBps: 100, maxPriceAgeMs: 15000 });
const tx = (n: number) => ({ chainId: 8453, to: '0x' + String(n).repeat(40), data: '0x12', value: '0', gas: '100' });
const route = () => nativeRoute({ source: 'relay', originChainType: 'EVM', v2Swap: {
  relaySwapId: 'intent-test', relayTransaction: { type: 'EVM', preTransactions: [tx(1)], approvalTransaction: tx(2), depositTransaction: tx(3), postTransactions: [tx(4)] },
} }, USDC_ID, assetKey(asset));
const receiptRequest = (): Extract<ExecutionRequest, { action: 'receipt' }> => ({ action: 'receipt', accountId: 'test', asset, kind: 'limit-buy', transactionHash: hash, reference: route().reference });
const detail = (signature = outHash) => ({ userId: 'test', swaps: [{ signature, inTokenAddress: USDC_ID.split(':')[0], inNetworkId: 1399811149,
  outTokenAddress: asset.tokenAddress, outNetworkId: 8453, inHumanAmount: '4', outHumanAmount: '0.039', humanUsdAmountIn: '4', humanUsdAmountOut: '3.9' }] });

describe('全部现货网络的报价与交易入口', () => {
  for (const networkId of Object.values(FOMO_CHAINS)) it(`${networkId} 买卖按对应币种编码，不设 SOL 或金额白名单`, () => {
    const p = prepare(); p.order.asset = networkId === 1399811149 ? { tokenAddress: 'So11111111111111111111111111111111111111112', networkId, symbol: 'SOL', decimals: 9 } : { ...asset, networkId };
    p.order.amountUsd = '0.1';
    expect(quoteRequest(p)).toMatchObject({ inTokenId: USDC_ID, outTokenId: assetKey(p.order.asset), amount: '100000' });
    p.order.kind = 'limit-sell'; p.order.quantity = '0.001';
    expect(quoteRequest(p)).toMatchObject({ inTokenId: assetKey(p.order.asset), outTokenId: USDC_ID, amount: networkId === 1399811149 ? '1000000' : '1000000000000000' });
  });
  for (const source of ['relay', 'mobula', 'solana']) it(`${source} 报价仅用于校验，不当成成交`, () => {
    const raw = { expectedOutHumanAmount: '.04' };
    const b = { success: true, responseObject: { source, originChainType: 'SOLANA', v2Swap: raw, mobulaSwap: raw, v1Swap: raw } };
    expect(parseRoutedQuote(b, prepare(), '100').priceUsd).toBe('100');
    expect(() => parseRoutedQuote(b, { ...prepare(), order: { ...order(), targetPrice: '99' } }, '100')).toThrow('目标');
  });
  it('EVM 按 pre/approval/deposit/post 顺序执行，拒绝错链、无 gas、非法金额', () => {
    const r = route(); const calls = evmCalls(r);
    expect(calls.calls.map((c: { to: string }) => c.to)).toEqual([1, 2, 3, 4].map(n => tx(n).to)); expect(calls.gas).toBe(600n);
    r.raw.relayTransaction.depositTransaction.chainId = 56; expect(() => evmCalls(r)).toThrow('网络');
    r.raw.relayTransaction.depositTransaction = { ...tx(3), gas: undefined }; expect(() => evmCalls(r)).toThrow('Gas');
    r.raw.relayTransaction.depositTransaction = { ...tx(3), value: '-1' }; expect(() => evmCalls(r)).toThrow('格式');
  });
  it('交易浏览器跟随提交网络', () => {
    expect(transactionUrl(hash, 8453)).toContain('basescan.org'); expect(transactionUrl(hash, 56)).toContain('bscscan.com');
    expect(transactionUrl(hash, 999)).toBeUndefined();
  });
});

describe('平台原生执行与关闭开关', () => {
  const wallet = () => ({ address: '0x' + '1'.repeat(40), getEthereumProvider: vi.fn(async () => ({ request: vi.fn(async () => 'signature') })) });
  it('EVM 提交一次并保留 UserOperation 哈希，回执超时后保持 unknown', async () => {
    const progress = vi.fn(), r = route(), w = wallet(); let submissions = 0;
    const ar = async (input: any) => {
      const sendUserOperation = true, waitForUserOperationReceipt = true;
      await (await input.wallet.getEthereumProvider()).request({ method: 'secp256k1_sign' });
      input.onSubmissionAttempted(); submissions++;
      input.logEvent('tx_submitted', { uoHash });
      if (sendUserOperation && waitForUserOperationReceipt) throw new Error('Timeout with private details');
    };
    const result = await executeNative(r, { evm: w }, () => {}, progress, async () => ({ ar }));
    expect(result).toMatchObject({ state: 'unknown', submissionAttempted: true, reference: { userOperationHash: uoHash } });
    expect(submissions).toBe(1); expect(progress).toHaveBeenCalledWith({ userOperationHash: uoHash });
    expect(result.message).not.toContain('private');
  });
  it('签名等待中关闭开关，签名晚返回仍不能提交', async () => {
    let revoked = false, submit = 0;
    const ar = async (input: any) => {
      const sendUserOperation = true, waitForUserOperationReceipt = true;
      const p = await input.wallet.getEthereumProvider(); revoked = true;
      await p.request({ method: 'secp256k1_sign' });
      input.onSubmissionAttempted(); if (sendUserOperation && waitForUserOperationReceipt) submit++;
    };
    const w = wallet(); const check = () => { if (revoked) throw new Error('disabled'); };
    expect(await executeNative(route(), { evm: w }, check, () => {}, async () => ({ ar }))).toMatchObject({ state: 'failed', submissionAttempted: false });
    expect(submit).toBe(0);
  });
  it('原生 Solana 路线只调用单次底层执行器，使用实时区块引用', async () => {
    const blockRef = { current: 100 }; function block() { return blockRef; }
    const signAndSendTransaction = vi.fn(async (_address, _tx, wallet, ref, log) => {
      expect(ref).toBe(blockRef); await wallet.signMessage({ message: new Uint8Array(1) }); log('tx_submitted', { txHash: '3'.repeat(88) });
      return { success: true, txHash: '3'.repeat(88) };
    });
    const high = vi.fn(), progress = vi.fn();
    const r = nativeRoute({ source: 'mobula', originChainType: 'SOLANA', mobulaSwap: { intentId: 'test', deposit: { type: 'SOLANA', tx: 'base64', feePayerSignature: 'base64' } } }, USDC_ID, assetKey(asset));
    const w = { accountId: 'test', address: 'test', publicKey: new Uint8Array(32), signMessage: vi.fn(async () => ({ signature: new Uint8Array(64), signedMessage: new Uint8Array(1) })) };
    expect(await executeNative(r, { solana: w }, () => {}, progress, async () => ({ u: block, c: { signAndSendTransaction, signAndSendSolanaOrRelaySwap: high } }))).toMatchObject({ state: 'submitted' });
    expect(signAndSendTransaction).toHaveBeenCalledTimes(1); expect(high).not.toHaveBeenCalled();
  });
});

describe('可恢复的跨链真实成交核对', () => {
  it('精确匹配账户、两端币种网络及交易签名；不使用报价估算', () => {
    const req = receiptRequest();
    expect(indexedFill(detail(), req, [outHash])).toMatchObject({ state: 'confirmed', quantity: '0.039', amountUsd: '4' });
    expect(indexedFill(detail(), req, [hash])).toBeUndefined();
    expect(indexedFill({ ...detail(), userId: 'other' }, req, [outHash])).toBeUndefined();
    const bad = detail(); bad.swaps[0]!.outNetworkId = 1;
    expect(indexedFill(bad, req, [outHash])).toBeUndefined();
    const sell = { ...req, kind: 'limit-sell' as const, reference: { ...req.reference!, inTokenId: assetKey(asset), outTokenId: USDC_ID } };
    expect(indexedFill(detail(), sell, [outHash])).toBeUndefined();
  });
  it('路线成功但没有实际成交索引时继续 pending，绝不返回报价数量', async () => {
    const json = vi.fn(async (url: string) => url.includes('api.relay.link') ? { requests: [{ id: 'intent-test', status: 'success', data: { inTxs: [{ chainId: 8453, hash }], outTxs: [{ hash: outHash, chainId: 8453 }] } }] }
      : url.includes('/trades?') ? { success: true, responseObject: { activeTrades: [], closedTrades: [] } } : { success: true, responseObject: { status: 'SUCCESS', expectedOutHumanAmount: '500' } });
    expect(await routedReceipt(receiptRequest(), { json, account: () => 'test', direct: async () => ({ state: 'pending' }) })).toMatchObject({ state: 'pending' });
  });
  it('Relay 输出哈希关联真实成交并汇总仓位；不同来源哈希不匹配不能成交', async () => {
    const json = vi.fn(async (url: string) => {
      if (url.includes('api.relay.link')) return { requests: [{ id: 'intent-test', status: 'success', data: { inTxs: [{ chainId: 8453, hash }], outTxs: [{ hash: outHash, chainId: 8453 }] } }] };
      if (url.includes('/trades?')) return { success: true, responseObject: { activeTrades: [{ trade: { id: 't' } }], closedTrades: [] } };
      if (url.includes('/trades/t')) return { success: true, responseObject: detail() };
      if (url.includes('/balances')) return { success: true, responseObject: { balances: [{ tokenFilterResult: { token: { address: asset.tokenAddress, networkId: asset.networkId } }, balance: { shiftedBalance: '.15' } }] } };
      return { success: true, responseObject: { status: 'SUCCESS' } };
    });
    const io = { json, account: () => 'test', direct: async (): Promise<ExecutionResult> => ({ state: 'pending' }) };
    expect(await routedReceipt(receiptRequest(), io)).toMatchObject({ state: 'confirmed', quantity: '0.039', remainingQuantity: '0.15', transactionHash: hash });
    expect(await routedReceipt({ ...receiptRequest(), transactionHash: outHash }, io)).toMatchObject({ state: 'pending' });
  });
  it('已持久化 UserOperation 可恢复来源哈希；失败回执不当作成交', async () => {
    const req = receiptRequest(); req.transactionHash = undefined; req.reference!.userOperationHash = uoHash;
    const json = vi.fn(async (url: string) => url.includes('/rpc') ? { result: { success: true, receipt: { transactionHash: hash } } } : { success: true, responseObject: { status: 'PENDING' } });
    const io = { json, account: () => 'test', direct: async (): Promise<ExecutionResult> => ({ state: 'pending' }) };
    expect(await routedReceipt(req, io)).toMatchObject({ state: 'pending', transactionHash: hash });
    json.mockImplementationOnce(async () => ({ result: { success: false } }) as any);
    expect(await routedReceipt(req, io)).toMatchObject({ state: 'failed' });
  });
  it('Mobula 只有 SUCCESS 且没有可关联哈希时保持 pending', async () => {
    const req = receiptRequest(); req.transactionHash = undefined; req.reference = { ...req.reference!, source: 'mobula', intentId: 'm', relaySwapId: undefined };
    expect(await routedReceipt(req, { json: async () => ({ success: true, responseObject: { status: 'SUCCESS' } }), account: () => 'test', direct: async () => ({ state: 'pending' }) })).toMatchObject({ state: 'pending' });
  });
});

describe('多链持久执行调度', () => {
  const session = () => ({ accountId: 'test', positions: [], minimumBuyUsd: '2', minimumSellUsd: '2', receivedAt: Date.now() });
  const price = () => ({ ...asset, priceUsd: '100', timestamp: Date.now(), receivedAt: Date.now() });
  it('真实下单关闭时只记一次日志，不报价、不请求签名、不生成持仓', async () => {
    const db = await database(crypto.randomUUID()); await db.put('state', { ...DEFAULT_SETTINGS, automatic: true, realTrading: false }, 'settings');
    const o = await createOrder(db, { asset, kind: 'limit-buy', targetPrice: '110', amountUsd: '1000' }, session(), price());
    const call = vi.fn(); const c = createCoordinator({ db: Promise.resolve(db), call, allowed: () => true, page: () => 1 });
    await evaluate(db, session(), price()); await c.tick(session(), price(), 1); await evaluate(db, session(), price());
    expect(call).not.toHaveBeenCalled(); expect((await db.getAll('logs')).filter(l => l.code === 'target-reached')).toHaveLength(1);
    expect(await db.get('orders', o.id)).toMatchObject({ status: 'waiting' }); expect(await db.count('events')).toBe(0); expect(await db.getAllKeys('state')).toEqual(['settings']); db.close();
  });
  it('Base 原生执行前先持久意图，超时重启只查旧意图，不重新执行', async () => {
    const db = await database(crypto.randomUUID()); await db.put('state', { ...DEFAULT_SETTINGS, automatic: true, realTrading: true }, 'settings');
    const o = order(); await db.put('orders', o); const reference = route().reference;
    const call = vi.fn(async (_tab: number, req: ExecutionRequest): Promise<ExecutionResult> => {
      if (req.action === 'prepare') return { state: 'prepared', native: true, reference };
      if (req.action === 'execute-native') { expect(await db.get('orders', o.id)).toMatchObject({ status: 'submitted', executionReference: reference }); throw new Error('timeout'); }
      return { state: 'pending' };
    });
    const c = createCoordinator({ db: Promise.resolve(db), call, allowed: () => true, page: () => 1 }); await c.tick(session(), price(), 1);
    for (let i = 0; i < 100 && (await db.get('orders', o.id))?.status !== 'unknown'; i++) await new Promise(r => setTimeout(r, 2));
    expect(await db.get('orders', o.id)).toMatchObject({ status: 'unknown', executionReference: reference });
    await recoverExecution(db); await c.reconcile(); await c.tick(session(), price(), 1);
    expect(call.mock.calls.map(c => c[1].action)).toEqual(['prepare', 'execute-native', 'receipt']); db.close();
  });
});
