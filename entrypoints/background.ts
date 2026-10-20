import { assetKey, sameAsset, EXECUTION, commandSchema, feedSchema, type Asset, type Selection, type Price, type Session, type Status, type View } from '../src/shared/model';
import { database, readSettings } from '../src/storage/database';
import { createOrder, evaluate, fresh } from '../src/trading/engine';
import { orderSnapshot, writeLog } from '../src/storage/logs';
import { notify } from '../src/notifications/feishu';
import { createCoordinator, recoverExecution } from '../src/trading/coordinator';
import { ExecutionError, executionResultSchema, type ExecutionRequest } from '../src/shared/execution';

export default defineBackground(() => {
  const dbPromise = database().then(async db => { await recoverExecution(db); return db; });
  let session: Session | undefined, asset: Asset | undefined, selection: Selection | undefined;
  const prices = new Map<string, Price>();
  let status: Status = 'waiting', reason = '请打开已登录的 FOMO 代币详情页；首次安装后刷新该页面';
  let owner: number | undefined, lastSeen = 0, accountHealthy = false;
  let accountFailedAt = 0;
  let execution = { ...EXECUTION };
  const apiLoggedAt = new Map<string, number>();
  let queue = Promise.resolve();
  const log = async (message: string, code: string, category: 'operation' | 'trade' | 'system' = 'operation') =>
    writeLog(await dbPromise, { category, level: 'info', code, message, accountId: session?.accountId });
  browser.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  void browser.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
  void browser.alarms.create('health', { periodInMinutes: 1 });
  const serialized = <T>(run: () => Promise<T>): Promise<T> => {
    const task = queue.then(run, run); queue = task.then(() => {}, () => {}); return task;
  };
  async function pageCall(tab: number, request: ExecutionRequest) {
    let reply: any;
    try { reply = await browser.tabs.sendMessage(tab, { type: 'execute', request }, { frameId: 0 }); }
    catch { throw new ExecutionError('connection', 'FOMO 页面执行连接中断'); }
    if (!reply?.ok) throw new ExecutionError(typeof reply?.code === 'string' ? reply.code : 'execution',
      typeof reply?.message === 'string' ? reply.message.slice(0, 200) : '页面执行未完成', reply?.retryable === true);
    return executionResultSchema.parse(reply.result);
  }
  const coordinator = createCoordinator({ db: dbPromise, call: pageCall,
    allowed: (accountId, tab) => owner === tab && session?.accountId === accountId && accountHealthy && execution.available && Date.now() - lastSeen < 45000 && Date.now() - session.receivedAt < 45000,
    page: accountId => session?.accountId === accountId && accountHealthy ? owner : undefined, changed: syncSubscriptions });
  const revoke = (tab = owner) => { if (tab !== undefined) void pageCall(tab, { action: 'revoke' }).catch(() => {}); };
  function changeOwner(tab: number) {
    if (owner === tab) return;
    revoke(); execution = { ...EXECUTION };
    owner = tab; session = undefined; asset = undefined; selection = undefined; prices.clear();
    accountHealthy = false; accountFailedAt = 0; status = 'waiting'; lastSeen = 0; reason = '等待当前 FOMO 页面同步账户与币种';
  }
  function waitingForPage(message: string) {
    revoke(); execution = { ...EXECUTION };
    session = undefined; asset = undefined; selection = undefined; prices.clear();
    accountHealthy = false; accountFailedAt = 0; lastSeen = 0;
    status = 'waiting'; reason = message;
  }
  async function refreshPage() {
    // A service worker restart loses owner; an extension update invalidates the
    // old content script. Rediscover the page instead of messaging a stale ID.
    const tabs = await browser.tabs.query({ url: 'https://fomo.family/*', currentWindow: true });
    const tab = tabs.find(t => t.active) ?? tabs.find(t => t.id === owner) ?? tabs[0];
    if (tab?.id === undefined) {
      owner = undefined;
      waitingForPage('未找到 FOMO 页面，请先打开并登录 FOMO，再点击刷新');
      return;
    }
    changeOwner(tab.id);
    try {
      const reply = await browser.tabs.sendMessage(tab.id, { type: 'refresh-feed' }, { frameId: 0 });
      if (reply?.ok === true) return;
    } catch { /* No receiver is recoverable by reloading this FOMO tab. */ }
    waitingForPage('正在重新连接 FOMO，页面刷新后将自动同步，请稍候');
    if (tab.status === 'loading') {
      reason = 'FOMO 页面正在加载，完成后将自动同步，请稍候';
      return;
    }
    try { await browser.tabs.reload(tab.id); }
    catch { status = 'error'; reason = '无法刷新 FOMO 页面，请手动刷新该页面后再试'; }
  }
  async function syncSubscriptions() {
    if (owner === undefined) return;
    const db = await dbPromise;
    const assets = new Map<string, Asset>();
    if (asset) assets.set(assetKey(asset), asset);
    if (session) for (const o of await db.getAll('orders')) {
      if (o.accountId === session.accountId && ['waiting', 'preparing', 'signed', 'submitted', 'unknown'].includes(o.status)) assets.set(assetKey(o.asset), o.asset);
    }
    await browser.tabs.sendMessage(owner, { type: 'subscriptions', assets: [...assets.values()] }).catch(() => {});
  }
  async function view(): Promise<View> {
    const db = await dbPromise, settings = await readSettings(db);
    const price = asset ? prices.get(assetKey(asset)) : undefined;
    const healthy = accountHealthy && Date.now() - lastSeen <= 45000 && session && Date.now() - session.receivedAt <= 45000 && fresh(price, Date.now(), settings.maxPriceAgeMs);
    const monitoring = settings.automatic && accountHealthy && Date.now() - lastSeen <= 45000 && !!session && Date.now() - session.receivedAt <= 45000 && [...prices.values()].some(p => fresh(p, Date.now(), settings.maxPriceAgeMs));
    return { settings, session, asset, selection, price, prices: Object.fromEntries(prices), monitoring,
      execution: accountHealthy ? execution : { ...EXECUTION }, status: status === 'ready' && !healthy ? 'disconnected' : status,
      reason: !asset ? reason || '请打开 FOMO 代币详情页，行情会跟随当前页面' : status === 'ready' && !healthy ? '账户或行情已过期，等待页面更新' : reason,
      orders: (await db.getAll('orders')).filter(o => o.accountId === session?.accountId).sort((a, b) => b.createdAt - a.createdAt),
      logs: (await db.getAllFromIndex('logs', 'at')).reverse().filter(l => !l.accountId || l.accountId === session?.accountId).slice(0, 500) };
  }
  browser.tabs.onActivated.addListener(({ tabId }) => {
    void serialized(async () => {
      const tab = await browser.tabs.get(tabId).catch(() => undefined);
      if (!tab?.url?.startsWith('https://fomo.family/')) return;
      changeOwner(tabId);
      await browser.tabs.sendMessage(tabId, { type: 'refresh-feed' }).catch(() => {});
    });
  });
  browser.tabs.onRemoved.addListener(tabId => {
    if (owner === tabId) { owner = undefined; status = 'disconnected'; prices.clear(); selection = undefined; reason = 'FOMO 页面已关闭，订单保留'; }
  });
  browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (sender.id !== browser.runtime.id) return false;
    const run = async () => {
      const db = await dbPromise;
      if (message?.channel === 'feed') {
        if (!sender.tab?.id || !sender.url?.startsWith('https://fomo.family/') || sender.frameId !== 0) throw new Error('不允许的数据来源');
        const feed = feedSchema.parse(message.data), tab = sender.tab.id;
        // Follow the active FOMO tab; a background tab cannot overwrite its context.
        if (owner !== undefined && owner !== tab) {
          if (!sender.tab.active) return;
          changeOwner(tab);
        } else if (owner === undefined) {
          if (!sender.tab.active) return;
          changeOwner(tab);
        }
        lastSeen = Date.now();
        if (feed.type === 'execution') {
          if (session?.accountId === feed.accountId) execution = { available: feed.available, networks: feed.networks, reason: feed.reason };
          return;
        }
        if (feed.type === 'execution-progress') {
          if (session?.accountId !== feed.accountId) return;
          const tx = db.transaction('orders', 'readwrite');
          const order = (await tx.store.getAll()).find(o => o.accountId === feed.accountId && o.attemptId === feed.attemptId && ['submitted', 'unknown'].includes(o.status));
          if (order) await tx.store.put({ ...order, ...(feed.transactionHash ? { transactionHash: feed.transactionHash } : {}),
            ...(feed.userOperationHash && order.executionReference ? { executionReference: { ...order.executionReference, userOperationHash: feed.userOperationHash } } : {}) });
          await tx.done;
          return;
        }
        if (feed.type === 'api-error') {
          const names = { metadata: '代币信息', balances: '账户余额', config: '交易配置' };
          const message = `FOMO ${names[feed.endpoint]}接口调用失败`;
          if (Date.now() - (apiLoggedAt.get(feed.endpoint) ?? 0) >= 300000) {
            await writeLog(db, { category: 'system', level: 'error', code: `api-${feed.endpoint}`, message, accountId: session?.accountId });
            apiLoggedAt.set(feed.endpoint, Date.now());
          }
          await notify(db, { channel: 'alerts', code: 'api-failure', message });
          return;
        }
        if (feed.type === 'context') {
          if (!asset || !feed.asset || !sameAsset(asset, feed.asset)) selection = undefined;
          asset = feed.asset;
          await syncSubscriptions();
        }
        if (feed.type === 'selection' && asset && sameAsset(feed.selection.asset, asset) && Date.now() - feed.selection.at < 10000 && feed.selection.at <= Date.now() + 1000 && Number(feed.selection.priceUsd) > 0) selection = feed.selection;
        if (feed.type === 'session') {
          if (feed.session.receivedAt < accountFailedAt || Date.now() - feed.session.receivedAt > 45000 || feed.session.receivedAt > Date.now() + 5000) return;
          if (session && session.accountId !== feed.session.accountId) {
            revoke(); execution = { ...EXECUTION };
            const settings = await readSettings(db); await db.put('state', { ...settings, automatic: false, realTrading: false }, 'settings'); prices.clear(); selection = undefined;
            await log('账户已切换，自动监控与真实下单已关闭', 'account-changed', 'system');
          }
          session = { ...feed.session, receivedAt: Math.min(Date.now(), feed.session.receivedAt) }; accountHealthy = true;
          await syncSubscriptions();
          void coordinator.reconcile().catch(() => {});
        }
        if (feed.type === 'price') {
          const key = assetKey(feed.price), old = prices.get(key);
          const wanted = asset && sameAsset(asset, feed.price) || (await db.getAll('orders')).some(o => session && o.accountId === session.accountId && ['waiting', 'preparing', 'signed', 'submitted', 'unknown'].includes(o.status) && sameAsset(o.asset, feed.price));
          if (wanted && (!old || feed.price.timestamp >= old.timestamp)) {
            const value = { ...feed.price, receivedAt: Date.now() }; prices.set(key, value);
            if (accountHealthy && session) { await evaluate(db, session, value); await coordinator.tick(session, value, tab); }
          }
        }
        if (feed.type === 'health') {
          const changed = status !== feed.status || reason !== feed.reason;
          status = feed.status; reason = feed.reason;
          if (status !== 'waiting') prices.clear();
          if (status === 'auth-expired' || status === 'error') { revoke(); accountHealthy = false; execution = { ...EXECUTION }; accountFailedAt = Date.now(); }
          if (status === 'auth-expired' || status === 'error') {
            const message = status === 'auth-expired' ? 'FOMO 登录凭据失效，请回到网站检查登录状态' : 'FOMO 接口调用失败，请检查网站与网络';
            if (changed) await writeLog(db, { category: 'system', level: 'error', code: status, message, accountId: session?.accountId });
            await notify(db, { channel: 'alerts', code: status === 'error' ? 'api-failure' : status, message });
          } else if (changed && status === 'disconnected') await log('行情连接已断开，等待重连', 'disconnected', 'system');
        } else if (accountHealthy && session && asset && prices.has(assetKey(asset))) { status = 'ready'; reason = ''; }
        return;
      }
      if (sender.tab || !sender.url?.startsWith(browser.runtime.getURL('/'))) throw new Error('不允许的操作来源');
      const cmd = commandSchema.parse(message);
      if (cmd.type === 'view') return view();
      if (cmd.type === 'language') {
        const settings = await readSettings(db);
        await db.put('state', { ...settings, language: cmd.language }, 'settings');
      }
      const price = asset ? prices.get(assetKey(asset)) : undefined;
      if (cmd.type === 'automatic') {
        if (cmd.enabled && (await view()).status !== 'ready') throw new Error('账户和实时行情就绪后才能开启');
        const settings = await readSettings(db); await db.put('state', { ...settings, automatic: cmd.enabled }, 'settings');
        if (!cmd.enabled) revoke();
        await log(cmd.enabled ? '自动监控已开启' : '自动监控已关闭', 'monitoring-changed');
        if (cmd.enabled && session && accountHealthy) for (const quote of prices.values()) { await evaluate(db, session, quote); if (owner !== undefined) await coordinator.tick(session, quote, owner); }
      }
      if (cmd.type === 'create') {
        if (!session || !price || !asset || (await view()).status !== 'ready') throw new Error('请先连接 FOMO 账户和新鲜行情');
        if (!sameAsset(cmd.draft.asset, asset)) throw new Error('页面币种已切换，请重新确认订单');
        await createOrder(db, { ...cmd.draft, asset }, session, price); await evaluate(db, session, price);
        if (owner !== undefined) await coordinator.tick(session, price, owner);
      }
      if (cmd.type === 'cancel') {
        const tx = db.transaction(['orders', 'logs'], 'readwrite');
        const order = await tx.objectStore('orders').get(cmd.id);
        if (!order || order.status !== 'waiting' || order.accountId !== session?.accountId) { await tx.done; throw new Error('该订单当前不能取消'); }
        await tx.objectStore('orders').put({ ...order, status: 'cancelled' });
        await tx.objectStore('logs').put({ id: crypto.randomUUID(), at: Date.now(), category: 'trade', level: 'info', code: 'order-cancelled', message: '条件单已取消', accountId: order.accountId, orderId: order.id, symbol: order.asset.symbol,
          order: orderSnapshot({ ...order, status: 'cancelled' }) });
        await tx.done;
      }
      if (cmd.type === 'real-trading') {
        if (cmd.enabled && (!execution.available || !accountHealthy || !session)) throw new Error(execution.reason);
        const settings = await readSettings(db);
        await db.put('state', { ...settings, realTrading: cmd.enabled }, 'settings');
        if (!cmd.enabled) revoke();
        await log(cmd.enabled ? '真实下单已开启' : '真实下单已关闭', 'real-trading-changed');
        // Wait for a fresh price after enabling; never execute from a stale panel snapshot.
      }
      if (cmd.type === 'notifications') {
        const settings = await readSettings(db);
        await db.put('state', { ...settings, notifications: cmd.notifications }, 'settings');
        await log('通知配置已保存；空地址对应的通知已关闭', 'notifications-saved');
      }

      if (cmd.type === 'refresh') { await log('已请求刷新 FOMO 连接', 'refresh'); await refreshPage(); }
      await syncSubscriptions();
      return view();
    };
    void serialized(run).then(data => sendResponse({ ok: true, data }), error => {
      // Log failures of panel actions, without raw input or exception text.
      if (!sender.tab && message?.type !== 'view') void serialized(async () => {
        await writeLog(await dbPromise, { category: 'operation', level: 'error', code: 'operation-failed', message: '操作未完成，请检查输入或连接状态', accountId: session?.accountId });
      }).catch(() => {});
      sendResponse({ ok: false, error: error instanceof Error && error.name === 'Error' ? error.message : '操作失败，请检查输入、连接状态或刷新页面' });
    });
    return true;
  });
  browser.alarms.onAlarm.addListener(() => {
    if (Date.now() - lastSeen > 45000) { revoke(); status = 'disconnected'; reason = 'FOMO 页面已离线，订单保留'; }
    void coordinator.reconcile().catch(() => {});
  });
});
