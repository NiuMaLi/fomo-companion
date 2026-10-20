import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BRIDGE } from '../src/shared/model';
import { NETWORK, SOL } from './fixtures';

const posts: any[] = [];
const sockets: FakeSocket[] = [];
const requests: { url: string; chains?: string }[] = [];
class FakeSocket {
  static CLOSING = 2;
  readyState = 1;
  sent: any[] = [];
  onopen?: () => void; onmessage?: (event: { data: string }) => void;
  onclose?: () => void; onerror?: () => void;
  constructor(public url: string) { sockets.push(this); }
  send(value: string) { this.sent.push(JSON.parse(value)); }
  close() { this.readyState = 3; }
}
const fakeBalance = { success: true, responseObject: { balances: [{
  tokenFilterResult: { token: { address: SOL, networkId: NETWORK, symbol: 'SOL', decimals: 9, info: { imageThumbUrl: 'https://example.org/sol.png' } }, priceUSD: '100' },
  userToken: { humanAmountRemaining: '0.09', averageEntryPriceUsd: '95' },
}] } };
let originalJson: typeof Response.prototype.json;
let nativeFetch: typeof fetch;
let win: EventTarget & { fetch: typeof fetch; postMessage: (value: unknown) => void };
beforeEach(async () => {
  originalJson = Response.prototype.json;
  vi.resetModules(); vi.useFakeTimers(); posts.length = 0; sockets.length = 0; requests.length = 0;
  const original = vi.fn(async (input: any, options?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input.url ?? input.href);
    requests.push({ url: url.href, chains: new Headers(options?.headers).get('X-Supported-Chains') ?? undefined });
    const body = url.pathname === '/v2/users' ? { success: true, responseObject: { id: 'current-account' } }
      : url.pathname.endsWith('/balances') ? fakeBalance
      : url.pathname === '/config' ? { success: true, responseObject: { minPurchaseAmountByChain: { default: { buy: 2, sell: 2 }, '8453': { buy: 5, sell: 4 } } } }
      : { success: true, responseObject: {} };
    const response = new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });
    Object.defineProperty(response, 'url', { value: url.href });
    return response;
  });
  nativeFetch = original as typeof fetch;
  win = Object.assign(new EventTarget(), { fetch: original as typeof fetch, postMessage: (value: unknown) => posts.push(value) });
  vi.stubGlobal('window', win);
  vi.stubGlobal('location', { origin: 'https://fomo.family', href: `https://fomo.family/tokens/solana/${SOL}` });
  vi.stubGlobal('localStorage', { getItem: () => JSON.stringify('test-access-token.payload.signature') });
  vi.stubGlobal('WebSocket', FakeSocket);
  vi.stubGlobal('document', { querySelector: () => null });
  Object.assign(win, { setInterval, clearInterval });
  vi.stubGlobal('defineContentScript', (definition: unknown) => definition);
  const script = await import('../entrypoints/page.content');
  await (script.default as any).main();
});
afterEach(async () => {
  vi.clearAllTimers(); vi.useRealTimers();
  // Let native Response body readers and their observers finish before removing
  // the page globals. A site response can launch the independent account refresh.
  await new Promise<void>(resolve => setImmediate(resolve));
  await new Promise<void>(resolve => setImmediate(resolve));
  Response.prototype.json = originalJson; vi.unstubAllGlobals();
});

async function websiteRequest(url: string, options?: RequestInit) {
  const response = await win.fetch(url, options);
  return response.json();
}

describe('页面只读桥接', () => {
  it('只接受网站账户初始化响应，其他用户余额不能变成当前账户', async () => {
    await websiteRequest('https://prod-api.fomo.family/v2/users/other-account/balances');
    await vi.waitFor(() => expect(posts.length).toBeGreaterThan(0));
    expect(posts.some(p => p.type === 'session')).toBe(false);
    await websiteRequest('https://prod-api.fomo.family/v2/users', { method: 'POST' });
    await vi.waitFor(() => expect(posts.some(p => p.type === 'session')).toBe(true));
    const session = posts.find(p => p.type === 'session').session;
    expect(session.accountId).toBe('current-account'); expect(session.positions[0].quantity).toBe('0.09');
    expect(session.positions[0].symbol).toBe('SOL');
    expect(session.positions[0].logoUrl).toBe('https://example.org/sol.png');
    expect(session.positions[0].costUsd).toBe('95');
    const count = posts.filter(p => p.type === 'session').length;
    await websiteRequest('https://prod-api.fomo.family/v2/users/other-account/balances');
    await vi.advanceTimersByTimeAsync(100);
    expect(posts.filter(p => p.type === 'session')).toHaveLength(count);
  });
  it('认证凭据仅写入行情连接，使用正确 topicId，向扩展仅发送价格', async () => {
    await websiteRequest('https://prod-api.fomo.family/v2/users', { method: 'POST' });
    await vi.waitFor(() => expect(sockets.length).toBe(1));
    const socket = sockets[0]!; socket.onopen?.();
    expect(socket.sent[0].type).toBe('challengeResponse');
    socket.onmessage?.({ data: JSON.stringify({ type: 'challengeAccepted' }) });
    expect(socket.sent[1]).toEqual({ type: 'subscribe', topicType: 'prices', topicId: `${SOL}:${NETWORK}` });
    socket.onmessage?.({ data: JSON.stringify({ type: 'data', topicType: 'prices', topicId: `${SOL}:${NETWORK}`, payload: { priceUsd: 105, timestamp: 1800000000 } }) });
    const value = posts.find(p => p.type === 'price');
    expect(value.source).toBe(BRIDGE); expect(value.price.priceUsd).toBe('105'); expect(value.price.timestamp).toBe(1800000000000);
    expect(JSON.stringify(posts)).not.toContain('test-access-token');
  });
  it('页面网络请求保持原返回结果，插件不会自行创建交易请求', async () => {
    expect(win.fetch).toBe(nativeFetch);
    const response = await win.fetch('https://prod-api.fomo.family/v2/users', { method: 'POST' });
    expect((await response.json()).responseObject.id).toBe('current-account');
    await vi.advanceTimersByTimeAsync(16000);
    expect(posts.some(p => /sign|transaction/.test(p.type))).toBe(false);
  });
  it('SPA 切币更新订阅，不转发已退订资产的晚到价格', async () => {
    await websiteRequest('https://prod-api.fomo.family/v2/users', { method: 'POST' });
    await vi.waitFor(() => expect(sockets.length).toBe(1));
    const socket = sockets[0]!;
    socket.onmessage?.({ data: JSON.stringify({ type: 'challengeAccepted' }) });
    const mint = '3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh';
    location.href = `https://fomo.family/tokens/solana/${mint}`;
    await vi.advanceTimersByTimeAsync(500);
    expect(posts.filter(p => p.type === 'context').at(-1).asset.tokenAddress).toBe(mint);
    expect(socket.sent).toContainEqual({ type: 'subscribe', topicType: 'prices', topicId: `${mint}:${NETWORK}` });
    expect(socket.sent).toContainEqual({ type: 'unsubscribe', topicType: 'prices', topicId: `${SOL}:${NETWORK}` });
    const count = posts.filter(p => p.type === 'price').length;
    socket.onmessage?.({ data: JSON.stringify({ type: 'data', topicType: 'prices', topicId: `${SOL}:${NETWORK}`, payload: { priceUsd: 105, timestamp: 1800000000 } }) });
    expect(posts.filter(p => p.type === 'price')).toHaveLength(count);
  });
});

it('SPA 跨链切换正确订阅 Base，EVM 地址规范化，未知网络不回退 Solana', async () => {
  await websiteRequest('https://prod-api.fomo.family/v2/users', { method: 'POST' });
  await vi.waitFor(() => expect(sockets.length).toBe(1));
  const socket = sockets[0]!;
  socket.onmessage?.({ data: JSON.stringify({ type: 'challengeAccepted' }) });
  expect(requests.filter(r => /balances$/.test(r.url))[0]?.chains?.split(',')).toContain('8453');
  const address = '0xcb585250f852c6c6bf90434ab21a00f02833a4af';
  location.href = `https://fomo.family/tokens/base/0x${address.slice(2).toUpperCase()}`;
  await vi.advanceTimersByTimeAsync(500);
  expect(posts.filter(p => p.type === 'session').at(-1).session).toMatchObject({ minimumBuyUsd: '5', minimumSellUsd: '4', minimumsByNetwork: { '8453': { buy: '5', sell: '4' } } });
  expect(posts.filter(p => p.type === 'context').at(-1).asset).toMatchObject({ tokenAddress: address, networkId: 8453 });
  expect(socket.sent).toContainEqual({ type: 'subscribe', topicType: 'prices', topicId: `${address}:8453` });
  const seen = posts.filter(p => p.type === 'price').length;
  socket.onmessage?.({ data: JSON.stringify({ type: 'data', topicType: 'prices', topicId: `${address}:8453`, payload: { priceUsd: 1, timestamp: 1800000000 } }) });
  expect(posts.filter(p => p.type === 'price')).toHaveLength(seen + 1);
  location.href = `https://fomo.family/tokens/unknown/${address}`;
  await vi.advanceTimersByTimeAsync(500);
  expect(posts.filter(p => p.type === 'context').at(-1).asset).toBeUndefined();
  expect(socket.sent).toContainEqual({ type: 'unsubscribe', topicType: 'prices', topicId: `${address}:8453` });
});

it('does not wrap fetch or alter a third-party network rejection', async () => {
  const failure = new TypeError('Failed to fetch: blocked by document CSP');
  expect(win.fetch).toBe(nativeFetch);
  vi.mocked(nativeFetch).mockRejectedValueOnce(failure);
  await expect(win.fetch('https://example.org/events')).rejects.toBe(failure);
  expect(posts.some(p => p.type === 'session' || p.type === 'price' || p.status === 'auth-expired')).toBe(false);
});
