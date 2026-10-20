import { useRef, useState } from 'react';
import { emptyNotificationTarget, notificationEnabled, notificationTargetSchema, type NotificationProvider, type NotificationTarget } from '../shared/notifications';
import type { NotificationTestResult } from '../notifications/notify';
import { useLanguage } from './Language';

const providers: Record<NotificationProvider, string> = {
  disabled: '关闭通知', feishu: '飞书', dingtalk: '钉钉', wecom: '企业微信', telegram: 'Telegram',
};
const guideLinks = {
  feishu: 'https://open.feishu.cn/document/client-docs/bot-v3/add-custom-bot',
  dingtalk: 'https://open.dingtalk.com/document/robots/customize-robot-security-settings',
  wecom: 'https://developer.work.weixin.qq.com/document/path/91770',
  telegram: 'https://core.telegram.org/bots/features#botfather',
};

export function NotificationChannel({ channel, value, onChange, onTest, disabled = false }: {
  channel: 'orders' | 'alerts'; value: NotificationTarget; onChange: (value: NotificationTarget) => void;
  onTest: (target: NotificationTarget) => Promise<NotificationTestResult>; disabled?: boolean;
}) {
  const { t } = useLanguage();
  const id = `notification-${channel}`;
  const validation = notificationTargetSchema.safeParse(value);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<(NotificationTestResult & { config: string }) | undefined>();
  const inFlight = useRef(false);
  const config = JSON.stringify(value);
  const result = testResult?.config === config ? testResult : undefined;
  async function test() {
    if (inFlight.current || !validation.success || !notificationEnabled(validation.data)) return;
    inFlight.current = true; setTesting(true); setTestResult(undefined);
    try { setTestResult({ ...await onTest(validation.data), config }); }
    catch { setTestResult({ sent: false, message: '无法测试通知，请检查配置或重新打开扩展', config }); }
    finally { inFlight.current = false; setTesting(false); }
  }
  return <fieldset className="notification-channel" disabled={disabled || testing}>
    <legend>{t(channel === 'orders' ? '订单通知' : '告警通知')}</legend>
    <p className="subnote">{t(channel === 'orders' ? '订单确认成交后' : 'Token 失效 / 接口失败')}</p>
    <label className="field-label" htmlFor={`${id}-provider`}>{t('通知渠道')}</label>
    <select id={`${id}-provider`} value={value.provider} onChange={event => onChange(emptyNotificationTarget(event.target.value as NotificationProvider))}>
      {Object.entries(providers).map(([provider, label]) => <option key={provider} value={provider}>{t(label)}</option>)}
    </select>
    {value.provider !== 'disabled' && <>
      {value.provider === 'telegram' ? <>
        <label className="field-label" htmlFor={`${id}-token`}>Bot Token</label>
        <div className="size-input"><input id={`${id}-token`} type="password" autoComplete="off" spellCheck={false} value={value.botToken}
          onChange={event => onChange({ ...value, botToken: event.target.value })}/></div>
        <label className="field-label" htmlFor={`${id}-chat`}>Chat ID</label>
        <div className="size-input"><input id={`${id}-chat`} type="text" autoComplete="off" spellCheck={false} value={value.chatId}
          placeholder={t('数字 ID 或 @频道用户名')} onChange={event => onChange({ ...value, chatId: event.target.value })}/></div>
      </> : <>
        <label className="field-label" htmlFor={`${id}-webhook`}>Webhook</label>
        <div className="size-input"><input id={`${id}-webhook`} type="password" autoComplete="off" spellCheck={false} value={value.webhook}
          placeholder={t('留空关闭此类通知')} onChange={event => onChange({ ...value, webhook: event.target.value })}/></div>
        {(value.provider === 'feishu' || value.provider === 'dingtalk') && <>
          <label className="field-label" htmlFor={`${id}-secret`}>{t('加签密钥')}<span>{t('可选')}</span></label>
          <div className="size-input"><input id={`${id}-secret`} type="password" autoComplete="off" spellCheck={false} value={value.secret}
            placeholder={t('机器人启用加签时填写')} onChange={event => onChange({ ...value, secret: event.target.value })}/></div>
        </>}
      </>}
      <button className="secondary" type="button" aria-busy={testing}
        aria-label={t(channel === 'orders' ? '发送订单测试通知' : '发送告警测试通知')}
        disabled={testing || !validation.success || !notificationEnabled(validation.data)} onClick={() => void test()}>
        {t(testing ? '正在发送测试通知…' : '发送测试通知')}
      </button>
      <p className="subnote notification-test-note">{t('测试当前输入，无需先保存；测试成功后仍需保存配置。')}</p>
      {result && <p className={`subnote notification-test-result ${result.sent ? 'positive' : 'negative'}`} role={result.sent ? 'status' : 'alert'}>{t(result.message)}</p>}
      <details className="notification-guide" key={value.provider}>
        <summary>{t('配置教程')} · {t(providers[value.provider])}</summary>
        <ol>
          {value.provider === 'feishu' && <>
            <li>{t('在飞书群设置中添加自定义机器人，复制 Webhook 到上方。')}</li>
            <li>{t('若启用签名校验，填写对应密钥；若使用关键词，添加 FOMO。')}</li>
          </>}
          {value.provider === 'dingtalk' && <>
            <li>{t('在钉钉群的机器人管理中添加自定义机器人，复制完整 Webhook（含 access_token）。')}</li>
            <li>{t('安全设置可使用加签并填写 SEC 开头的密钥，或将自定义关键词设为 FOMO。')}</li>
          </>}
          {value.provider === 'wecom' && <>
            <li>{t('在企业微信群中添加群机器人，复制完整 Webhook（含 key）。')}</li>
            <li>{t('选择企业微信并粘贴地址，无需企业应用的 Corp ID 或 Secret。')}</li>
          </>}
          {value.provider === 'telegram' && <>
            <li>{t('在 Telegram 找到官方 @BotFather，使用 /newbot 创建机器人并取得 Bot Token。')}</li>
            <li>{t('私聊先向机器人发送 /start；群聊先添加机器人；频道需授予机器人发消息权限。')}</li>
            <li>{t('从 getUpdates 的 message.chat.id 获取 Chat ID（群组通常为负数）；公开频道也可填写 @频道用户名。')}</li>
            <li>{t('若 getUpdates 无结果，先发送新消息；若已设置 webhook，需用现有集成获取 Chat ID。')}</li>
          </>}
          <li>{t('保存通知配置后生效；订单与告警分别配置，未配置不发送。')}</li>
        </ol>
        <a href={guideLinks[value.provider]} target="_blank" rel="noreferrer">{t('官方配置文档')}</a>
      </details>
    </>}
    {!validation.success && <p className="subnote negative" role="alert">{t(validation.error.issues[0]?.message ?? '请检查通知渠道配置')}</p>}
  </fieldset>;
}
