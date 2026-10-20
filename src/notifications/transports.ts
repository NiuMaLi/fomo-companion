import type { NotificationTarget } from '../shared/notifications';

async function hmac(key: string, value: string) {
  const encoder = new TextEncoder();
  const signingKey = await crypto.subtle.importKey('raw', encoder.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = await crypto.subtle.sign('HMAC', signingKey, encoder.encode(value));
  return btoa(String.fromCharCode(...new Uint8Array(signature)));
}

export async function notificationRequest(target: NotificationTarget, text: string, now: number) {
  switch (target.provider) {
    case 'feishu': {
      const timestamp = String(Math.floor(now / 1000));
      return { url: target.webhook, body: { msg_type: 'text', content: { text },
        ...(target.secret ? { timestamp, sign: await hmac(`${timestamp}\n${target.secret}`, '') } : {}) } };
    }
    case 'dingtalk': {
      const url = new URL(target.webhook);
      if (target.secret) {
        const timestamp = String(now);
        url.searchParams.set('timestamp', timestamp);
        url.searchParams.set('sign', await hmac(target.secret, `${timestamp}\n${target.secret}`));
      }
      return { url: url.href, body: { msgtype: 'text', text: { content: text } } };
    }
    case 'wecom': return { url: target.webhook, body: { msgtype: 'text', text: { content: text } } };
    case 'telegram': return { url: `https://api.telegram.org/bot${target.botToken}/sendMessage`, body: { chat_id: target.chatId, text } };
    case 'disabled': throw new Error('disabled');
  }
}

export function notificationSucceeded(target: NotificationTarget, value: unknown) {
  if (!value || typeof value !== 'object') return false;
  const result = value as Record<string, unknown>;
  switch (target.provider) {
    case 'feishu': return (result.code ?? result.StatusCode) === 0;
    case 'dingtalk': case 'wecom': return result.errcode === 0;
    case 'telegram': return result.ok === true;
    case 'disabled': return false;
  }
}

class NotificationDeliveryError extends Error {}

// Share delivery and business-response validation between real notices and manual tests.
// Only allow safe, locally constructed errors to leave this function.
export async function deliverNotification(target: NotificationTarget, text: string, send: typeof fetch = fetch, now = Date.now()) {
  try {
    const { url, body } = await notificationRequest(target, text, now);
    const response = await send(url, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body), redirect: 'error', credentials: 'omit', signal: AbortSignal.timeout(8000) });
    if (!response.ok) throw new NotificationDeliveryError(`通知接口返回 HTTP ${response.status}，请检查机器人配置或网络`);
    const result: unknown = await response.json();
    if (!notificationSucceeded(target, result)) {
      const data = result && typeof result === 'object' ? result as Record<string, unknown> : {};
      const code = target.provider === 'feishu' ? data.code ?? data.StatusCode : target.provider === 'telegram' ? data.error_code : data.errcode;
      throw new NotificationDeliveryError(typeof code === 'number' && Number.isSafeInteger(code)
        ? `机器人拒绝通知（错误码 ${code}），请检查配置、权限或平台频率限制`
        : '机器人未确认接收通知，请检查配置或平台状态');
    }
  } catch (error) {
    if (error instanceof NotificationDeliveryError) throw error;
    throw new NotificationDeliveryError('通知发送失败或结果未知，请检查网络及机器人配置');
  }
}
