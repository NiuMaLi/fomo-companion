import { BRIDGE, assetKey, assetSchema, type Asset, type Position } from '../src/shared/model';
import { assetFromToken } from '../src/shared/token-metadata';
import { installChartBridge } from '../src/shared/chart-bridge';
import { assetFromPath, SUPPORTED_CHAINS_HEADER } from '../src/shared/chains';
import { observeFomoResponses } from '../src/shared/response-observer';
import Decimal from 'decimal.js';
import { createPageExecutor } from '../src/trading/page-executor';
import { ExecutionError } from '../src/shared/execution';
import type { Price } from '../src/shared/model';

// Runs inside FOMO. Credentials and wallet handles never leave this closure.
export default defineContentScript({
  matches: ['https://fomo.family/*'], runAt: 'document_start', world: 'MAIN',
  main() {
    const originalFetch = window.fetch.bind(window);
    const originalJson = Response.prototype.json;
    let accountId: string | undefined;
    let balancesAt = 0;
    let positions: Position[] = [];
    let minimumsByNetwork: Record<string, { buy: string; sell: string }> = { default: { buy: '2', sell: '2' } };
    let socket: WebSocket | undefined;
    let reconnect: ReturnType<typeof setTimeout> | undefined;
    let refreshing = false, failures = 0;
    let current: Asset | undefined;
    let pagePath = '', authenticated = false;
    const subscriptions = new Map<string, Asset>(), subscribed = new Set<string>();
    const metadata = new Map<string, Asset>();
    const metadataRequested = new Map<string, number>();
    const latestPrices = new Map<string, Price>();
    const emit = (data: object) => window.postMessage({ source: BRIDGE, ...data }, location.origin);
    const health = (status: string, reason: string) => emit({ type: 'health', status, reason });
    const executor = createPageExecutor({
      progress: (accountId, attemptId, update) => emit({ type: 'execution-progress', accountId, attemptId, ...update }), fetch: originalFetch, json: originalJson, token: accessToken, account: () => accountId,
      price: key => authenticated ? latestPrices.get(key) : undefined, refresh,
      onAuthFailure: () => health('auth-expired', '交易接口登录校验失败，请回到 FOMO 确认登录') });
    const decimal = (v: unknown): string | undefined => {
      if (typeof v !== 'string' && typeof v !== 'number') return;
      try { const n = new Decimal(v); return n.isFinite() && n.abs().lt('1e60') ? n.toFixed() : undefined; } catch { return; }
    };
    const publish = () => {
      const minimum = minimumsByNetwork[String(current?.networkId)] ?? minimumsByNetwork.default!;
      const minimumBuyUsd = minimum.buy, minimumSellUsd = minimum.sell;
      if (accountId && balancesAt) emit({ type: 'session', session: { accountId, positions, minimumBuyUsd, minimumSellUsd, minimumsByNetwork, receivedAt: balancesAt } });
      if (accountId) emit({ type: 'execution', ...executor.capability() });
    };
    function updateSubscriptions() {
      if (!authenticated || !socket) return;
      const wanted = new Set(subscriptions.keys());
      if (current) wanted.add(assetKey(current));
      for (const id of subscribed) if (!wanted.has(id)) { socket.send(JSON.stringify({ type: 'unsubscribe', topicType: 'prices', topicId: id })); subscribed.delete(id); }
      for (const id of wanted) if (!subscribed.has(id)) { socket.send(JSON.stringify({ type: 'subscribe', topicType: 'prices', topicId: id })); subscribed.add(id); }
    }
    function pageContext(force = false) {
      const path = new URL(location.href).pathname;
      if (!force && path === pagePath) return;
      pagePath = path;
      const routeAsset = assetFromPath(path);
      current = routeAsset ? metadata.get(assetKey(routeAsset)) ?? routeAsset : undefined;
      emit({ type: 'context', asset: current }); updateSubscriptions(); publish();
      if (current) void readMetadata([current]);
    }
    function rememberToken(raw: unknown) {
      const parsed = assetFromToken(raw);
      if (!parsed) return;
      const token = { ...metadata.get(assetKey(parsed)), ...Object.fromEntries(Object.entries(parsed).filter(([, value]) => value !== undefined)) } as Asset;
      metadata.set(assetKey(token), token);
      if (current && assetKey(current) === assetKey(token)) { current = token; emit({ type: 'context', asset: current }); }
      return token;
    }
    async function readMetadata(assets: Asset[]) {
      const wanted = assets.filter(a => {
        const key = assetKey(a), cached = metadata.get(key);
        return (!cached?.logoUrl || cached.decimals === undefined) && Date.now() - (metadataRequested.get(key) ?? 0) > 60000;
      });
      if (!wanted.length) return;
      for (const token of wanted) metadataRequested.set(assetKey(token), Date.now());
      try {
        const url = new URL('/proxy/filterTokens', 'https://prod-api.fomo.family');
        // This endpoint is a read query despite its POST verb; it has no swap or signing operation.
        const response = await originalFetch(url, { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json', 'X-Supported-Chains': SUPPORTED_CHAINS_HEADER }, body: JSON.stringify(wanted.slice(0, 1000).map(assetKey)), signal: AbortSignal.timeout(8000) });
        if (!response.ok) throw new Error('metadata_failed');
        const body = await originalJson.call(response);
        if (body?.success !== true) throw new Error('metadata_failed');
        capture(url, body);
      } catch { emit({ type: 'api-error', endpoint: 'metadata' }); }
    }
    function capture(url: URL, body: any) {
      if (!body?.success) return;
      const data = body.responseObject;
      if (url.pathname === '/v2/users' && typeof data?.id === 'string') {
        if (accountId !== data.id) { accountId = data.id; positions = []; balancesAt = 0; socket?.close(); }
        void refresh();
        connect();
      } else if (url.pathname === `/v2/users/${accountId}/balances` && Array.isArray(data?.balances)) {
        positions = data.balances.flatMap((entry: any) => {
          const token = rememberToken(entry.tokenFilterResult?.token);
          const quantity = decimal(entry.userToken?.humanAmountRemaining);
          if (!token || !quantity) return [];
          return [{ ...token, quantity,
            priceUsd: decimal(entry.tokenFilterResult.priceUSD), costUsd: decimal(entry.userToken.averageEntryPriceUsd) }];
        });
        balancesAt = Date.now();
        publish();
        void readMetadata(positions);
      } else if (url.pathname === '/proxy/filterTokens' && Array.isArray(data)) {
        for (const entry of data) rememberToken(entry?.token);
        positions = positions.map(p => ({ ...p, ...metadata.get(assetKey(p)) }));
        publish();
      } else if (url.pathname === '/config') {
        const next: typeof minimumsByNetwork = { default: { buy: '2', sell: '2' } };
        for (const [network, raw] of Object.entries(data?.minPurchaseAmountByChain ?? {})) {
          const min = raw as { buy?: unknown; sell?: unknown };
          const buy = decimal(min?.buy), sell = decimal(min?.sell);
          if (buy && sell && new Decimal(buy).gt(0) && new Decimal(sell).gt(0)) next[network] = { buy, sell };
        }
        minimumsByNetwork = next; publish();
      }
    }
    const stopObserving = observeFomoResponses(capture);
    async function refresh() {
      if (!accountId || refreshing) return;
      refreshing = true;
      try {
        const headers = { 'Content-Type': 'application/json', 'X-Supported-Chains': SUPPORTED_CHAINS_HEADER, 'App-Language': 'zh-CN' };
        for (const path of [`/v2/users/${encodeURIComponent(accountId)}/balances`, '/config']) {
          const url = new URL(path, 'https://prod-api.fomo.family');
          const res = await originalFetch(url, { credentials: 'include', headers, signal: AbortSignal.timeout(8000) });
          if (res.status === 401 || res.status === 403) { health('auth-expired', '登录校验失败，请回到 FOMO 页面确认登录'); return; }
          if (!res.ok) { emit({ type: 'api-error', endpoint: path === '/config' ? 'config' : 'balances' }); throw new Error('read_failed'); }
          const body = await originalJson.call(res);
          if (body?.success !== true) throw new Error('read_failed');
          capture(url, body);
        }
      } catch { health('error', '账户刷新失败，请检查网络或 FOMO 页面'); }
      finally { refreshing = false; }
    }
    function accessToken(): string | undefined {
      try { const token = JSON.parse(localStorage.getItem('privy:token') ?? 'null'); return typeof token === 'string' && token.split('.').length === 3 ? token : undefined; } catch { return; }
    }
    function authenticate(ws: WebSocket) {
      const jwt = accessToken();
      if (!jwt) { health('auth-expired', '未取得可用登录凭据，请刷新 FOMO 页面'); ws.close(); return; }
      ws.send(JSON.stringify({ type: 'challengeResponse', jwt }));
    }
    function connect() {
      if (!accountId || socket && socket.readyState < WebSocket.CLOSING) return;
      clearTimeout(reconnect);
      const ws = new WebSocket('wss://prod-api.fomo.family/ws');
      socket = ws;
      authenticated = false; subscribed.clear();
      ws.onopen = () => authenticate(ws);
      ws.onmessage = event => {
        if (socket !== ws) return;
        try {
          const m = JSON.parse(String(event.data));
          if (m.type === 'challenge') authenticate(ws);
          if (m.type === 'challengeAccepted' && !authenticated) {
            authenticated = true; failures = 0; updateSubscriptions();
          }
          if (m.type === 'data' && m.topicType === 'prices' && subscribed.has(m.topicId)) {
            const value = decimal(m.payload?.priceUsd), ts = Number(m.payload?.timestamp);
            const watched = current && assetKey(current) === m.topicId ? current : subscriptions.get(m.topicId);
            if (watched && value && Number(value) > 0 && Number.isFinite(ts)) {
              const price = { tokenAddress: watched.tokenAddress, networkId: watched.networkId, priceUsd: value, timestamp: ts < 1e12 ? ts * 1000 : ts, receivedAt: Date.now() };
              latestPrices.set(assetKey(watched), price); emit({ type: 'price', price });
            }
          }
          if (m.type === 'error') { health('error', '行情服务拒绝请求，自动监控已暂停'); ws.close(); }
        } catch { /* Ignore malformed frames, never infer a price. */ }
      };
      ws.onclose = () => {
        if (socket !== ws) return;
        socket = undefined; authenticated = false; subscribed.clear(); health('disconnected', '行情连接中断，正在重连');
        reconnect = setTimeout(connect, Math.min(30000, 1000 * 2 ** Math.min(failures++, 5)) + Math.random() * 500);
      };
      ws.onerror = () => ws.close();
    }
    window.addEventListener('message', event => {
      if (event.source !== window || event.origin !== location.origin || event.data?.source !== `${BRIDGE}:request`) return;
      if (event.data.type === 'refresh') { pageContext(true); publish(); void refresh(); }
      if (event.data.type === 'execute' && typeof event.data.requestId === 'string' && event.data.requestId.length <= 100) {
        const requestId = event.data.requestId;
        void executor.execute(event.data.request).then(result => emit({ type: 'execution-response', requestId, ok: true, result }), error => {
          emit({ type: 'execution-response', requestId, ok: false, code: error instanceof ExecutionError ? error.code : 'execution',
            message: error instanceof ExecutionError ? error.message : '执行请求未完成，未确认提交', retryable: error instanceof ExecutionError && error.retryable });
        });
      }
      if (event.data.type === 'subscriptions' && Array.isArray(event.data.assets) && event.data.assets.length <= 1000) {
        subscriptions.clear();
        for (const raw of event.data.assets) { const parsed = assetSchema.safeParse(raw); if (parsed.success) subscriptions.set(assetKey(parsed.data), parsed.data); }
        updateSubscriptions();
      }
    });
    pageContext();
    const stopChart = installChartBridge(() => current, (asset, priceUsd) => {
      emit({ type: 'selection', selection: { id: crypto.randomUUID(), asset, priceUsd, at: Date.now() } });
    });
    setInterval(() => pageContext(), 500);
    setInterval(() => { emit({ type: 'heartbeat' }); void refresh(); if (current) void readMetadata([current]); connect(); }, 15000);
    window.addEventListener('pagehide', () => { stopChart(); stopObserving(); clearTimeout(reconnect); socket?.close(); });
    health('waiting', '等待 FOMO 当前账户初始化；首次安装后请刷新该页面');
  },
});
