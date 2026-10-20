import { z } from 'zod';

// Both MV3 extension pages and FOMO's MAIN world forbid runtime code generation.
z.config({ jitless: true });

export const BRIDGE = 'fomo-companion-v1';
const numeric = z.string().regex(/^-?\d+(\.\d+)?$/).max(100);
export const assetSchema = z.object({
  tokenAddress: z.string().min(1).max(200), networkId: z.number().int(),
  symbol: z.string().min(1).max(40), name: z.string().max(200).optional(),
  logoUrl: z.string().url().refine(v => v.startsWith('https://')).optional(),
  decimals: z.number().int().min(0).max(30).optional(),
});
export type Asset = z.infer<typeof assetSchema>;
export const assetKey = (a: Pick<Asset, 'tokenAddress' | 'networkId'>) => `${a.tokenAddress.startsWith('0x') ? a.tokenAddress.toLowerCase() : a.tokenAddress}:${a.networkId}`;
export const sameAsset = (a: Pick<Asset, 'tokenAddress' | 'networkId'>, b: Pick<Asset, 'tokenAddress' | 'networkId'>) => assetKey(a) === assetKey(b);
export const positionSchema = z.object({
  tokenAddress: z.string().min(1).max(200), networkId: z.number().int(),
  symbol: z.string().max(40), quantity: numeric, priceUsd: numeric.optional(),
  costUsd: numeric.optional(),
}).extend({ name: assetSchema.shape.name, logoUrl: assetSchema.shape.logoUrl, decimals: assetSchema.shape.decimals });
export const sessionSchema = z.object({
  accountId: z.string().min(1).max(200), positions: z.array(positionSchema).max(1000),
  minimumBuyUsd: numeric, minimumSellUsd: numeric,
  minimumsByNetwork: z.record(z.string(), z.object({ buy: numeric, sell: numeric })).optional(),
  receivedAt: z.number().finite(),
});
export const priceSchema = z.object({
  tokenAddress: z.string().min(1).max(200), networkId: z.number().int(),
  priceUsd: numeric, timestamp: z.number().finite(), receivedAt: z.number().finite(),
});
const protectionLeg = z.object({ targetPrice: numeric, sellPercent: numeric });
export const draftSchema = z.object({
  asset: assetSchema,
  kind: z.enum(['limit-buy', 'limit-sell', 'take-profit', 'stop-loss']),
  targetPrice: numeric, amountUsd: numeric.optional(), sellPercent: numeric.optional(),
  slippageBps: z.number().int().min(0).max(500).optional(),
  protection: z.object({ takeProfit: protectionLeg.optional(), stopLoss: protectionLeg.optional() }).optional(),
});
const webhook = z.string().trim().max(500).refine(value => {
  if (!value) return true;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'open.feishu.cn' && !url.port &&
      !url.username && !url.password && !url.search && !url.hash && /^\/open-apis\/bot\/v2\/hook\/[A-Za-z0-9_-]{10,200}$/.test(url.pathname);
  } catch { return false; }
}, '请输入有效的飞书自定义机器人 Webhook，或留空关闭通知');
export const notificationsSchema = z.object({ ordersWebhook: webhook, alertsWebhook: webhook });
export const settingsSchema = z.object({
  automatic: z.boolean(), realTrading: z.boolean(), notifications: notificationsSchema,
  language: z.enum(['zh-CN', 'en']).default('zh-CN'),
  // Retained only to read legacy settings; execution never falls back to this value.
  slippageBps: z.number().int().min(0).max(500).optional(),
  maxPriceAgeMs: z.number().int().min(3000).max(60000),
});
export type Position = z.infer<typeof positionSchema>;
export type Session = z.infer<typeof sessionSchema>;
export type Price = z.infer<typeof priceSchema>;
export type Draft = z.infer<typeof draftSchema>;
export type Settings = z.infer<typeof settingsSchema>;
export type Status = 'waiting' | 'ready' | 'auth-expired' | 'disconnected' | 'error';
export type Order = Draft & {
  id: string; accountId: string; quantity?: string; createdAt: number;
  status: 'waiting' | 'simulated' | 'cancelled' | 'blocked' | 'archived' | 'preparing' | 'signed' | 'submitted' | 'confirmed' | 'failed' | 'unknown'; reason?: string;
  legacy?: boolean; triggeredAt?: number;
  executedAt?: number; executionPrice?: string;
  attemptId?: string; transactionHash?: string; lastValidBlockHeight?: number; submittedAt?: number;
  confirmedAt?: number; fillQuantity?: string; fillUsd?: string; nextAttemptAt?: number;
  notifyOrder?: boolean; notificationHandled?: boolean;
  parentOrderId?: string; ocoGroupId?: string; remainingQuantity?: string;
  executionReference?: import('./execution').ExecutionReference;
};
export type Event = { id: string; orderId: string; at: number; message: string };
export type LogOrder = Pick<Order, 'kind' | 'status' | 'slippageBps' | 'targetPrice' | 'amountUsd' | 'quantity' | 'sellPercent' | 'createdAt' | 'triggeredAt' | 'submittedAt' | 'confirmedAt' | 'executionPrice' | 'fillQuantity' | 'fillUsd' | 'remainingQuantity' | 'transactionHash' | 'parentOrderId' | 'ocoGroupId' | 'protection' | 'reason'> & {
  asset: Pick<Asset, 'symbol' | 'tokenAddress' | 'networkId' | 'decimals'>;
  transactionNetworkId?: number; observedPrice?: string; mode?: 'live' | 'monitor';
};
export type Log = {
  id: string; at: number; category: 'operation' | 'trade' | 'system'; level: 'info' | 'warning' | 'error';
  code: string; message: string; accountId?: string; orderId?: string; symbol?: string;
  order?: LogOrder;
};
export const selectionSchema = z.object({ id: z.string().max(100), asset: assetSchema, priceUsd: numeric, at: z.number().finite() });
export type Selection = z.infer<typeof selectionSchema>;
export type View = {
  asset?: Asset; selection?: Selection; monitoring?: boolean;
  settings: Settings; session?: Session; price?: Price; status: Status; reason?: string;
  orders: Order[]; logs: Log[]; prices: Record<string, Price>; execution: { available: boolean; reason: string; networks: number[] };
};
export const EXECUTION = { available: false, networks: [] as number[], reason: '等待 FOMO 登录钱包就绪' };
export const DEFAULT_SETTINGS: Settings = { automatic: false, realTrading: false, language: 'zh-CN', notifications: { ordersWebhook: '', alertsWebhook: '' }, maxPriceAgeMs: 15000 };

export const commandSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('view') }),
  z.object({ type: z.literal('language'), language: z.enum(['zh-CN', 'en']) }),
  z.object({ type: z.literal('automatic'), enabled: z.boolean() }),
  z.object({ type: z.literal('create'), draft: draftSchema }),
  z.object({ type: z.literal('cancel'), id: z.string() }),
  z.object({ type: z.literal('real-trading'), enabled: z.boolean() }),
  z.object({ type: z.literal('notifications'), notifications: notificationsSchema }),
  z.object({ type: z.literal('refresh') }),
]);
export const feedSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('context'), asset: assetSchema.optional() }),
  z.object({ type: z.literal('selection'), selection: selectionSchema }),
  z.object({ type: z.literal('session'), session: sessionSchema }),
  z.object({ type: z.literal('price'), price: priceSchema }),
  z.object({ type: z.literal('health'), status: z.enum(['waiting', 'auth-expired', 'disconnected', 'error']), reason: z.string().max(200) }),
  z.object({ type: z.literal('heartbeat') }),
  z.object({ type: z.literal('api-error'), endpoint: z.enum(['metadata', 'balances', 'config']) }),
  z.object({ type: z.literal('execution'), accountId: z.string().min(1), available: z.boolean(), networks: z.array(z.number().int()).max(10), reason: z.string().max(200) }),
  z.object({ type: z.literal('execution-progress'), accountId: z.string().min(1), attemptId: z.string().uuid(),
    transactionHash: z.string().regex(/^(?:[1-9A-HJ-NP-Za-km-z]{64,88}|0x[0-9a-fA-F]{64})$/).optional(),
    userOperationHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/).optional() }),
]);
export type Feed = z.infer<typeof feedSchema>;
