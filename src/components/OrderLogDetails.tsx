import type { Log, Order } from '../shared/model';
import { dateTime, orderKinds, orderStates } from '../shared/i18n';
import { FOMO_CHAINS, transactionUrl } from '../shared/chains';
import { orderSnapshot } from '../storage/logs';
import { useLanguage } from './Language';

export function OrderLogDetails({ log, current }: { log: Log; current?: Order }) {
  const { t, language } = useLanguage();
  const order = log.order ?? (current ? orderSnapshot(current) : undefined);
  if (!log.orderId) return null;
  if (!order) return <p className="subnote">{t('旧日志未保存订单详情，且当前订单已不可用。')}</p>;
  const chain = Object.entries(FOMO_CHAINS).find(([, id]) => id === order.asset.networkId)?.[0] ?? String(order.asset.networkId);
  const rows: [string, string | undefined][] = [
    [t('订单编号'), log.orderId], [t('币对'), `${order.asset.symbol} / USDC`], [t('网络'), `${chain} (${order.asset.networkId})`],
    [t('代币地址'), order.asset.tokenAddress], [t('订单类型'), t(orderKinds[order.kind])], [t('订单状态'), t(orderStates[order.status])],
    [t('执行方式'), order.mode ? t(order.mode === 'live' ? '真实下单' : '仅记录日志') : undefined],
    [t('最大滑点'), order.slippageBps === undefined ? t('未记录') : order.slippageBps > 0 ? `${order.slippageBps / 100}%` : t('未启用')],
    [t('目标价格'), `$${order.targetPrice}`], [t('事件发生时价格'), order.observedPrice === undefined ? undefined : `$${order.observedPrice}`],
    [t('买入金额'), order.kind === 'limit-buy' && order.amountUsd !== undefined ? `${order.amountUsd} USDC` : undefined],
    [t('委托数量'), order.quantity === undefined ? undefined : `${order.quantity} ${order.asset.symbol}`],
    [t('卖出比例'), order.sellPercent === undefined ? undefined : `${order.sellPercent}%`],
    [t('成交价格'), order.executionPrice === undefined ? undefined : `$${order.executionPrice}`],
    [t('成交数量'), order.fillQuantity === undefined ? undefined : `${order.fillQuantity} ${order.asset.symbol}`],
    [t('成交价值'), order.fillUsd === undefined ? undefined : `${order.fillUsd} USDC`],
    [t('确认核对时剩余仓位'), order.remainingQuantity === undefined ? undefined : `${order.remainingQuantity} ${order.asset.symbol}`],
    [t('创建时间'), dateTime(order.createdAt, language, true)],
    [t('首次触达时间'), order.triggeredAt === undefined ? undefined : dateTime(order.triggeredAt, language, true)],
    [t('提交时间'), order.submittedAt === undefined ? undefined : dateTime(order.submittedAt, language, true)],
    [t('确认时间'), order.confirmedAt === undefined ? undefined : dateTime(order.confirmedAt, language, true)],
    [t('父订单'), order.parentOrderId], [t('互斥组'), order.ocoGroupId], [t('原因'), order.reason ? t(order.reason) : undefined],
  ];
  const url = order.transactionHash ? transactionUrl(order.transactionHash, order.transactionNetworkId ?? order.asset.networkId) : undefined;
  return <details className="log-order-details">
    <summary>{t('订单详情')}<span>{t(orderKinds[order.kind])} · ${order.targetPrice}</span></summary>
    <p className="snapshot-note">{t(log.order ? '事件发生时的订单快照' : '当前订单资料；旧日志未保存事件快照')}</p>
    <dl>{rows.filter(([, value]) => value !== undefined).map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
    {order.protection && <dl>{([['takeProfit', '附带止盈'], ['stopLoss', '附带止损']] as const).map(([key, label]) => {
      const leg = order.protection?.[key];
      return leg ? <div key={key}><dt>{t(label)}</dt><dd>${leg.targetPrice} · {leg.sellPercent}% {t('本笔实买')}</dd></div> : null;
    })}</dl>}
    {order.transactionHash && <div className="log-hash"><strong>{t('交易哈希')}</strong>{url ? <a href={url} target="_blank" rel="noreferrer">{order.transactionHash}</a> : <span>{order.transactionHash}</span>}</div>}
  </details>;
}
