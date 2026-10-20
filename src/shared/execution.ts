import { z } from 'zod';
import { assetSchema } from './model';

export const SOLANA_NETWORK = 1399811149;
export const USDC_ADDRESS = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
export const NATIVE_SOL_ADDRESS = 'So11111111111111111111111111111111111111112';
export const USDC_ID = `${USDC_ADDRESS}:${SOLANA_NETWORK}`;
const decimal = z.string().regex(/^\d+(\.\d+)?$/).max(100);
export const transactionHashSchema = z.string().regex(/^(?:[1-9A-HJ-NP-Za-km-z]{64,88}|0x[0-9a-fA-F]{64})$/);
const transactionHash = transactionHashSchema;
export const executionReferenceSchema = z.object({
  source: z.enum(['solana', 'relay', 'mobula']), originNetworkId: z.number().int(),
  relaySwapId: z.string().min(1).max(200).optional(), userOperationHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/).optional(),
  intentId: z.string().min(1).max(200).optional(),
  inTokenId: z.string().min(1).max(250), outTokenId: z.string().min(1).max(250), startedAt: z.number().finite(),
});
export type ExecutionReference = z.infer<typeof executionReferenceSchema>;
const identity = { attemptId: z.string().uuid() };
export const executionRequestSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('prepare'), ...identity, order: z.object({ id: z.string(), accountId: z.string(), asset: assetSchema,
    kind: z.enum(['limit-buy', 'limit-sell', 'take-profit', 'stop-loss']), targetPrice: decimal, amountUsd: decimal.optional(), quantity: decimal.optional() }),
    slippageBps: z.number().int().min(0).max(500).optional(), maxPriceAgeMs: z.number().int().min(3000).max(60000) }),
  z.object({ action: z.literal('sign'), ...identity }),
  z.object({ action: z.literal('execute-native'), ...identity }),
  z.object({ action: z.literal('submit'), ...identity, transactionHash: transactionHash }),
  z.object({ action: z.literal('receipt'), accountId: z.string(), asset: assetSchema, transactionHash: transactionHash.optional(),
    reference: executionReferenceSchema.optional(), quantity: decimal.optional(), amountUsd: decimal.optional(), kind: z.enum(['limit-buy', 'limit-sell', 'take-profit', 'stop-loss']).optional() }),
  z.object({ action: z.literal('revoke') }),
]);
export type ExecutionRequest = z.infer<typeof executionRequestSchema>;
export const executionResultSchema = z.object({
  state: z.enum(['prepared', 'signed', 'submitted', 'pending', 'confirmed', 'failed', 'unknown', 'revoked']),
  transactionHash: transactionHash.optional(), lastValidBlockHeight: z.number().int().optional(),
  priceUsd: decimal.optional(), quantity: decimal.optional(), amountUsd: decimal.optional(), message: z.string().max(200).optional(),
  direction: z.enum(['buy', 'sell']).optional(), remainingQuantity: decimal.optional(),
  native: z.boolean().optional(), reference: executionReferenceSchema.optional(),
  submissionAttempted: z.boolean().optional(),
});
export type ExecutionResult = z.infer<typeof executionResultSchema>;
export class ExecutionError extends Error {
  constructor(public code: string, message: string, public retryable = false) { super(message); }
}
