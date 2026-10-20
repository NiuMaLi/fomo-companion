import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { type Asset } from '../src/shared/model';
import { NETWORK, SOL_ASSET } from './fixtures';

const sendToTab = vi.fn<(...args: unknown[]) => Promise<unknown>>();
const queryTabs = vi.fn<(...args: unknown[]) => Promise<{ id: number; active: boolean; status: string; url?: string }[]>>();
const reloadTab = vi.fn<(...args: unknown[]) => Promise<void>>();
let listener: (...args: any[]) => boolean;
let activated: (info: { tabId: number }) => void;
const other: Asset = { tokenAddress: '3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh', networkId: NETWORK, symbol: 'BTC', decimals: 8 };
const sender = (tab = 1, active = true) => ({ id: 'extension', url: 'https://fomo.family/tokens/solana/' + SOL_ASSET.tokenAddress, tab: { id: tab, active }, frameId: 0 });
const feed = (data: object, tab = 1, active = true) => call({ channel: 'feed', data }, sender(tab, active));
function call(data: object, source: object = { id: 'extension', url: 'chrome-extension://extension/sidepanel.html' }): Promise<any> {
  return new Promise(resolve => listener(data, source, resolve));
}
async function ready() {
  await feed({ type: 'context', asset: SOL_ASSET });
  await feed({ type: 'session', session: { accountId: 'test', positions: [], minimumBuyUsd: '2', minimumSellUsd: '2', receivedAt: Date.now() } });
  await feed({ type: 'price', price: { ...SOL_ASSET, priceUsd: '100', timestamp: Date.now(), receivedAt: Date.now() } });
}
beforeEach(async () => {
  vi.resetModules(); vi.stubGlobal('indexedDB', new IDBFactory());
  sendToTab.mockReset().mockResolvedValue({ ok: true });
  queryTabs.mockReset().mockResolvedValue([{ id: 1, active: true, status: 'complete', url: 'https://fomo.family/' }]);
  reloadTab.mockReset().mockResolvedValue(undefined);
  vi.stubGlobal('defineBackground', (fn: () => void) => fn);
  vi.stubGlobal('browser', {
    sidePanel: { setPanelBehavior: async () => {} }, storage: { local: { setAccessLevel: async () => {} } },
    alarms: { create: async () => {}, onAlarm: { addListener: () => {} } },
    tabs: { query: queryTabs, reload: reloadTab, sendMessage: sendToTab, get: async () => ({ url: 'https://fomo.family/' }), onActivated: { addListener: (fn: any) => { activated = fn; } }, onRemoved: { addListener: () => {} } },
    runtime: { id: 'extension', getURL: () => 'chrome-extension://extension/', onMessage: { addListener: (fn: any) => { listener = fn; } } },
  });
  const { default: init } = await import('../entrypoints/background'); (init as unknown as () => void)();
});
afterEach(() => vi.unstubAllGlobals());

it('跟随当前标签页；后台标签页不能覆盖资产或K线选价', async () => {
  await ready();
  await feed({ type: 'context', asset: other }, 2, false);
  await feed({ type: 'selection', selection: { id: 'wrong', asset: other, priceUsd: '90', at: Date.now() } }, 2, false);
  let view = (await call({ type: 'view' })).data;
  expect(view.asset).toEqual(SOL_ASSET); expect(view.selection).toBeUndefined();
  activated({ tabId: 2 });
  await feed({ type: 'context', asset: other }, 2);
  view = (await call({ type: 'view' })).data;
  expect(view.asset).toEqual(other); expect(view.price).toBeUndefined(); expect(view.session).toBeUndefined();
});
it('切换币种立即清空行情与选价；旧表单不能保存', async () => {
  await ready();
  await feed({ type: 'selection', selection: { id: 'one', asset: SOL_ASSET, priceUsd: '90', at: Date.now() } });
  expect((await call({ type: 'view' })).data.selection.priceUsd).toBe('90');
  await feed({ type: 'context', asset: other });
  await feed({ type: 'selection', selection: { id: 'late', asset: SOL_ASSET, priceUsd: '91', at: Date.now() } });
  const view = (await call({ type: 'view' })).data;
  expect(view.price).toBeUndefined(); expect(view.selection).toBeUndefined();
  expect((await call({ type: 'create', draft: { asset: SOL_ASSET, kind: 'limit-buy', targetPrice: '100', amountUsd: '9' } })).ok).toBe(false);
});
it('登录异常后，仅行情更新不能恢复可交易状态', async () => {
  await ready();
  await feed({ type: 'health', status: 'auth-expired', reason: 'test' });
  await feed({ type: 'price', price: { ...SOL_ASSET, priceUsd: '100', timestamp: Date.now(), receivedAt: Date.now() } });
  expect((await call({ type: 'view' })).data.status).toBe('auth-expired');
  expect((await call({ type: 'automatic', enabled: true })).ok).toBe(false);
});

it('刷新时接收端缺失会刷新对应 FOMO 页，清空过期数据并等待恢复', async () => {
  await ready();
  sendToTab.mockRejectedValue(new Error('Could not establish connection. Receiving end does not exist.'));
  const result = await call({ type: 'refresh' });
  expect(result.ok).toBe(true);
  expect(browser.tabs.reload).toHaveBeenCalledExactlyOnceWith(1);
  expect(result.data).toMatchObject({ status: 'waiting', monitoring: false });
  expect(result.data.reason).toContain('重新连接');
  expect(result.data.session).toBeUndefined(); expect(result.data.price).toBeUndefined();
  sendToTab.mockResolvedValue({ ok: true });
  await ready();
  expect((await call({ type: 'view' })).data.status).toBe('ready');
});
it('后台重启未发现 owner 时刷新会查找当前 FOMO 页并发送请求', async () => {
  const result = await call({ type: 'refresh' });
  expect(result.ok).toBe(true);
  expect(browser.tabs.query).toHaveBeenCalledWith({ url: 'https://fomo.family/*', currentWindow: true });
  expect(browser.tabs.sendMessage).toHaveBeenCalledWith(1, { type: 'refresh-feed' }, { frameId: 0 });
  expect(browser.tabs.reload).not.toHaveBeenCalled();
});
it('没有 FOMO 页时展示可操作提示，不向旧标签页发消息', async () => {
  await ready();
  queryTabs.mockResolvedValue([]);
  sendToTab.mockClear();
  const result = await call({ type: 'refresh' });
  expect(result.ok).toBe(true); expect(result.data.reason).toContain('未找到 FOMO 页面');
  expect(result.data.monitoring).toBe(false);
  expect(browser.tabs.sendMessage).not.toHaveBeenCalled();
  expect(browser.tabs.reload).not.toHaveBeenCalled();
});
it('优先连接当前活动 FOMO 页，清除旧标签页的账户快照', async () => {
  await ready();
  queryTabs.mockResolvedValue([{ id: 2, active: true, status: 'complete' }, { id: 1, active: false, status: 'complete' }]);
  const result = await call({ type: 'refresh' });
  expect(browser.tabs.sendMessage).toHaveBeenCalledWith(2, { type: 'refresh-feed' }, { frameId: 0 });
  expect(result.data.session).toBeUndefined();
});
it('未就绪的加载页不反复刷新；刷新失败不泄露 Chrome 原始异常', async () => {
  queryTabs.mockResolvedValue([{ id: 1, active: true, status: 'loading' }]);
  sendToTab.mockRejectedValue(new Error('Receiving end does not exist'));
  expect((await call({ type: 'refresh' })).data.reason).toContain('正在加载');
  expect(browser.tabs.reload).not.toHaveBeenCalled();
  queryTabs.mockResolvedValue([{ id: 1, active: true, status: 'complete' }]);
  reloadTab.mockRejectedValue(new Error('No tab with id'));
  const result = await call({ type: 'refresh' });
  expect(result.ok).toBe(true); expect(result.data.status).toBe('error');
  expect(result.data.reason).toContain('请手动刷新');
});

it('真实签名未接通时不能开启真实下单，面板提供具体原因', async () => {
  await ready();
  const result = await call({ type: 'real-trading', enabled: true });
  expect(result.ok).toBe(false); expect(result.error).toContain('钱包就绪');
  const view = (await call({ type: 'view' })).data;
  expect(view.settings.realTrading).toBe(false); expect(view.execution.available).toBe(false);
  expect(view.paper).toBeUndefined();
});
it('逐单价格按币种保留，切换非代币页后仍订阅已保存的条件单', async () => {
  await ready();
  await call({ type: 'create', draft: { asset: SOL_ASSET, kind: 'limit-buy', targetPrice: '90', amountUsd: '4' } });
  await feed({ type: 'context', asset: other });
  await feed({ type: 'price', price: { ...other, priceUsd: '65000', timestamp: Date.now(), receivedAt: Date.now() } });
  let view = (await call({ type: 'view' })).data;
  expect(view.prices[`${SOL_ASSET.tokenAddress}:${NETWORK}`].priceUsd).toBe('100');
  expect(view.price.priceUsd).toBe('65000');
  await feed({ type: 'context' });
  expect(sendToTab.mock.calls.some(args => (args[1] as any)?.type === 'subscriptions' && (args[1] as any).assets.some((a: Asset) => a.tokenAddress === SOL_ASSET.tokenAddress))).toBe(true);
  await feed({ type: 'price', price: { ...SOL_ASSET, priceUsd: '99', timestamp: Date.now() + 1, receivedAt: Date.now() } });
  view = (await call({ type: 'view' })).data;
  expect(view.asset).toBeUndefined(); expect(view.prices[`${SOL_ASSET.tokenAddress}:${NETWORK}`].priceUsd).toBe('99');
});
it('保存两个通知地址并清空后生效；日志不包含配置值', async () => {
  const ordersWebhook = 'https://open.feishu.cn/open-apis/bot/v2/hook/private-test-channel';
  const result = await call({ type: 'notifications', notifications: { ordersWebhook, alertsWebhook: '' } });
  expect(result.ok).toBe(true);
  expect(result.data.settings.notifications.ordersWebhook).toBe(ordersWebhook);
  expect(JSON.stringify(result.data.logs)).not.toContain('private-test-channel');
  const cleared = await call({ type: 'notifications', notifications: { ordersWebhook: '', alertsWebhook: '' } });
  expect(cleared.data.settings.notifications.ordersWebhook).toBe('');
});
it('未配置的认证异常只记本地日志；接口失败不阻断既有账户', async () => {
  const fetchSpy = vi.fn(); vi.stubGlobal('fetch', fetchSpy);
  await ready();
  await feed({ type: 'api-error', endpoint: 'metadata' });
  expect((await call({ type: 'view' })).data.status).toBe('ready');
  await feed({ type: 'health', status: 'auth-expired', reason: 'expired' });
  await feed({ type: 'health', status: 'auth-expired', reason: 'expired' });
  const view = (await call({ type: 'view' })).data;
  expect(view.logs.filter((l: any) => l.code === 'auth-expired')).toHaveLength(1);
  expect(fetchSpy).not.toHaveBeenCalled();
});


it('切换语言持久保存且不重置交易开关、订单和通知设置', async () => {
  await ready();
  await call({ type: 'automatic', enabled: true });
  await call({ type: 'notifications', notifications: { ordersWebhook: '', alertsWebhook: 'https://open.feishu.cn/open-apis/bot/v2/hook/test-language-alerts' } });
  await call({ type: 'create', draft: { asset: SOL_ASSET, kind: 'limit-buy', targetPrice: '90', amountUsd: '0.1' } });
  const before = (await call({ type: 'view' })).data;
  const after = (await call({ type: 'language', language: 'en' })).data;
  expect(after.settings).toEqual({ ...before.settings, language: 'en' });
  expect(after.orders).toEqual(before.orders); expect(after.logs).toEqual(before.logs);
  expect((await call({ type: 'language', language: 'invalid' })).ok).toBe(false);
  const id = after.orders[0].id;
  const cancelled = (await call({ type: 'cancel', id })).data;
  expect(cancelled.logs.find((l: any) => l.code === 'order-cancelled').order).toMatchObject({ status: 'cancelled', amountUsd: '0.1', targetPrice: '90' });
});
