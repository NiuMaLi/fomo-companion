import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { installChartBridge } from '../src/shared/chart-bridge';
import { type Asset } from '../src/shared/model';
import { NETWORK } from './fixtures';

const BTC: Asset = { tokenAddress: '3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh', networkId: NETWORK, symbol: 'BTC' };
let asset: Asset | undefined;
let mode: '价格' | '市值';
let ticker: string;
let currency: string | undefined;
let supply: number | undefined;
let mainPane: boolean;
let crosshair: (point: { price: number; offsetX: number; offsetY: number }) => void;
let listeners: Map<string, (event: any) => void>;
let select: ReturnType<typeof vi.fn>;
let cleanup: () => void;

beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(10000);
  asset = BTC; mode = '价格'; ticker = `${BTC.tokenAddress}:${NETWORK}`;
  currency = undefined; supply = 100; mainPane = true;
  listeners = new Map(); select = vi.fn();
  const series = { symbolInfo: () => ({ ticker, totalSupply: supply, currency_code: currency }) };
  const chart = {
    symbolExt: () => ({ ticker, currency_code: currency }),
    priceFormatter: () => ({ format: () => mode === '市值' ? '$1' : '1.00' }),
    crossHairMoved: () => ({ subscribe: (_: unknown, callback: typeof crosshair) => { crosshair = callback; }, unsubscribe: vi.fn() }),
    chartModel: () => ({ mainSeries: () => series, crosshairSource: () => ({ pane: { mainDataSource: () => mainPane ? series : {} } }) }),
  };
  const doc = {
    querySelectorAll: () => [{ textContent: mode, parentElement: { textContent: '价格 / 市值' } }],
    defaultView: { scrollX: 0, scrollY: 0 },
    addEventListener: (type: string, callback: (event: any) => void) => { listeners.set(type, callback); },
    removeEventListener: (type: string) => { listeners.delete(type); },
  };
  vi.stubGlobal('document', { querySelector: () => ({ contentDocument: doc, contentWindow: { tradingViewApi: { activeChart: () => chart } } }) });
  vi.stubGlobal('window', { setInterval, clearInterval });
  cleanup = installChartBridge(() => asset, select);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); });

function aim(price = 82000) { crosshair({ price, offsetX: 200, offsetY: 180 }); }
function fire(type: string, overrides: Record<string, unknown> = {}) {
  listeners.get(type)?.({ button: 0, clientX: 200, clientY: 180, isTrusted: true, target: { tagName: 'CANVAS' }, ...overrides });
}
function click() { fire('pointerdown'); fire('click'); }

it('copies the exact public crosshair USD price, without coordinate estimation', () => {
  aim(82001.2345); click();
  expect(select).toHaveBeenCalledExactlyOnceWith(BTC, '82001.2345');
});
it('preserves case-sensitive mint identity and rejects another asset or an old context', () => {
  aim(); ticker = ticker.toLowerCase(); click();
  expect(select).not.toHaveBeenCalled();
  ticker = `${BTC.tokenAddress}:${NETWORK}`;
  aim(); asset = { ...BTC, tokenAddress: 'different' }; click();
  expect(select).not.toHaveBeenCalled();
});
it('converts verified market cap using the chart datafeed total supply', () => {
  mode = '市值'; aim(1000); click();
  expect(select).toHaveBeenCalledExactlyOnceWith(BTC, '10');
});
it('rejects market cap without supply and any explicit non-USD quotation', () => {
  mode = '市值'; supply = undefined; aim(); click();
  expect(select).not.toHaveBeenCalled();
  mode = '价格'; currency = 'SOL'; aim(); click();
  expect(select).not.toHaveBeenCalled();
});
it('rejects stale crosshairs, dragged gestures and price selections from indicator panes', () => {
  aim(); vi.advanceTimersByTime(501); click();
  expect(select).not.toHaveBeenCalled();
  aim(); fire('pointerdown'); fire('pointermove', { clientX: 215 }); fire('pointermove'); fire('click');
  expect(select).not.toHaveBeenCalled();
  mainPane = false; aim(); click();
  expect(select).not.toHaveBeenCalled();
});
it('rejects mismatched click coordinates, controls and mode changes', () => {
  aim(); fire('pointerdown', { clientX: 210 }); fire('click', { clientX: 210 });
  expect(select).not.toHaveBeenCalled();
  aim(); fire('pointerdown'); fire('click', { target: { tagName: 'DIV' } });
  expect(select).not.toHaveBeenCalled();
  aim(); mode = '市值'; click();
  expect(select).not.toHaveBeenCalled();
});

it('accepts EVM address casing while keeping chain identity exact', () => {
  asset = { tokenAddress: '0xcb585250f852c6c6bf90434ab21a00f02833a4af', networkId: 8453, symbol: 'TEST' };
  ticker = `0x${asset.tokenAddress.slice(2).toUpperCase()}:8453`;
  aim(0.123456); click();
  expect(select).toHaveBeenCalledExactlyOnceWith(asset, '0.123456');
  select.mockClear(); ticker = `${asset.tokenAddress}:1`; aim(); click();
  expect(select).not.toHaveBeenCalled();
});
