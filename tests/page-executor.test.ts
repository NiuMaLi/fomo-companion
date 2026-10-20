import { beforeEach, expect, it, vi } from 'vitest';
import { createPageExecutor } from '../src/trading/page-executor';
import { base58, toBase64 } from '../src/trading/solana-transaction';
import { USDC_ADDRESS, type ExecutionRequest } from '../src/shared/execution';
import { SOL_ASSET } from './fixtures';

const { findWallet, findEvmWallet, loadNativeModule } = vi.hoisted(() => ({ findWallet: vi.fn(), findEvmWallet: vi.fn(), loadNativeModule: vi.fn() }));
vi.mock('../src/trading/wallet', () => ({ findWallet, findEvmWallet }));
vi.mock('../src/trading/native-runtime', async importOriginal => ({ ...await importOriginal<any>(), loadNativeModule }));
let wallet: any, unsigned: Uint8Array, payer: CryptoKeyPair;
beforeEach(async () => {
  payer = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
  const user = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
  const payerKey = new Uint8Array(await crypto.subtle.exportKey('raw', payer.publicKey));
  const userKey = new Uint8Array(await crypto.subtle.exportKey('raw', user.publicKey));
  const message = new Uint8Array([128, 2, 0, 0, 2, ...payerKey, ...userKey, ...new Uint8Array(32), 0, 0]);
  unsigned = new Uint8Array([2, ...new Uint8Array(128), ...message]);
  unsigned.set(new Uint8Array(await crypto.subtle.sign('Ed25519', payer.privateKey, message)), 1);
  wallet = { accountId: 'test', address: base58(userKey), publicKey: userKey, signMessage: vi.fn(async ({ message: input }: { message: Uint8Array }) => {
    return { signedMessage: input, signature: new Uint8Array(await crypto.subtle.sign('Ed25519', user.privateKey, new Uint8Array(input))) };
  }) };
  findWallet.mockReset().mockImplementation(() => wallet);
  findEvmWallet.mockReset().mockReturnValue(undefined); loadNativeModule.mockReset().mockResolvedValue({});
});

it('ETH/Base 买入按平台跨链报价准备，返回可持久化意图且不签名', async () => {
  const { executor, fetcher, request } = await fixture();
  const asset = { tokenAddress: '0x4200000000000000000000000000000000000006', networkId: 8453, symbol: 'ETH', decimals: 18 };
  const evm = { address: '0x' + '1'.repeat(40), getEthereumProvider: vi.fn() }; findEvmWallet.mockReturnValue(evm);
  const p = { ...request, order: { ...request.order, asset } };
  const rpc = vi.fn(async (url: any) => String(url).endsWith('/balances') ? Response.json({ success: true, responseObject: { balances: [{ tokenFilterResult: { token: { address: USDC_ADDRESS, networkId: SOL_ASSET.networkId } }, balance: { shiftedBalance: '100' } }] } })
    : Response.json({ success: true, responseObject: { source: 'relay', originChainType: 'SOLANA', v2Swap: { relaySwapId: 'read-only-test', expectedOutHumanAmount: '.04', relayTransaction: { type: 'SOLANA', tx: 'base64', feePayerSignature: 'base64', feePayerAddress: 'payer' } } } }));
  const page = createPageExecutor({ fetch: rpc as typeof fetch, json: Response.prototype.json, token: () => 'test-only', account: () => 'test', price: () => ({ ...asset, priceUsd: '100', timestamp: Date.now(), receivedAt: Date.now() }), refresh: async () => {}, onAuthFailure: vi.fn() });
  expect(await page.execute(p)).toMatchObject({ state: 'prepared', native: true, reference: { source: 'relay', relaySwapId: 'read-only-test', originNetworkId: SOL_ASSET.networkId } });
  expect(page.capability().networks).toContain(8453); expect(wallet.signMessage).not.toHaveBeenCalled(); expect(evm.getEthereumProvider).not.toHaveBeenCalled();
  expect(rpc).toHaveBeenCalledTimes(2); expect(fetcher).not.toHaveBeenCalled();
});
async function fixture() {
  let account = 'test';
  const request: ExecutionRequest = { action: 'prepare', attemptId: crypto.randomUUID(),
    order: { id: crypto.randomUUID(), accountId: 'test', asset: SOL_ASSET, kind: 'limit-buy', targetPrice: '110', amountUsd: '4' }, slippageBps: 100, maxPriceAgeMs: 15000 };
  const fetcher = vi.fn(async (_url: any, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (body?.method) return Response.json({ result: body.method === 'getBlockHeight' ? 100 : body.method === 'simulateTransaction' ? { value: { err: null } } : 'unused' });
    if (String(_url).endsWith('/balances')) return Response.json({ success: true, responseObject: { balances: [
      { tokenFilterResult: { token: { address: USDC_ADDRESS, networkId: SOL_ASSET.networkId } }, balance: { shiftedBalance: '100' } },
    ] } });
    return Response.json({ success: true, responseObject: { source: 'solana', originChainType: 'SOLANA', v1Swap: {
      expectedOutHumanAmount: .04, dynamicSlippageBps: 100, lastValidBlockHeight: 200, swapTransaction: toBase64(unsigned),
      feePayerAddress: base58(new Uint8Array(await crypto.subtle.exportKey('raw', payer.publicKey))), feePayerSignature: toBase64(unsigned.slice(1, 65)),
    } } });
  });
  const executor = createPageExecutor({ fetch: fetcher as typeof fetch, json: Response.prototype.json,
    token: () => 'never-export-this', account: () => account,
    price: () => ({ ...SOL_ASSET, priceUsd: '100', timestamp: Date.now(), receivedAt: Date.now() }), refresh: async () => {}, onAuthFailure: () => {} });
  return { executor, fetcher, request, switchAccount: () => { account = 'other'; } };
}
it('撤销正在准备的报价，不能在关闭／重开后继续旧执行', async () => {
  const { executor, fetcher, request } = await fixture();
  let release!: (r: Response) => void;
  fetcher.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  const pending = executor.execute(request);
  await executor.execute({ action: 'revoke' });
  release(Response.json({ success: true, responseObject: { balances: [] } }));
  await expect(pending).rejects.toThrow(); expect(wallet.signMessage).not.toHaveBeenCalled();
});
it('高度查询期间撤销时不调用钱包签名', async () => {
  const { executor, fetcher, request } = await fixture(); await executor.execute(request);
  let release!: (r: Response) => void;
  fetcher.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  const pending = executor.execute({ action: 'sign', attemptId: request.attemptId });
  await executor.execute({ action: 'revoke' }); release(Response.json({ result: 100 }));
  await expect(pending).rejects.toThrow('撤销'); expect(wallet.signMessage).not.toHaveBeenCalled();
});
it('签名期间撤销，签名晚返回也不进入可提交状态', async () => {
  const { executor, request } = await fixture(); await executor.execute(request);
  let release!: (r: any) => void;
  wallet.signMessage.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  const pending = executor.execute({ action: 'sign', attemptId: request.attemptId });
  for (let i = 0; i < 20 && !release; i++) await new Promise(r => setTimeout(r, 1));
  await executor.execute({ action: 'revoke' }); release({ signedMessage: unsigned.slice(129), signature: new Uint8Array(64) });
  await expect(pending).rejects.toThrow('撤销');
});
it('广播前最后一次高度查询期间撤销，不广播；切换账户也阻止签名', async () => {
  const { executor, fetcher, request, switchAccount } = await fixture(); await executor.execute(request);
  const signed = await executor.execute({ action: 'sign', attemptId: request.attemptId });
  let release!: (r: Response) => void;
  fetcher.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  const pending = executor.execute({ action: 'submit', attemptId: request.attemptId, transactionHash: signed.transactionHash! });
  await executor.execute({ action: 'revoke' }); release(Response.json({ result: 100 }));
  await expect(pending).rejects.toThrow('撤销');
  expect(fetcher.mock.calls.filter(([, init]) => String(init?.body).includes('sendTransaction'))).toHaveLength(0);
  switchAccount(); await expect(executor.execute({ ...request, attemptId: crypto.randomUUID() })).rejects.toThrow('切换');
});
it('重复签名／提交被阻止，提交超时返回未知而不重新提交', async () => {
  const { executor, fetcher, request } = await fixture(); await executor.execute(request);
  const signed = await executor.execute({ action: 'sign', attemptId: request.attemptId });
  await expect(executor.execute({ action: 'sign', attemptId: request.attemptId })).rejects.toThrow('重复');
  fetcher.mockImplementationOnce(async () => Response.json({ result: 100 })).mockRejectedValueOnce(new Error('private network details'));
  const submit = { action: 'submit' as const, attemptId: request.attemptId, transactionHash: signed.transactionHash! };
  expect(await executor.execute(submit)).toMatchObject({ state: 'unknown' });
  await expect(executor.execute(submit)).rejects.toThrow('重复');
});

it('成交后汇总同币所有账户余额，包含原生 SOL；只读查询失败仍返回真实成交且剩余未知', async () => {
  const { executor, fetcher } = await fixture();
  const token = (mint: string, amount: string) => ({ mint, owner: wallet.address, uiTokenAmount: { amount, decimals: mint === USDC_ADDRESS ? 6 : 9 } });
  const details = { slot: 1234, transaction: { message: { accountKeys: [wallet.address] } }, meta: { err: null, fee: 5000,
    preBalances: [100000000], postBalances: [139995000], preTokenBalances: [token(USDC_ADDRESS, '10000000')], postTokenBalances: [token(USDC_ADDRESS, '6000000')] } };
  const calls: any[] = [];
  fetcher.mockImplementation(async (_url, init) => {
    const body = JSON.parse(String(init?.body)); calls.push(body);
    const result = body.method === 'getSignatureStatuses' ? { value: [{ confirmationStatus: 'confirmed' }] }
      : body.method === 'getTransaction' ? details
      : body.method === 'getBalance' ? { value: 139995000 }
      : { value: ['100000000', '200000000'].map(amount => ({ account: { data: { parsed: { info: { tokenAmount: { amount, decimals: 9 } } } } } })) };
    return Response.json({ result });
  });
  const request = { action: 'receipt' as const, accountId: 'test', asset: SOL_ASSET, transactionHash: '3'.repeat(88) };
  expect(await executor.execute(request)).toMatchObject({ state: 'confirmed', quantity: '0.04', remainingQuantity: '0.439995' });
  for (const c of calls.filter(c => ['getBalance', 'getTokenAccountsByOwner'].includes(c.method))) expect(c.params.at(-1)).toMatchObject({ minContextSlot: 1234, commitment: 'confirmed' });
  fetcher.mockImplementation(async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    if (body.method === 'getTokenAccountsByOwner') throw new Error('balance service down');
    return Response.json({ result: body.method === 'getTransaction' ? details : { value: [{ confirmationStatus: 'confirmed' }] } });
  });
  expect(await executor.execute(request)).toMatchObject({ state: 'confirmed', remainingQuantity: undefined, amountUsd: '4' });
  expect(wallet.signMessage).not.toHaveBeenCalled();
});
