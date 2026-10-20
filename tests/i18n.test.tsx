import 'fake-indexeddb/auto';
import React from 'react';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { translator } from '../src/shared/i18n';
import { en } from '../src/i18n/en';
import { DEFAULT_SETTINGS, type Log, type Order } from '../src/shared/model';
import { database, readSettings } from '../src/storage/database';
import { LanguageContext } from '../src/components/Language';
import { OrderLogDetails } from '../src/components/OrderLogDetails';
import { orderSnapshot } from '../src/storage/logs';

it('旧设置默认中文，新语言在重开后保留且不覆盖交易和通知设置', async () => {
  const { language: _, ...legacy } = DEFAULT_SETTINGS;
  const name = crypto.randomUUID(); let db = await database(name);
  await db.put('state', { ...legacy, automatic: true, realTrading: true, notifications: { ordersWebhook: 'https://open.feishu.cn/open-apis/bot/v2/hook/test-language-channel', alertsWebhook: '' } }, 'settings');
  const old = await readSettings(db); expect(old.language).toBe('zh-CN');
  await db.put('state', { ...old, language: 'en' }, 'settings');
  db.close(); db = await database(name);
  expect(await readSettings(db)).toEqual({ ...old, language: 'en' }); db.close();
});
it('翻译新提示和历史动态日志，保留数值、参数和中文原始正文', () => {
  const t = translator('en');
  expect(t('目标价格')).toBe('Target price');
  expect(t('止盈 ${0} · {1}% ', { 0: '0.0000123456789', 1: '30' })).toContain('$0.0000123456789');
  expect(t('ETH 交易链上执行失败，请查看交易日志')).toBe('ETH transaction failed on-chain. See the trade logs');
  expect(t('附带{0}', { 0: t('止损') })).not.toMatch(/[\u3400-\u9fff]/);
  expect(t('unknown raw error 0.00001')).toBe('unknown raw error 0.00001');
  expect(translator('zh-CN')('成交价 ${0}', { 0: '0.00001' })).toBe('成交价 $0.00001');
});
it('界面直接使用的中文词条均有英文翻译，插值占位符不丢失', () => {
  const missing: string[] = [];
  for (const file of ['src/components/App.tsx', 'src/components/OrderLogDetails.tsx', 'src/components/NotificationChannel.tsx', 'src/notifications/notify.ts']) {
    const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const check = (node: ts.Node) => {
      if (ts.isCallExpression(node) && node.expression.getText(source) === 't' && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) {
        const key = node.arguments[0].text.trim();
        if (/[\u3400-\u9fff]/.test(key) && en[key] === undefined) missing.push(key);
      }
      ts.forEachChild(node, check);
    }; check(source);
  }
  expect(missing).toEqual([]);
  for (const [key, value] of Object.entries(en)) expect([...value.matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort(), key).toEqual([...key.matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort());
});
it('订单详情显示事件快照、完整哈希和零仓位；旧日志回退明确标注', () => {
  const order: Order = { id: 'complete-order-id', accountId: 'private-account', asset: { tokenAddress: 'public-contract', symbol: 'ETH', networkId: 8453, decimals: 18 }, kind: 'limit-buy', targetPrice: '0.000000012345678901', amountUsd: '0.1', createdAt: 1, status: 'confirmed', executionPrice: '0.00000001', remainingQuantity: '0', transactionHash: '0x' + 'a'.repeat(64) };
  const log: Log = { id: 'log', at: 1, category: 'trade', code: 'order-confirmed', message: '已成交', level: 'info', orderId: order.id, order: orderSnapshot(order) };
  const render = (record: Log, current?: Order) => renderToStaticMarkup(<LanguageContext.Provider value={{ language: 'en', t: translator('en') }}><OrderLogDetails log={record} current={current}/></LanguageContext.Provider>);
  const html = render(log, { ...order, status: 'cancelled' });
  for (const value of ['Order snapshot at this event', '0.000000012345678901', '0 ETH', 'Filled', 'https://basescan.org/tx/', order.transactionHash!]) expect(html).toContain(value);
  expect(html).not.toContain('private-account'); expect(html).not.toContain('Cancelled');
  const { order: _, ...legacy } = log;
  expect(render(legacy, order)).toContain('Current order data; no historical snapshot was saved');
  expect(render(legacy)).toContain('current order is unavailable');
});
