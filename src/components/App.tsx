import { LanguageContext, cachedLanguage, useLanguage } from './Language';
import { OrderLogDetails } from './OrderLogDetails';
import { NotificationChannel } from './NotificationChannel';
import { notificationsSchema } from '../shared/notifications';
import type { NotificationTarget } from '../shared/notifications';
import type { NotificationTestResult } from '../notifications/notify';
import { dateTime, translator, orderKinds as kinds, orderStates as states, type Language } from '../shared/i18n';
import { transactionUrl } from '../shared/chains';
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Activity, ArrowDownLeft, ArrowUpRight, Check, ChevronRight, CircleHelp, ExternalLink, Logs, ListOrdered, Power, RefreshCw, Settings2, ShieldCheck, SlidersHorizontal, Wallet, X } from 'lucide-react';
import Decimal from 'decimal.js';
import { DEFAULT_SETTINGS, EXECUTION, assetKey, sameAsset, type Asset, type Position, type Draft, type Order, type Price, type View } from '../shared/model';
import { percentage } from '../trading/engine';
const initial: View = { settings: DEFAULT_SETTINGS, status: 'waiting', orders: [], logs: [], prices: {}, execution: EXECUTION };
const currency = (n?: string | number, digits = 2) => n === undefined ? '—' : Number(n).toLocaleString('en-US', Math.abs(Number(n)) > 0 && Math.abs(Number(n)) < 0.01 ? { maximumSignificantDigits: 4 } : { minimumFractionDigits: digits, maximumFractionDigits: digits });
const priceText = (n?: string | number) => n === undefined ? '—' : Number(n) === 0 ? '0' : Number(n).toLocaleString('en-US', { maximumSignificantDigits: 8, maximumFractionDigits: 20 });
const amount = (n?: string) => n === undefined ? '—' : Number(n).toLocaleString('en-US', { maximumFractionDigits: 6 });
export function App() {
    const [language, setLanguage] = useState<Language>(cachedLanguage);
    const t = useMemo(() => translator(language), [language]);
    const time = (n: number) => dateTime(n, language);
    useEffect(() => { document.documentElement.lang = language; document.title = t('FOMO 工作台'); try {
        localStorage.setItem('fomo-language', language);
    }
    catch { } }, [language]);
    const [view, setView] = useState<View>(initial), [tab, setTab] = useState('trade');
    const [kind, setKind] = useState<Draft['kind']>('limit-buy');
    const [takeProfit, setTakeProfit] = useState({ enabled: false, targetPrice: '', sellPercent: '100' });
    const [stopLoss, setStopLoss] = useState({ enabled: false, targetPrice: '', sellPercent: '100' });
    const [target, setTarget] = useState(''), [usd, setUsd] = useState(''), [percent, setPercent] = useState('30');
    const [error, setError] = useState(''), [notice, setNotice] = useState(''), [busy, setBusy] = useState(false);
    const [slippageDraft, setSlippageDraft] = useState('');
    const [logFilter, setLogFilter] = useState('all');
    const [notificationDraft, setNotificationDraft] = useState(DEFAULT_SETTINGS.notifications);
    const [notificationsDirty, setNotificationsDirty] = useState(false);
    const lastSelection = useRef<string | undefined>(undefined);
    const [now, setNow] = useState(Date.now());
    const extension = typeof chrome !== 'undefined' && !!chrome.runtime?.id;
    async function testNotification(channel: 'orders' | 'alerts', target: NotificationTarget): Promise<NotificationTestResult> {
        if (!extension) return { sent: false, message: '请在 Chrome 中加载扩展后测试通知' };
        try {
            const result = await chrome.runtime.sendMessage({ type: 'notification-test', channel, target });
            if (result?.ok && result.test && typeof result.test.sent === 'boolean' && typeof result.test.message === 'string') return result.test;
        } catch { /* Do not display raw runtime errors or notification credentials. */ }
        return { sent: false, message: '无法测试通知，请检查配置或重新打开扩展' };
    }
    async function request(command: object, silent = false) {
        if (!extension) {
            if (!silent)
                setError("请先在 Chrome 中加载插件，再连接 FOMO 页面");
            return;
        }
        try {
            const result = await chrome.runtime.sendMessage(command);
            if (!result?.ok) {
                if (!silent)
                    setError(result?.error ?? "操作失败");
                return;
            }
            if (result.data) {
                setView(result.data);
                setLanguage(result.data.settings.language ?? 'zh-CN');
            }
            return result.data as View | undefined;
        }
        catch {
            if (!silent)
                setError("插件连接中断，请重新打开工作台");
        }
    }
    useEffect(() => { void request({ type: 'view' }, true); const timer = setInterval(() => { setNow(Date.now()); void request({ type: 'view' }, true); }, 2000); return () => clearInterval(timer); }, []);
    const fresh = !!view.price && now - view.price.timestamp <= view.settings.maxPriceAgeMs && now - view.price.receivedAt <= view.settings.maxPriceAgeMs;
    const connected = view.status === 'ready' && fresh;
    const monitoring = view.monitoring ?? (view.settings.automatic && connected);
    const asset = view.asset;
    const symbol = asset?.symbol ?? t("选择代币");
    const actualQuantity = view.session?.positions.filter(p => asset && sameAsset(p, asset)).reduce((q, p) => q.plus(p.quantity), new Decimal(0)).toFixed() ?? '0';
    const holding = view.session?.positions.find(p => asset && sameAsset(p, asset));
    const livePrice = view.price?.priceUsd;
    const change = percentage(target, livePrice), costChange = percentage(target, holding?.costUsd);
    useEffect(() => { setSlippageDraft(''); setTarget(''); setNotice(''); setTakeProfit({ enabled: false, targetPrice: '', sellPercent: '100' }); setStopLoss({ enabled: false, targetPrice: '', sellPercent: '100' }); }, [asset ? assetKey(asset) : '']);
    useEffect(() => {
        const selected = view.selection;
        if (!selected || !asset || !sameAsset(selected.asset, asset) || selected.id === lastSelection.current)
            return;
        lastSelection.current = selected.id;
        if (Date.now() - selected.at > 15000)
            return;
        setTarget(selected.priceUsd);
        setTab('trade');
        setNotice("已带入 K 线所选价格");
    }, [view.selection?.id, asset ? assetKey(asset) : '']);
    const pending = view.orders.filter(o => ['waiting', 'preparing', 'signed', 'submitted', 'unknown'].includes(o.status));
    const buy = kind === 'limit-buy';
    let estimate = '—';
    try {
        estimate = buy ? usd && target ? amount(new Decimal(usd).div(target).toDecimalPlaces(asset?.decimals ?? 9, Decimal.ROUND_DOWN).toFixed()) + ' ' + symbol : '—' : percent && target ? '$' + currency(new Decimal(actualQuantity).mul(percent).div(100).mul(target).toFixed()) : '—';
    }
    catch { /* Invalid input remains visible for correction. */ }
    const run = async (command: object) => { setBusy(true); setError(''); setNotice(''); const result = await request(command); setBusy(false); return result; };
    async function submit(event: FormEvent) {
        event.preventDefault();
        if (!asset)
            return;
        const result = await run({ type: 'create', draft: { asset, kind, targetPrice: target, ...(slippageDraft.trim() && Number(slippageDraft) > 0 ? { slippageBps: new Decimal(slippageDraft).mul(100).toNumber() } : {}), ...(buy ? { amountUsd: usd, ...(takeProfit.enabled || stopLoss.enabled ? { protection: { ...(takeProfit.enabled ? { takeProfit: { targetPrice: takeProfit.targetPrice, sellPercent: takeProfit.sellPercent } } : {}), ...(stopLoss.enabled ? { stopLoss: { targetPrice: stopLoss.targetPrice, sellPercent: stopLoss.sellPercent } } : {}) } } : {}) } : { sellPercent: percent }) } });
        if (result) {
            setNotice("条件单已保存，尚未提交交易");
            setTab('orders');
        }
    }
    function exportOrders() {
        const payload = { schemaVersion: 3, exportedAt: new Date().toISOString(), orders: view.orders.map(({ accountId: _, ...order }) => order) };
        const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }));
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = 'fomo-orders.json';
        anchor.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
    useEffect(() => {
        if (!notificationsDirty)
            setNotificationDraft(view.settings.notifications);
    }, [view.settings.notifications, notificationsDirty]);
    function exportLogs() {
        const records = view.logs.map(({ accountId: _, ...record }) => ({ ...record, displayMessage: t(record.message) }));
        const url = URL.createObjectURL(new Blob([JSON.stringify({ schemaVersion: 2, language, exportedAt: new Date().toISOString(), logs: records }, null, 2)], { type: 'application/json' }));
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = 'fomo-logs.json';
        anchor.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
    return <LanguageContext.Provider value={{ language, t }}><div className="shell">
    <header><div className="brand"><span className="brand-mark">f</span><div><strong>fomo<span className="brand-light"> companion</span></strong></div></div><label className="language-picker"><span>{t("语言")}</span><select aria-label={t("语言 / Language")} value={language} disabled={busy} onChange={event => { const next = event.target.value as Language; if (extension)
        void run({ type: 'language', language: next });
    else
        setLanguage(next); }}><option value="zh-CN" lang="zh-CN">{t("中文")}</option><option value="en" lang="en">English</option></select></label></header>
    <section className="connection"><span className={`dot ${connected ? 'online' : ''}`}/><span>{connected ? t("FOMO 已连接") : view.status === 'auth-expired' ? t("请检查登录状态") : t("等待 FOMO 连接")}</span><button className="icon" aria-label={t("刷新账户")} disabled={busy} onClick={() => void run({ type: 'refresh' })}><RefreshCw size={14}/></button><span className="connection-right">{t("单账户 · 浏览器在线")}</span></section>
    <section className="market">
      <div className="market-top"><div className="token"><TokenAvatar asset={asset}/><strong>{symbol} <span>/ USD</span></strong></div><span className="eyebrow">{t("实时行情")}</span></div>
      <div className="quote">${priceText(livePrice)}<span className={`price-state ${fresh ? 'positive' : ''}`}><Activity size={12} aria-hidden="true"/>{fresh ? t("实时") : t("待更新")}</span></div>
      <div className="market-stats"><div><span>{t("真实持仓")}</span><strong>{view.session ? amount(actualQuantity) : '—'} <small>{asset?.symbol ?? '—'}</small></strong></div><div><span>{t("平均买入价")}</span><strong>{holding?.costUsd ? '$' + priceText(holding.costUsd) : '—'}</strong></div></div>
    </section>
    <section className={`engine ${monitoring ? 'running' : ''}`}><div className="engine-icon"><Power size={18}/></div><div><strong>{view.settings.automatic ? monitoring ? t("自动监控运行中") : t("自动监控已暂停") : t("自动监控已关闭")}</strong><p>{view.settings.automatic ? monitoring ? t("监控当前币种及所有待执行条件单") : t("等待账户和新鲜行情恢复") : t("条件单会保存，开启后开始监控")}</p></div><button className="switch" role="switch" aria-checked={view.settings.automatic} aria-label={t("自动监控")} disabled={busy || !connected && !view.settings.automatic} onClick={() => void run({ type: 'automatic', enabled: !view.settings.automatic })}><span /></button></section>
    {!connected && <div className="hint"><CircleHelp size={16} aria-hidden="true"/><div>{t(view.reason || '打开已登录的 FOMO 页面，首次安装后请刷新页面。')}<a href="https://fomo.family/discover" target="_blank" rel="noreferrer">{t("打开 FOMO")}<ExternalLink size={11}/></a></div></div>}
    <nav aria-label={t("工作台导航")}>{[{ id: 'trade', text: t("交易"), icon: SlidersHorizontal }, { id: 'orders', text: t("条件单{0}", { 0: pending.length ? ` ${pending.length}` : '' }), icon: ListOrdered }, { id: 'positions', text: t("持仓"), icon: Wallet }, { id: 'logs', text: t("日志"), icon: Logs }, { id: 'settings', text: t("设置"), icon: Settings2 }].map(item => <button key={item.id} className={tab === item.id ? 'selected' : ''} aria-current={tab === item.id ? 'page' : undefined} onClick={() => { setTab(item.id); setError(''); }}><item.icon size={15} aria-hidden="true"/>{item.text}</button>)}</nav>
    <main>
      {error && <div className="feedback error" role="alert">{t(error)}<button className="icon" aria-label={t("关闭错误提示")} onClick={() => setError('')}><X size={14}/></button></div>}
      {notice && <div className="feedback success" role="status"><Check size={14} aria-hidden="true"/>{t(notice)}<button className="icon" aria-label={t("关闭提示")} onClick={() => setNotice('')}><X size={14}/></button></div>}
      {tab === 'trade' && <form onSubmit={submit}>
        <div className="section-title"><h1>{t("创建条件单")}</h1><span>{asset?.symbol ?? t("跟随当前代币页")}</span></div>
        <div className="trade-types">{Object.entries(kinds).map(([value, label]) => <button type="button" key={value} aria-pressed={kind === value} className={kind === value ? `active ${value === 'limit-buy' ? 'buy' : 'sell'}` : ''} onClick={() => setKind(value as Draft['kind'])}>{t(label)}</button>)}</div>
        <label className="field-label" htmlFor="target">{t("目标价格")}<span>USD</span></label><div className="price-input"><span>$</span><input id="target" inputMode="decimal" autoComplete="off" required value={target} onChange={e => setTarget(e.target.value)} placeholder={livePrice ? priceText(livePrice) : t("输入目标价")}/><button type="button" disabled={!livePrice} onClick={() => setTarget(livePrice!)}>{t("现价")}</button></div>
        <div className="deviation"><span className={change === undefined ? 'muted' : Number(change) >= 0 ? 'positive' : 'negative'}>{change ? t("较现价 {0}{1}%", { 0: Number(change) > 0 ? '+' : '', 1: change }) : t("输入价格后显示涨跌幅")}</span>{costChange && <span>{t("较成本")}{Number(costChange) > 0 ? '+' : ''}{costChange}%</span>}</div>
        <div className="presets">{[-10, -5, 5, 10].map(n => <button type="button" key={n} disabled={!livePrice} onClick={() => setTarget(new Decimal(livePrice!).mul(new Decimal(1).plus(new Decimal(n).div(100))).toFixed())}>{n > 0 ? '+' : ''}{n}%</button>)}</div>
        <label className="field-label" htmlFor="size">{buy ? t("买入金额") : t("卖出比例")}<span>{buy ? 'USD' : '%'}</span></label><div className="size-input"><input id="size" inputMode="decimal" autoComplete="off" required value={buy ? usd : percent} onChange={e => buy ? setUsd(e.target.value) : setPercent(e.target.value)}/><span>{buy ? 'USD' : '%'}</span></div>
        <div className="presets">{(buy ? ['10', '50', '100'] : ['30', '50', '100']).map(n => <button type="button" key={n} className={(buy ? usd : percent) === n ? 'chosen' : ''} onClick={() => buy ? setUsd(n) : setPercent(n)}>{n}{buy ? 'U' : '%'}</button>)}<span className="custom-hint">{t("支持自定义输入")}</span></div>
        <div className="order-slippage"><label className="field-label" htmlFor="slippage">{t('最大滑点')}<span>{t('可选 · 0%～5%')}</span></label><div className="size-input"><input id="slippage" type="number" min="0" max="5" step="0.01" inputMode="decimal" value={slippageDraft} disabled={busy} aria-describedby="slippage-help" placeholder={t('不启用')} onChange={event => setSlippageDraft(event.target.value)}/><span>%</span></div><p id="slippage-help" className="subnote">{t('留空或填 0 不启用滑点保护；填写正数仅适用于本单，附带止盈止损继承。平台仍可能有内置成交限制。')}</p></div>
        {buy && <section className="protection-section" aria-label={t("附带止盈止损")}><h2>{t("附带止盈止损")}<span>{t("可选")}</span></h2><p className="subnote">{t("买入成交后，按本笔实际买入数量启用。两侧互斥，一侧成交后另一侧取消；部分卖出后也不保留另一侧。")}</p>
          <ProtectionLeg id="take-profit" title={t("止盈")} value={takeProfit} onChange={setTakeProfit} baseline={target}/>
          <ProtectionLeg id="stop-loss" title={t("止损")} value={stopLoss} onChange={setStopLoss} baseline={target}/>
        </section>}
        <div className="estimate"><div><span>{buy ? t("预计买入") : t("预计卖出金额")}</span><strong>{estimate}</strong></div><div><span>{t("触发条件")}</span><span>{symbol} {kind === 'limit-buy' || kind === 'stop-loss' ? '≤' : '≥'} ${target || '—'}</span></div><div><span>{t("执行方式")}</span><span>{view.settings.realTrading ? t("真实下单") : t("仅监控 · 真实下单关闭")}</span></div></div>
        <button className={`primary ${buy ? '' : 'sell-button'}`} disabled={busy || !connected || !asset} type="submit">{buy ? <ArrowDownLeft size={17}/> : <ArrowUpRight size={17}/>}{t(buy ? '保存买入条件单' : '保存卖出条件单')}<ChevronRight size={16}/></button>
        <p className="chart-note">{t("点击 FOMO 主价格 K 线可带入买卖目标价；市值模式按供应量换算。切币会清空价格及附带设置。插件不设最低交易金额，平台会在报价时校验。")}</p><p className="form-note"><ShieldCheck size={13} aria-hidden="true"/>{view.settings.realTrading ? t("触发并校验报价后提交真实交易，以链上确认为准。") : t("真实下单关闭时仅保存和监控，不生成成交。")}</p>
      </form>}
      {tab === 'orders' && <><div className="section-title"><h1>{t("条件单与记录")}</h1><span>{view.orders.length}{t("条")}</span></div>{view.orders.length === 0 ? <Empty icon="orders" text={t("还没有条件单")} detail={t("设置目标价格，让交易按计划发生。")}/> : view.orders.map(order => <article className="order" key={order.id}><div className="order-head"><strong>{order.asset.symbol} · {t(kinds[order.kind])}</strong><span className={`order-status ${order.status}`}>{t(states[order.status])}</span></div><div className="order-price">${priceText(order.targetPrice)}<span>{order.kind === 'limit-buy' ? `${order.amountUsd}U` : `${order.sellPercent}% · ${amount(order.quantity)} ${order.asset.symbol}`}</span></div>{order.protection && <p className="muted">{t("附带：")}{order.protection.takeProfit && t("止盈 ${0} · {1}% ", { 0: priceText(order.protection.takeProfit.targetPrice), 1: order.protection.takeProfit.sellPercent })}{order.protection.stopLoss && t("止损 ${0} · {1}%", { 0: priceText(order.protection.stopLoss.targetPrice), 1: order.protection.stopLoss.sellPercent })}{t("（本笔实买；成交后启用）")}</p>}{order.parentOrderId && <p className="muted">{t("本笔买入保护 · 关联")}{order.parentOrderId.slice(0, 8)}{t("· 互斥卖单")}</p>}<p className="muted">{t("最大滑点")} · {order.slippageBps === undefined && order.status !== 'waiting' ? t("未记录") : order.slippageBps ? `${order.slippageBps / 100}%` : t("未启用")}</p><OrderPrice price={view.prices[assetKey(order.asset)]} now={now} maxAge={view.settings.maxPriceAgeMs}/><div className="order-foot"><span>{time(order.createdAt)}</span>{order.status === 'waiting' ? <button disabled={busy} onClick={() => void run({ type: 'cancel', id: order.id })}>{t("取消条件单")}</button> : <span>{order.executionPrice ? t("成交价 ${0}", { 0: priceText(order.executionPrice) }) : order.triggeredAt ? t("曾达到目标，未提交") : t(states[order.status])}</span>}</div>{order.transactionHash && transactionUrl(order.transactionHash, order.executionReference?.originNetworkId ?? order.asset.networkId) && <a className="transaction-link" href={transactionUrl(order.transactionHash, order.executionReference?.originNetworkId ?? order.asset.networkId)} target="_blank" rel="noreferrer">{t("查看链上交易")}<ExternalLink size={11}/></a>}{order.fillQuantity && <p className="muted">{t("实际成交")}{amount(order.fillQuantity)} {order.asset.symbol} · {currency(order.fillUsd)} USDC</p>}{order.remainingQuantity !== undefined && <p className="muted">{t("确认核对时剩余")}{amount(order.remainingQuantity)} {order.asset.symbol}</p>}{order.reason && <p className={order.status === 'waiting' ? 'muted' : 'negative'}>{t(order.reason)}</p>}{order.triggeredAt && order.status === 'waiting' && <p className="muted">{time(order.triggeredAt)}{t("曾达到目标，未提交交易")}</p>}{order.status === 'simulated' && <p className="muted">{t("历史模拟记录，未发生真实交易。")}</p>}</article>)}</>}
      {tab === 'positions' && <><div className="section-title"><h1>{t("账户持仓")}</h1><span>{t("只读 · 真实账户")}</span></div>{!view.session ? <Empty icon="wallet" text={t("等待账户连接")} detail={t("登录信息由 FOMO 页面提供，无需手动粘贴 Token。")}/> : <><p className="subnote">{t("此处显示 FOMO 账户的实际余额与持仓。")}</p>{view.session.positions.filter(p => Number(p.quantity) > 0).map((p, i) => <PositionRow key={`${p.networkId}:${p.tokenAddress}:${i}`} position={p} livePrice={view.price && sameAsset(p, view.price) && fresh ? view.price.priceUsd : p.priceUsd}/>)}<p className="subnote">{t("买入价为平均买入价；未实现盈亏不包含已实现收益。")}</p></>}</>}
      {tab === 'logs' && <><div className="section-title"><h1>{t("操作与交易日志")}</h1><span>{t("最近")}{view.logs.length}{t("条")}</span></div>
        <div className="log-filters" role="group" aria-label={t("日志类型")}>{[{ id: 'all', label: t("全部") }, { id: 'operation', label: t("操作") }, { id: 'trade', label: t("交易") }, { id: 'system', label: t("系统") }].map(item => <button key={item.id} aria-pressed={logFilter === item.id} onClick={() => setLogFilter(item.id)}>{item.label}</button>)}</div>
        {view.logs.filter(log => logFilter === 'all' || log.category === logFilter).length === 0 ? <Empty icon="orders" text={t("暂无日志")} detail={t("操作、条件单变化和系统异常会保存在此浏览器。")}/> : view.logs.filter(log => logFilter === 'all' || log.category === logFilter).map(log => <article className="log-entry" key={log.id}>
          <div className="log-meta"><span>{{ operation: t("操作"), trade: t("交易"), system: t("系统") }[log.category]} · {{ info: t("信息"), warning: t("提醒"), error: t("错误") }[log.level]}</span><time dateTime={new Date(log.at).toISOString()}>{time(log.at)}</time></div>
          <p className={log.level === 'error' ? 'negative' : ''}>{t(log.message)}</p>
          {(log.symbol || log.orderId) && <small>{log.symbol} {log.orderId && t("· 订单 {0}", { 0: log.orderId.slice(0, 8) })}</small>}
          <OrderLogDetails log={log} current={view.orders.find(order => order.id === log.orderId)}/>
        </article>)}<button className="secondary" disabled={!view.logs.length} onClick={exportLogs}>{t("导出脱敏日志")}</button><p className="subnote">{t("目标价触达、报价和交易提交均不代表成交。只有收到真实成交确认后才发送订单通知。")}</p></>}
      {tab === 'settings' && <><div className="section-title"><h1>{t("运行设置")}</h1><span>v0.9.0</span></div>
        <div className="setting-row"><div><strong>{t("真实下单")}</strong><p>{view.settings.realTrading ? t("已开启，触发后提交真实交易") : t("已关闭，价格触达只记录日志")}</p></div><button className="switch" role="switch" aria-label={t("真实下单")} aria-describedby="execution-status" aria-checked={view.settings.realTrading} disabled={busy || !view.execution.available && !view.settings.realTrading} onClick={() => void run({ type: 'real-trading', enabled: !view.settings.realTrading })}><span /></button></div>
        <p id="execution-status" className="subnote">{t(view.execution.reason)}{t("。关闭开关可阻止后续提交，已上链交易继续核对结果。")}</p>

        <form className="notifications-form" onSubmit={async (event) => { event.preventDefault(); if (!notificationsSchema.safeParse(notificationDraft).success) { setError('请检查通知渠道配置'); return; } if (await run({ type: 'notifications', notifications: notificationDraft })) {
            setNotificationsDirty(false);
            setNotice("通知配置已保存");
        } }}>
          <h2>{t("通知")}</h2><p className="subnote">{t("订单与告警可分别选择渠道；未配置不发送，也不补发此前的通知。")}</p>
          <p className="subnote">{t("切换渠道会清空该类通知的输入，保存后生效。")}</p>
          {(['orders', 'alerts'] as const).map(channel => <NotificationChannel key={channel} channel={channel} value={notificationDraft[channel]} disabled={busy}
            onTest={target => testNotification(channel, target)}
            onChange={value => { setNotificationsDirty(true); setNotificationDraft(current => ({ ...current, [channel]: value })); }}/>
          )}
          <button className="secondary" type="submit" disabled={busy || !notificationsDirty}>{t("保存通知配置")}</button>
        </form>
        <button className="secondary" onClick={exportOrders}>{t("导出脱敏订单")}</button><p className="subnote">{t("日志面板和导出文件不包含 Token、Cookie、账户 ID 或通知地址。旧版模拟条件单仅保留历史，不会转为真实订单。")}</p>
      </>}

    </main>
    <footer><span><ShieldCheck size={12} aria-hidden="true"/>{t("订单保存在此浏览器")}</span><span>{t("关闭浏览器后停止监控")}</span></footer>
  </div></LanguageContext.Provider>;
}
function Empty({ icon, text, detail }: {
    icon: string;
    text: string;
    detail: string;
}) { const { t } = useLanguage(); return <div className="empty">{icon === 'orders' ? <ListOrdered size={28} aria-hidden="true"/> : <Wallet size={28} aria-hidden="true"/>}<strong>{t(text)}</strong><p>{t(detail)}</p></div>; }
function TokenAvatar({ asset }: {
    asset?: Pick<Asset, 'symbol' | 'logoUrl'>;
}) {
    const [failed, setFailed] = useState(false);
    useEffect(() => setFailed(false), [asset?.logoUrl]);
    return <span className="coin-badge">{asset?.logoUrl && !failed ? <img src={asset.logoUrl} alt="" referrerPolicy="no-referrer" onError={() => setFailed(true)}/> : asset?.symbol.slice(0, 2) ?? '?'}</span>;
}
function PositionRow({ position: p, livePrice }: {
    position: Position;
    livePrice?: string;
}) {
    const { t } = useLanguage();
    const cost = p.costUsd && new Decimal(p.costUsd).gt(0) ? p.costUsd : undefined;
    const pnl = livePrice !== undefined && cost ? new Decimal(livePrice).minus(cost).mul(p.quantity) : undefined;
    const rate = percentage(livePrice ?? '', cost);
    return <article className="position-card"><div className="position"><TokenAvatar asset={p}/><div><strong>{p.symbol}</strong><small>{amount(p.quantity)} {p.symbol}</small></div><div className="position-value"><strong>{livePrice !== undefined ? '$' + currency(new Decimal(p.quantity).mul(livePrice).toFixed()) : '—'}</strong><small>{t("现价 $")}{priceText(livePrice)}</small></div></div><div className="position-detail"><div><span>{t("平均买入价")}</span><strong>{cost ? '$' + priceText(cost) : '—'}</strong></div><div><span>{t("未实现盈亏")}</span><strong className={pnl ? pnl.gte(0) ? 'positive' : 'negative' : ''}>{pnl ? `${pnl.gte(0) ? '+' : '−'}$${currency(pnl.abs().toFixed())} (${Number(rate) >= 0 ? '+' : ''}${rate}%)` : '—'}</strong></div></div></article>;
}
function OrderPrice({ price, now, maxAge }: {
    price?: Price;
    now: number;
    maxAge: number;
}) {
    const { t } = useLanguage();
    const current = !!price && now - price.timestamp <= maxAge && now - price.receivedAt <= maxAge && price.timestamp <= now + 5000;
    return <div className="order-current-price"><span>{t("当前价格")}</span><strong>{price ? '$' + priceText(price.priceUsd) : '—'}</strong><small className={current ? 'positive' : 'muted'}>{current ? t("实时") : price ? t("已过期") : t("待更新")}</small></div>;
}
type ProtectionValue = {
    enabled: boolean;
    targetPrice: string;
    sellPercent: string;
};
function ProtectionLeg({ id, title, value, onChange, baseline }: {
    id: string;
    title: string;
    value: ProtectionValue;
    onChange: (value: ProtectionValue) => void;
    baseline: string;
}) {
    const { t } = useLanguage();
    const change = percentage(value.targetPrice, baseline);
    return <div className="protection-leg">
    <label className="protection-toggle"><input type="checkbox" checked={value.enabled} onChange={e => onChange({ ...value, enabled: e.target.checked })}/><span>{t('附带{0}', { 0: title })}</span></label>
    {value.enabled && <div className="protection-fields">
      <label className="field-label" htmlFor={`${id}-price`}>{t('{0}目标价格', { 0: title })}<span>USD</span></label>
      <div className="price-input"><span>$</span><input id={`${id}-price`} inputMode="decimal" autoComplete="off" required value={value.targetPrice} onChange={e => onChange({ ...value, targetPrice: e.target.value })} placeholder={id === 'take-profit' ? t("高于买入限价") : t("低于买入限价")}/></div>
      <div className="deviation"><span className={change === undefined ? 'muted' : Number(change) >= 0 ? 'positive' : 'negative'}>{change === undefined ? t("输入价格后显示相对买入限价的涨跌幅") : t("较买入限价 {0}{1}%", { 0: Number(change) > 0 ? '+' : '', 1: change })}</span></div>
      <div className="presets">{(id === 'take-profit' ? [10, 20, 50] : [-5, -10, -20]).map(n => <button type="button" key={n} disabled={!baseline || !(Number(baseline) > 0)} onClick={() => onChange({ ...value, targetPrice: new Decimal(baseline).mul(new Decimal(1).plus(new Decimal(n).div(100))).toFixed() })}>{n > 0 ? '+' : ''}{n}%</button>)}</div>
      <label className="field-label" htmlFor={`${id}-percent`}>{t('{0}卖出比例', { 0: title })}<span>{t("本笔实买的 %")}</span></label>
      <div className="size-input"><input id={`${id}-percent`} type="number" min="0.000001" max="100" step="any" required value={value.sellPercent} onChange={e => onChange({ ...value, sellPercent: e.target.value })}/><span>%</span></div>
      <div className="presets">{['30', '50', '100'].map(n => <button type="button" key={n} className={value.sellPercent === n ? 'chosen' : ''} onClick={() => onChange({ ...value, sellPercent: n })}>{n}%</button>)}<span className="custom-hint">{t("支持自定义")}</span></div>
    </div>}
  </div>;
}
