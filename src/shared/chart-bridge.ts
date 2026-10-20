import Decimal from 'decimal.js';
import { matchesTicker } from './chains';
import { assetKey, type Asset } from './model';

type Crosshair = { price: number; offsetX: number; offsetY: number };
type Subscription = { subscribe(owner: null, cb: (point: Crosshair) => void): void; unsubscribe(owner: null, cb: (point: Crosshair) => void): void };
type SymbolInfo = { ticker?: string; currency_code?: string; currency?: string; totalSupply?: number };
type Source = { symbolInfo(): SymbolInfo };
type Chart = {
  symbolExt(): SymbolInfo;
  crossHairMoved(): Subscription;
  priceFormatter(): { format(price: number): string };
  chartModel(): { mainSeries(): Source; crosshairSource(): { pane: { mainDataSource(): Source } | null } };
};
type ChartWindow = Window & { tradingViewApi?: { activeChart(): Chart } };

// FOMO's own selected header span describes the effective mode. Its persisted
// preference alone is insufficient: native asset charts can override it to price.
function displayedMode(doc: Document): 'price' | 'market_cap' | undefined {
  for (const span of doc.querySelectorAll<HTMLElement>('[title] > span')) {
    const whole = span.parentElement?.textContent?.trim() ?? '';
    if (!whole.includes('/')) continue;
    const label = span.textContent?.trim().toLowerCase();
    if (label === '价格' || label === 'price') return 'price';
    if (label === '市值' || label === 'market cap' || label === 'mcap') return 'market_cap';
  }
}

export function installChartBridge(getAsset: () => Asset | undefined, select: (asset: Asset, priceUsd: string) => void): () => void {
  let detach: (() => void) | undefined;
  let attachedFrame: HTMLIFrameElement | undefined;
  let attachedChart: Chart | undefined;
  const connect = () => {
    const frame = document.querySelector<HTMLIFrameElement>('iframe[id^="tradingview_"]');
    let chart: Chart | undefined;
    let doc: Document | null = null;
    try {
      doc = frame?.contentDocument ?? null;
      chart = (frame?.contentWindow as ChartWindow | null)?.tradingViewApi?.activeChart();
    } catch { /* Wait for a same-origin, ready chart. */ }
    if (frame === attachedFrame && chart === attachedChart) return;
    detach?.(); detach = undefined; attachedFrame = frame ?? undefined; attachedChart = chart;
    if (!frame || !doc || !chart) return;
    const chartDoc = doc;
    const activeChart = chart;
    let point: (Crosshair & { at: number; key: string; mode: string }) | undefined;
    let gesture: { x: number; y: number; at: number; moved: boolean } | undefined;
    const moved = (value: Crosshair) => {
      const asset = getAsset();
      const mode = displayedMode(chartDoc);
      if (!asset || !mode || !Number.isFinite(value.price) || value.price <= 0) { point = undefined; return; }
      point = { ...value, at: Date.now(), key: assetKey(asset), mode };
    };
    const down = (event: PointerEvent) => {
      gesture = event.button === 0 ? { x: event.clientX, y: event.clientY, at: Date.now(), moved: false } : undefined;
    };
    const move = (event: PointerEvent) => {
      if (gesture && Math.hypot(event.clientX - gesture.x, event.clientY - gesture.y) > 4) gesture.moved = true;
    };
    const cancel = () => { gesture = undefined; };
    const click = (event: MouseEvent) => {
      const start = gesture; gesture = undefined;
      const value = point; point = undefined;
      if (!event.isTrusted || event.button !== 0 || !start || start.moved || Date.now() - start.at > 1500 || !value || Date.now() - value.at > 500) return;
      if (Math.hypot(event.clientX - start.x, event.clientY - start.y) > 4) return;
      const target = event.target as Element | null;
      if (target?.tagName !== 'CANVAS') return;
      const asset = getAsset();
      const mode = displayedMode(chartDoc);
      if (!asset || assetKey(asset) !== value.key || mode !== value.mode) return;
      // The public crosshair coordinates include the pane's document offset.
      if (Math.hypot(event.clientX + chartDoc.defaultView!.scrollX - value.offsetX, event.clientY + chartDoc.defaultView!.scrollY - value.offsetY) > 4) return;
      try {
        const info = activeChart.symbolExt();
        if (!matchesTicker(info.ticker, asset)) return;
        if ([info.currency_code, info.currency].some(currency => currency && currency !== 'USD')) return;
        const model = activeChart.chartModel();
        const series = model.mainSeries();
        if (model.crosshairSource().pane?.mainDataSource() !== series) return;
        const seriesInfo = series.symbolInfo();
        if (!matchesTicker(seriesInfo.ticker, asset) || [seriesInfo.currency_code, seriesInfo.currency].some(currency => currency && currency !== 'USD')) return;
        // Current FOMO datafeed is USD. Its market-cap formatter adds '$';
        // require the matching formatter as a second check during mode changes.
        const formatted = activeChart.priceFormatter().format(1);
        if (mode === 'market_cap' ? !formatted.startsWith('$') : formatted.startsWith('$')) return;
        let price = new Decimal(value.price);
        if (mode === 'market_cap') {
          const supply = seriesInfo.totalSupply;
          if (!supply || !Number.isFinite(supply) || supply <= 0) return;
          price = price.div(supply);
        }
        if (price.isPositive() && price.isFinite()) select(asset, price.toFixed());
      } catch { /* Unknown or changing chart state must never invent a price. */ }
    };
    try { activeChart.crossHairMoved().subscribe(null, moved); } catch { attachedChart = undefined; return; }
    chartDoc.addEventListener('pointerdown', down, true);
    chartDoc.addEventListener('pointermove', move, true);
    chartDoc.addEventListener('pointercancel', cancel, true);
    chartDoc.addEventListener('click', click, true);
    detach = () => {
      try { activeChart.crossHairMoved().unsubscribe(null, moved); } catch { /* chart may already be destroyed */ }
      chartDoc.removeEventListener('pointerdown', down, true);
      chartDoc.removeEventListener('pointermove', move, true);
      chartDoc.removeEventListener('pointercancel', cancel, true);
      chartDoc.removeEventListener('click', click, true);
    };
  };
  connect();
  const timer = window.setInterval(connect, 1000);
  return () => { window.clearInterval(timer); detach?.(); };
}
