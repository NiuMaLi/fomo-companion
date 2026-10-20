import Decimal from 'decimal.js';
import { assetKey, type Price } from '../shared/model';
import { ExecutionError, SOLANA_NETWORK, USDC_ADDRESS, NATIVE_SOL_ADDRESS, executionRequestSchema, type ExecutionRequest, type ExecutionResult } from '../shared/execution';
import { FOMO_CHAINS, SUPPORTED_CHAINS_HEADER } from '../shared/chains';
import { fresh, triggered } from './engine';
import { findEvmWallet, findWallet } from './wallet';
import { attachFeeSignature, fromBase64, toBase64, transaction, base58, equalBytes, verifySignedTransaction } from './solana-transaction';
import { parseQuote, parseRoutedQuote, quoteRequest, type Prepare } from './quote';
import { parseReceipt } from './receipt';
import { executeNative, loadNativeModule, nativeRoute, type NativeRoute } from './native-runtime';
import { routedReceipt } from './routed-receipt';

type Attempt = { request: Prepare; unsigned?: Uint8Array; signed?: Uint8Array; quote: { priceUsd: string; quantity: string; amountUsd: string; lastValidBlockHeight?: number }; route?: NativeRoute; createdAt: number; revoked: boolean; submitted: boolean; signing: boolean };
export function createPageExecutor(options: {
  fetch: typeof fetch; json: typeof Response.prototype.json; token: () => string | undefined;
  account: () => string | undefined; price: (key: string) => Price | undefined;
  refresh: () => Promise<void>; onAuthFailure: () => void;
  progress?: (accountId: string, attemptId: string, update: { transactionHash?: string; userOperationHash?: string }) => void;
}) {
  const attempts = new Map<string, Attempt>();
  let generation = 0;
  const requestJson = async (url: string, init: RequestInit = {}, authenticated = false) => {
    const external = new URL(url).origin !== 'https://prod-api.fomo.family' && !new URL(url).hostname.endsWith('.prod-edge.fomo.family');
    const headers = new Headers(init.headers);
    if (!external) headers.set('Content-Type', 'application/json');
    if (authenticated) {
      const token = options.token();
      if (!token) { options.onAuthFailure(); throw new ExecutionError('auth', '登录凭据失效，请回到 FOMO 检查登录状态'); }
      headers.set('Authorization', `Bearer ${token}`);
    } else if (!external) headers.set('X-Supported-Chains', SUPPORTED_CHAINS_HEADER);
    let response: Response;
    try { response = await options.fetch(url, { ...init, headers, credentials: authenticated || external ? 'omit' : 'include', signal: AbortSignal.timeout(12000) }); }
    catch { throw new ExecutionError('network', '交易接口请求超时或失败', true); }
    if (response.status === 401 || response.status === 403) { options.onAuthFailure(); throw new ExecutionError('auth', '交易接口登录校验失败'); }
    let body: any;
    try { body = await options.json.call(response); } catch { throw new ExecutionError('response', '交易接口返回了无法解析的数据', true); }
    if (!response.ok && !body?.errorCode) throw new ExecutionError('network', '交易接口调用失败', true);
    return body;
  };
  const rpc = async (method: 'getBlockHeight' | 'simulateTransaction' | 'sendTransaction' | 'getSignatureStatuses' | 'getTransaction' | 'getTokenAccountsByOwner' | 'getBalance', params: unknown[]) => {
    const result = await requestJson('https://solana-provider-1.prod-edge.fomo.family', { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) }, true);
    if (result.error) throw new ExecutionError(method === 'sendTransaction' ? 'submission' : 'rpc', method === 'sendTransaction' ? '交易提交未确认，请等待链上核对' : '链上状态查询失败', true);
    return result.result;
  };
  const walletFor = (accountId: string) => {
    if (options.account() !== accountId) throw new ExecutionError('account', '账户已切换，已停止执行');
    const wallet = findWallet(accountId);
    if (!wallet) throw new ExecutionError('wallet', '当前钱包尚未就绪或签名接口已变化');
    return wallet;
  };
  const check = (attempt: Attempt) => {
    if (attempt.revoked) throw new ExecutionError('revoked', '真实下单已关闭或执行已撤销');
    const price = options.price(assetKey(attempt.request.order.asset));
    if (!fresh(price, Date.now(), attempt.request.maxPriceAgeMs) || !triggered(attempt.request.order, price.priceUsd)) throw new ExecutionError('price', '行情已过期或已离开触发区间', true);
    if (Date.now() - attempt.createdAt > 30000) throw new ExecutionError('expired', '报价已过期，未提交交易');
    return walletFor(attempt.request.order.accountId);
  };
  const capability = () => {
    const accountId = options.account(), solana = accountId ? findWallet(accountId) : undefined, evm = accountId ? findEvmWallet(accountId) : undefined;
    return { accountId: accountId ?? '', available: !!(solana || evm), networks: Object.values(FOMO_CHAINS),
      reason: solana || evm ? '按 FOMO 原生路线执行各网络币对；钱包可能要求确认签名' : '等待 FOMO 登录钱包就绪' };
  };
  const checkNative = (attempt: Attempt) => {
    if (attempt.revoked || options.account() !== attempt.request.order.accountId) throw new ExecutionError('revoked', '执行已暂停或账户已切换');
    const price = options.price(assetKey(attempt.request.order.asset));
    if (!fresh(price, Date.now(), attempt.request.maxPriceAgeMs) || !triggered(attempt.request.order, price.priceUsd)) throw new ExecutionError('price', '行情已过期或已离开触发区间');
    if (Date.now() - attempt.createdAt > 30000) throw new ExecutionError('expired', '报价已过期，未提交交易');
  };
  async function execute(raw: unknown): Promise<ExecutionResult> {
    const request: ExecutionRequest = executionRequestSchema.parse(raw);
    if (request.action === 'revoke') {
      generation++;
      for (const attempt of attempts.values()) attempt.revoked = true;
      return { state: 'revoked' };
    }
    if (request.action === 'receipt') {
      if (request.reference) return routedReceipt(request, { json: requestJson, account: options.account, direct: execute });
      if (!request.transactionHash) throw new ExecutionError('receipt', '缺少成交核对标识');
      const wallet = walletFor(request.accountId);
      const status = (await rpc('getSignatureStatuses', [[request.transactionHash], { searchTransactionHistory: true }]))?.value?.[0];
      if (status?.err) return { state: 'failed', transactionHash: request.transactionHash, message: '链上交易执行失败' };
      if (status?.confirmationStatus !== 'confirmed' && status?.confirmationStatus !== 'finalized') return { state: 'pending' };
      const details = await rpc('getTransaction', [request.transactionHash, { encoding: 'jsonParsed', commitment: 'confirmed', maxSupportedTransactionVersion: 1 }]);
      const receipt = parseReceipt(details, wallet.address, request.asset);
      if (receipt.state === 'confirmed') {
        // A transaction's postTokenBalances only covers participating accounts. Read all
        // owner accounts at a slot no earlier than this fill for the remaining position.
        receipt.remainingQuantity = undefined;
        try {
          const config = { commitment: 'confirmed', minContextSlot: details.slot };
          const accounts = await rpc('getTokenAccountsByOwner', [wallet.address, { mint: request.asset.tokenAddress }, { ...config, encoding: 'jsonParsed' }]);
          if (!Array.isArray(accounts?.value)) throw new Error('Missing token accounts');
          let remaining = accounts.value.reduce((sum: Decimal, item: any) => {
            const token = item.account.data.parsed.info.tokenAmount;
            return sum.plus(new Decimal(String(token.amount)).div(new Decimal(10).pow(token.decimals)));
          }, new Decimal(0));
          if (request.asset.tokenAddress === NATIVE_SOL_ADDRESS) {
            const native = await rpc('getBalance', [wallet.address, config]);
            if (native?.value === undefined) throw new Error('Missing native balance');
            remaining = remaining.plus(new Decimal(String(native.value)).div(1e9));
          }
          receipt.remainingQuantity = remaining.toFixed();
        } catch { /* A balance lookup failure does not erase a proven fill or invent a zero. */ }
        void options.refresh().catch(() => {});
      }
      return { ...receipt, transactionHash: request.transactionHash };
    }
    if (request.action === 'prepare') {
      const started = generation;
      if (attempts.has(request.attemptId)) throw new ExecutionError('duplicate', '执行标识已使用');
      if (options.account() !== request.order.accountId) throw new ExecutionError('account', '账户已切换，已停止执行');
      const body = quoteRequest(request), price = options.price(assetKey(request.order.asset));
      if (!fresh(price, Date.now(), request.maxPriceAgeMs) || !triggered(request.order, price.priceUsd)) throw new ExecutionError('price', '等待新鲜行情达到目标价格', true);
      const balance = await requestJson(`https://prod-api.fomo.family/v2/users/${encodeURIComponent(request.order.accountId)}/balances`);
      if (!balance?.success || !Array.isArray(balance.responseObject?.balances)) throw new ExecutionError('balance', '无法校验当前可用余额', true);
      const available = balance.responseObject.balances.reduce((total: Decimal, entry: any) => {
        const token = entry.tokenFilterResult?.token;
        const address = request.order.kind === 'limit-buy' ? USDC_ADDRESS : request.order.asset.tokenAddress;
        const sameAddress = address.startsWith('0x') ? String(token?.address).toLowerCase() === address.toLowerCase() : token?.address === address;
        return token?.networkId === (request.order.kind === 'limit-buy' ? SOLANA_NETWORK : request.order.asset.networkId) && sameAddress ? total.plus(String(entry.balance?.shiftedBalance ?? entry.userToken?.humanAmountRemaining ?? '0')) : total;
      }, new Decimal(0));
      const needed = new Decimal((request.order.kind === 'limit-buy' ? request.order.amountUsd : request.order.quantity) ?? '0');
      if (needed.gt(available)) throw new ExecutionError('balance', '真实可用余额不足，已阻止交易');
      const response = await requestJson('https://prod-api.fomo.family/swaps/v3', { method: 'POST', body: JSON.stringify(body) });
      const direct = response?.responseObject?.source === 'solana' && !response.responseObject.v1Swap?.jitoTipTx && request.order.asset.networkId === SOLANA_NETWORK;
      if (!direct && response?.success) {
        const quote = parseRoutedQuote(response, request, price.priceUsd);
        const route = nativeRoute(quote.payload, body.inTokenId, body.outTokenId, response.xRequestId);
        if (route.originChainType === 'EVM' ? !findEvmWallet(request.order.accountId) : !findWallet(request.order.accountId)) throw new ExecutionError('wallet', '交易来源网络的钱包尚未就绪');
        await loadNativeModule(route.originChainType === 'EVM' ? 'AccountProvider' : 'swaps');
        if (started !== generation) throw new ExecutionError('revoked', '准备期间已暂停，未继续执行');
        const attempt: Attempt = { request, route, quote, createdAt: Date.now(), revoked: false, submitted: false, signing: false };
        attempts.set(request.attemptId, attempt);
        return { state: 'prepared', native: true, reference: route.reference, priceUsd: quote.priceUsd, quantity: quote.quantity, amountUsd: quote.amountUsd };
      }
      const quote = parseQuote(response, request, price.priceUsd);
      let unsigned: Uint8Array;
      try { unsigned = attachFeeSignature(fromBase64(quote.transaction), quote.feePayerAddress, fromBase64(quote.feePayerSignature)); }
      catch { throw new ExecutionError('transaction', '报价交易编码或代付签名不符合支持格式，未签名'); }
      const wallet = walletFor(request.order.accountId);
      if (!transaction(unsigned).signers.some(key => base58(key) === wallet.address)) throw new ExecutionError('signer', '报价签名账户不匹配');
      const simulation = await rpc('simulateTransaction', [toBase64(unsigned), { encoding: 'base64', sigVerify: false, commitment: 'confirmed' }]);
      if (!simulation?.value || simulation.value.err) throw new ExecutionError('preflight', '交易预检未通过，未请求签名', true);
      if (started !== generation) throw new ExecutionError('revoked', '准备期间已暂停，未继续执行');
      const attempt: Attempt = { request, unsigned, quote, createdAt: Date.now(), revoked: false, submitted: false, signing: false };
      for (const [id, old] of attempts) if (Date.now() - old.createdAt > 180000) attempts.delete(id);
      attempts.set(request.attemptId, attempt);
      return { state: 'prepared', priceUsd: quote.priceUsd, quantity: quote.quantity, amountUsd: quote.amountUsd, lastValidBlockHeight: quote.lastValidBlockHeight };
    }
    const attempt = attempts.get(request.attemptId);
    if (!attempt) throw new ExecutionError('attempt', '执行上下文已失效，未重新提交');
    if (request.action === 'execute-native') {
      if (!attempt.route || attempt.submitted) throw new ExecutionError('duplicate', '多链执行上下文失效或已经使用，禁止重复提交');
      checkNative(attempt); attempt.submitted = true;
      return executeNative(attempt.route, { solana: findWallet(attempt.request.order.accountId), evm: findEvmWallet(attempt.request.order.accountId) },
        () => checkNative(attempt), update => options.progress?.(attempt.request.order.accountId, request.attemptId, update));
    }
    if (!attempt.unsigned) throw new ExecutionError('attempt', '交易需要按平台多链流程执行');
    if (request.action === 'sign') {
      if (attempt.signed || attempt.submitted || attempt.signing) throw new ExecutionError('duplicate', '该交易已签名，禁止重复签名');
      attempt.signing = true;
      const wallet = check(attempt);
      if (Number(await rpc('getBlockHeight', [{ commitment: 'confirmed' }])) + 5 >= attempt.quote.lastValidBlockHeight!) throw new ExecutionError('expired', '交易区块有效期不足，未签名');
      check(attempt);
      let signed: Uint8Array;
      try {
        const tx = transaction(attempt.unsigned), result = await wallet.signMessage({ message: tx.message });
        if (!(result.signature instanceof Uint8Array) || result.signature.length !== 64 || !equalBytes(result.signedMessage, tx.message)) throw new Error('Unexpected signature');
        signed = attachFeeSignature(attempt.unsigned, wallet.address, result.signature);
      }
      catch { throw new ExecutionError('signature', '钱包未完成签名，未提交交易'); }
      check(attempt);
      const transactionHash = await verifySignedTransaction(attempt.unsigned, signed, wallet.publicKey);
      attempt.signed = signed;
      return { state: 'signed', transactionHash, lastValidBlockHeight: attempt.quote.lastValidBlockHeight };
    }
    check(attempt);
    if (!attempt.signed || request.transactionHash !== base58(transaction(attempt.signed).signatures[0]!) || attempt.submitted) throw new ExecutionError('submission', '签名哈希不匹配或已经提交，禁止重复提交');
    if (Number(await rpc('getBlockHeight', [{ commitment: 'confirmed' }])) + 2 >= attempt.quote.lastValidBlockHeight!) throw new ExecutionError('expired', '交易区块有效期不足，未提交');
    check(attempt);
    // The background must persist this hash before issuing the submit command.
    attempt.submitted = true;
    try {
      const hash = await rpc('sendTransaction', [toBase64(attempt.signed), { encoding: 'base64', skipPreflight: false, preflightCommitment: 'confirmed', maxRetries: 2 }]);
      if (hash !== request.transactionHash) return { state: 'unknown', transactionHash: request.transactionHash, message: '提交结果与签名不一致，等待链上核对' };
      void options.refresh();
      return { state: 'submitted', transactionHash: hash };
    } catch { return { state: 'unknown', transactionHash: request.transactionHash, message: '交易提交结果未知，等待链上核对；不会重新下单' }; }
  }
  return { execute, capability };
}
