import { BRIDGE, feedSchema } from '../src/shared/model';
import { executionRequestSchema, executionResultSchema } from '../src/shared/execution';

export default defineContentScript({
  matches: ['https://fomo.family/*'], runAt: 'document_start',
  main(ctx) {
    const pending = new Map<string, { reply: (data: unknown) => void; timer: ReturnType<typeof setTimeout> }>();
    ctx.addEventListener(window, 'message', event => {
      if (event.source !== window || event.origin !== 'https://fomo.family' || event.data?.source !== BRIDGE) return;
      if (event.data.type === 'execution-response' && ctx.isValid) {
        const entry = pending.get(event.data.requestId);
        if (!entry) return;
        pending.delete(event.data.requestId); clearTimeout(entry.timer);
        const parsed = executionResultSchema.safeParse(event.data.result);
        entry.reply(event.data.ok && parsed.success ? { ok: true, result: parsed.data } : { ok: false,
          code: typeof event.data.code === 'string' ? event.data.code.slice(0, 40) : 'execution',
          message: typeof event.data.message === 'string' ? event.data.message.slice(0, 200) : '执行未完成', retryable: event.data.retryable === true });
        return;
      }
      const parsed = feedSchema.safeParse(event.data);
      if (!parsed.success || !ctx.isValid) return;
      // Updating the extension may invalidate the context before sendMessage
      // returns a promise. Also handle this synchronous failure on old pages.
      try { void browser.runtime.sendMessage({ channel: 'feed', data: parsed.data }).catch(() => {}); }
      catch { /* The panel refresh action will reconnect the page. */ }
    });
    browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (!ctx.isValid || sender.id !== browser.runtime.id) return;
      if (message?.type === 'execute') {
        const parsed = executionRequestSchema.safeParse(message.request);
        if (!parsed.success) { sendResponse({ ok: false, message: '执行请求无效' }); return; }
        const requestId = crypto.randomUUID();
        const timer = setTimeout(() => { pending.delete(requestId); sendResponse({ ok: false, code: 'timeout', message: '页面执行回复超时，等待核对执行状态' }); }, 60000);
        pending.set(requestId, { reply: sendResponse, timer });
        window.postMessage({ source: `${BRIDGE}:request`, type: 'execute', requestId, request: parsed.data }, location.origin);
        return true;
      }
      if (message?.type === 'refresh-feed') {
        window.postMessage({ source: `${BRIDGE}:request`, type: 'refresh' }, location.origin);
        sendResponse({ ok: true });
      }
      if (message?.type === 'subscriptions') {
        window.postMessage({ source: `${BRIDGE}:request`, type: 'subscriptions', assets: message.assets }, location.origin);
        sendResponse({ ok: true });
      }
    });
  },
});
