import { ExecutionError, SOLANA_NETWORK, type ExecutionReference } from '../shared/execution';
import type { EvmWallet, FomoWallet } from './wallet';

export type NativeRoute = {
  source: 'solana' | 'relay' | 'mobula'; originChainType: 'SOLANA' | 'EVM'; raw: any;
  reference: ExecutionReference; xRequestId?: string;
};
type NativeModule = Record<string, any>;
const modules = new Map<string, Promise<NativeModule>>();

// Invoke the same application modules already used by FOMO's own wallet. Discover
// current asset URLs from the page; never pin a deployment hash or copy credentials.
export async function loadNativeModule(name: 'AccountProvider' | 'swaps') {
  const cached = modules.get(name); if (cached) return cached;
  const load = async () => {
    const entries = [...performance.getEntriesByType('resource').map(p => p.name),
      ...Array.from(document.querySelectorAll<HTMLScriptElement>('script[src]')).map(p => p.src),
      ...Array.from(document.querySelectorAll<HTMLLinkElement>('link[rel="modulepreload"]')).map(p => p.href)];
    const safe = (value: string) => { try { const u = new URL(value, location.href); return u.origin === location.origin && /^\/assets\/[^/]+\.js$/.test(u.pathname) ? u.href : undefined; } catch { return; } };
    const urls = [...new Set(entries.map(safe).filter((v): v is string => !!v))];
    const matches = (url: string) => new URL(url).pathname.split('/').at(-1)!.startsWith(name + '-');
    let url = urls.find(matches);
    if (!url) {
      for (const entry of urls.filter(u => /tokenWarnings|manifest|root|index-/.test(u)).slice(0, 24)) {
        const response = await fetch(entry, { credentials: 'same-origin', signal: AbortSignal.timeout(8000) });
        if (!response.ok) continue;
        const source = await response.text();
        const pattern = new RegExp('(?:\\./|/assets/)' + name + '-[^"\'`\\\\<>]+\\.js', 'g');
        const match = source.match(pattern)?.[0];
        if (match) { url = safe(new URL(match, entry).href); if (url) break; }
      }
    }
    if (!url) throw new ExecutionError('runtime', 'FOMO 交易模块尚未加载，请刷新页面');
    return await import(/* @vite-ignore */ url) as NativeModule;
  };
  const promise = load().catch(error => { modules.delete(name); throw error; }); modules.set(name, promise); return promise;
}

export function nativeRoute(payload: any, inTokenId: string, outTokenId: string, xRequestId?: string): NativeRoute {
  const raw = payload.source === 'relay' ? payload.v2Swap : payload.source === 'mobula' ? payload.mobulaSwap : payload.v1Swap;
  const deposit = payload.source === 'relay' ? raw?.relayTransaction : payload.source === 'mobula' ? raw?.deposit : undefined;
  const origin = payload.originChainType === 'SOLANA' ? SOLANA_NETWORK : Number(deposit?.depositTransaction?.chainId ?? raw?.networkId ?? raw?.originChainId);
  if (!raw || !Number.isSafeInteger(origin) || origin <= 0) throw new ExecutionError('route', '平台交易来源网络无效');
  if (payload.source === 'relay' && !raw.relaySwapId || payload.source === 'mobula' && !raw.intentId) throw new ExecutionError('route', '缺少可恢复的平台交易标识');
  return { source: payload.source, originChainType: payload.originChainType, raw, xRequestId,
    reference: { source: payload.source, originNetworkId: origin, inTokenId, outTokenId, startedAt: Date.now(),
      ...(raw.relaySwapId ? { relaySwapId: String(raw.relaySwapId) } : {}), ...(raw.intentId ? { intentId: String(raw.intentId) } : {}) } };
}

export function evmCalls(route: NativeRoute) {
  const raw = route.raw;
  if (Array.isArray(raw.calls)) {
    if (!raw.calls.length || Number(raw.networkId) !== route.reference.originNetworkId || BigInt(raw.callGasLimit ?? 0) <= 0n) throw new ExecutionError('route', '平台 EVM 调用网络或 Gas 无效');
    return { calls: raw.calls.map((call: any) => {
      if (!/^0x[0-9a-fA-F]{40}$/.test(call.to) || !/^0x(?:[0-9a-fA-F]{2})*$/.test(call.data ?? '0x') || BigInt(call.value ?? 0) < 0n) throw new ExecutionError('route', '平台 EVM 调用格式无效');
      return { to: call.to, data: call.data ?? '0x', value: BigInt(call.value ?? 0) };
    }), gas: BigInt(raw.callGasLimit) };
  }
  const deposit = route.source === 'relay' ? raw.relayTransaction : raw.deposit;
  if (deposit?.type !== 'EVM' || !deposit.depositTransaction) throw new ExecutionError('route', '缺少平台 EVM 交易调用');
  const entries = [...(deposit.preTransactions ?? []), ...(deposit.approvalTransaction ? [deposit.approvalTransaction] : []), deposit.depositTransaction, ...(deposit.postTransactions ?? [])];
  let gas = 0n;
  const calls = entries.map((tx: any) => {
    if (Number(tx.chainId) !== route.reference.originNetworkId || !/^0x[0-9a-fA-F]{40}$/.test(tx.to) || !/^0x(?:[0-9a-fA-F]{2})*$/.test(tx.data ?? '0x') || BigInt(tx.value ?? 0) < 0n) throw new ExecutionError('route', '平台批量交易网络或调用格式不匹配');
    if (tx.gas === undefined || BigInt(tx.gas) <= 0n) throw new ExecutionError('route', '平台未返回有效的 EVM 调用 Gas');
    gas += BigInt(tx.gas);
    return { to: tx.to, data: tx.data ?? '0x', value: BigInt(tx.value ?? '0') };
  });
  return { calls, gas: gas * 3n / 2n };
}

export async function executeNative(route: NativeRoute, wallets: { solana?: FomoWallet; evm?: EvmWallet }, check: () => void,
  progress: (update: { transactionHash?: string; userOperationHash?: string }) => void,
  load: typeof loadNativeModule = loadNativeModule) {
  let attempted = false, hash: string | undefined;
  const logEvent = (_name: string, data: any) => {
    const uo = data?.uoHash ?? data?.userOpHash;
    if (typeof uo === 'string' && /^0x[0-9a-fA-F]{64}$/.test(uo)) { route.reference.userOperationHash = uo; progress({ userOperationHash: uo }); }
    if (typeof data?.txHash === 'string' && /^(0x[0-9a-fA-F]{64}|[1-9A-HJ-NP-Za-km-z]{64,88})$/.test(data.txHash)) { hash = data.txHash; progress({ transactionHash: hash }); }
  };
  try {
    if (route.originChainType === 'EVM') {
      if (!wallets.evm) throw new ExecutionError('wallet', '等待当前账户 EVM 钱包就绪');
      const module = await load('AccountProvider');
      // These exports have been checked against both current deployments. If their
      // behavior changes, stop before obtaining a provider or requesting a signature.
      const execute = module.ar;
      if (typeof execute !== 'function' || !String(execute).includes('sendUserOperation') || !String(execute).includes('waitForUserOperationReceipt')) throw new ExecutionError('runtime', 'FOMO 多链执行接口已变化，请更新插件');
      const { calls, gas } = evmCalls(route), wallet = wallets.evm;
      const guarded: EvmWallet = { address: wallet.address, getEthereumProvider: async () => {
        check(); const provider = await wallet.getEthereumProvider(); check();
        return { request: async req => { check(); const result = await provider.request(req); check(); return result; } };
      } };
      check();
      const result = await execute({ uos: calls, gasLimit: gas, chainId: route.reference.originNetworkId, wallet: guarded,
        logEvent, executionContext: route.raw.executionContext, isBundlerSweep: route.raw.useSweepBundler ?? false,
        onSubmissionAttempted: () => { check(); attempted = true; } });
      logEvent('result', result);
      if (result.receipt?.success === false) return { state: 'failed' as const, transactionHash: hash, reference: route.reference, submissionAttempted: true, message: '链上智能账户交易执行失败' };
      return { state: 'submitted' as const, transactionHash: hash, reference: route.reference, submissionAttempted: true };
    }
    if (!wallets.solana) throw new ExecutionError('wallet', '等待当前账户 Solana 钱包就绪');
    const module = await load('swaps');
    const api = Object.values(module).find(value => value && typeof value.signAndSendTransaction === 'function');
    if (!api) throw new ExecutionError('runtime', 'FOMO Solana 交易模块接口已变化');
    const raw = route.raw, deposit = route.source === 'relay' ? raw.relayTransaction : raw.deposit;
    const tx = route.source === 'solana' ? { ...raw, tx: raw.swapTransaction } : { ...deposit, tx: deposit?.tx };
    if (typeof tx.tx !== 'string' || typeof tx.feePayerSignature !== 'string') throw new ExecutionError('route', '平台未返回 Solana 签名交易');
    const wallet = wallets.solana;
    const guarded: FomoWallet = { ...wallet, signMessage: async input => { check(); const result = await wallet.signMessage(input); check(); attempted = true; return result; } };
    if (typeof module.u !== 'function' || !/^function\s*\w*\(\)\s*\{\s*return\s+\w+;?\s*\}$/.test(String(module.u))) throw new ExecutionError('runtime', 'FOMO 区块高度接口已变化');
    const blockRef = module.u();
    if (!blockRef || !Number.isFinite(blockRef.current)) throw new ExecutionError('runtime', 'FOMO 区块高度尚未就绪');
    check();
    const result = await api.signAndSendTransaction(wallet.address, { ...tx, xRequestId: route.xRequestId ?? '', timestamp: Date.now() }, guarded,
      blockRef, logEvent, false, { onSubmitted: (transactionHash: string) => { hash = transactionHash; progress({ transactionHash }); } });
    if (result.txHash) { hash = result.txHash; progress({ transactionHash: hash }); }
    return { state: result.success || attempted ? 'submitted' as const : 'failed' as const, transactionHash: hash, reference: route.reference, submissionAttempted: attempted,
      message: result.success ? undefined : attempted ? '平台执行结果待核对，不会重复提交' : '钱包签名或交易准备未完成，未提交交易' };
  } catch (error) {
    return { state: attempted ? 'unknown' as const : 'failed' as const, transactionHash: hash, reference: route.reference, submissionAttempted: attempted,
      message: attempted ? '多链提交结果待核对，不会重复下单' : error instanceof ExecutionError ? error.message : '多链交易准备或签名未完成，未提交交易' };
  }
}

export const EVM_RPC_NAMES: Record<number, string> = { 1: 'eth-mainnet', 56: 'bnb-mainnet', 143: 'monad-mainnet', 8453: 'base-mainnet', 4663: 'robinhood-mainnet', 5042: 'arc-mainnet' };
export const rpcUrl = (network: number) => EVM_RPC_NAMES[network] ? `https://evm-data.prod-edge.fomo.family/${EVM_RPC_NAMES[network]}/v2` : undefined;
