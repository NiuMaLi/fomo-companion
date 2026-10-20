import { en } from '../i18n/en';

export type Language = 'zh-CN' | 'en';
export type Translate = (message: string, values?: Record<string, string | number>) => string;
export const orderKinds = { 'limit-buy': '限价买入', 'limit-sell': '限价卖出', 'take-profit': '止盈卖出', 'stop-loss': '止损卖出' };
export const orderStates = { waiting: '等待触发', simulated: '旧版模拟记录', cancelled: '已取消', blocked: '已阻止', archived: '已归档', preparing: '准备交易', signed: '已签名', submitted: '等待确认', confirmed: '已成交', failed: '执行失败', unknown: '结果待核对' };
const interpolate = (text: string, values: Record<string, string | number>) => text.replace(/\{(\w+)\}/g, (match, key) => values[key] === undefined ? match : String(values[key]));
const patterns = Object.entries(en).filter(([key]) => /\{\w+\}/.test(key)).map(([key, value]) => {
  const keys: string[] = [];
  const source = key.split(/(\{\w+\})/).map(part => {
    const name = /^\{(\w+)\}$/.exec(part)?.[1];
    if (name) { keys.push(name); return '([\\s\\S]+?)'; }
    return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }).join('');
  return { keys, value, pattern: new RegExp(`^${source}$`) };
});

// Stored log messages keep their original audit text. Translate only when rendering
// or sending a new notification, so switching language also covers older records.
export function translator(language: Language): Translate {
  const translate = (message: string, values: Record<string, string | number> = {}, depth = 0): string => {
    if (language === 'zh-CN') return interpolate(message, values);
    const exact = en[message] ?? en[message.trim()];
    if (exact !== undefined) return interpolate(exact, values);
    if (depth < 3) for (const entry of patterns) {
      const match = entry.pattern.exec(message.trim());
      if (match) return interpolate(entry.value, Object.fromEntries(entry.keys.map((key, i) => [key, translate(match[i + 1]!, {}, depth + 1)])));
    }
    return interpolate(message, values);
  };
  return translate;
}
export function dateTime(value: number, language: Language, full = false) {
  return new Intl.DateTimeFormat(language === 'en' ? 'en-US' : 'zh-CN', {
    ...(full ? { year: 'numeric' as const, second: '2-digit' as const } : {}), month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(value);
}
