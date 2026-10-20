import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { BRIDGE } from '../src/shared/model';
import { SOL_ASSET } from './fixtures';

let receive: (event: any) => void;
let command: (message: unknown, sender: object, respond: (value: unknown) => void) => void;
const ctx = { isValid: true, addEventListener: (_target: unknown, _type: string, fn: typeof receive) => { receive = fn; } };
const postMessage = vi.fn();
const sendMessage = vi.fn();
beforeEach(async () => {
  vi.resetModules(); ctx.isValid = true; postMessage.mockReset(); sendMessage.mockReset().mockResolvedValue({ ok: true });
  vi.stubGlobal('window', { postMessage });
  vi.stubGlobal('location', { origin: 'https://fomo.family' });
  vi.stubGlobal('browser', { runtime: { id: 'extension', sendMessage, onMessage: { addListener: (fn: typeof command) => { command = fn; } } } });
  vi.stubGlobal('defineContentScript', (definition: unknown) => definition);
  const script = await import('../entrypoints/fomo.content');
  (script.default as any).main(ctx);
});
afterEach(() => vi.unstubAllGlobals());

it('acknowledges refresh only after forwarding it to the page bridge', () => {
  const respond = vi.fn();
  command({ type: 'refresh-feed' }, { id: 'extension' }, respond);
  expect(postMessage).toHaveBeenCalledExactlyOnceWith({ source: `${BRIDGE}:request`, type: 'refresh' }, 'https://fomo.family');
  expect(respond).toHaveBeenCalledExactlyOnceWith({ ok: true });
});
it('ignores invalidated contexts and messages from another extension', () => {
  const respond = vi.fn();
  command({ type: 'refresh-feed' }, { id: 'other' }, respond);
  ctx.isValid = false;
  command({ type: 'refresh-feed' }, { id: 'extension' }, respond);
  receive({ source: window, origin: 'https://fomo.family', data: { source: BRIDGE, type: 'heartbeat' } });
  expect(respond).not.toHaveBeenCalled(); expect(postMessage).not.toHaveBeenCalled(); expect(sendMessage).not.toHaveBeenCalled();
});
it('contains both synchronous context invalidation and asynchronous messaging failures', async () => {
  const event = { source: window, origin: 'https://fomo.family', data: { source: BRIDGE, type: 'heartbeat' } };
  sendMessage.mockImplementationOnce(() => { throw new Error('Extension context invalidated.'); });
  expect(() => receive(event)).not.toThrow();
  sendMessage.mockRejectedValueOnce(new Error('Receiving end does not exist.'));
  receive(event);
  await Promise.resolve();
  expect(sendMessage).toHaveBeenCalledTimes(2);
});

it('执行请求只匹配自己的响应ID，返回字段不夹带页面凭据', () => {
  const respond = vi.fn();
  const request = { action: 'receipt', accountId: 'test', asset: SOL_ASSET, transactionHash: '3'.repeat(88) };
  expect(command({ type: 'execute', request }, { id: 'extension' }, respond)).toBe(true);
  const requestId = postMessage.mock.calls[0]![0].requestId;
  receive({ source: window, origin: 'https://fomo.family', data: { source: BRIDGE, type: 'execution-response', requestId: 'wrong', ok: true, result: { state: 'pending' } } });
  expect(respond).not.toHaveBeenCalled();
  receive({ source: window, origin: 'https://fomo.family', data: { source: BRIDGE, type: 'execution-response', requestId, ok: true, result: { state: 'pending', token: 'should-not-leave-page' } } });
  expect(respond).toHaveBeenCalledExactlyOnceWith({ ok: true, result: { state: 'pending' } });
});
it('拒绝任意签名和不合规范的交易哈希', () => {
  const respond = vi.fn();
  command({ type: 'execute', request: { action: 'sign-arbitrary-message', message: 'arbitrary' } }, { id: 'extension' }, respond);
  command({ type: 'execute', request: { action: 'receipt', accountId: 'test', asset: SOL_ASSET, transactionHash: 'invalid' } }, { id: 'extension' }, respond);
  expect(postMessage).not.toHaveBeenCalled(); expect(respond).toHaveBeenCalledTimes(2);
});
