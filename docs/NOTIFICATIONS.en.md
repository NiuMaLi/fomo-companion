# Bot notification setup

[简体中文](NOTIFICATIONS.md) | **English**

Open **Settings → Notifications** in the extension side panel. Select a platform and save credentials separately for order notifications and alerts. Each can use Feishu, DingTalk, WeCom, or Telegram, with either the same bot or different bots and platforms.

## Notification rules

| Type | Trigger | Content |
| --- | --- | --- |
| Orders | Successfully reconciled real fill | Pair, side, actual fill price, quantity, USDC value, remaining position at reconciliation, order ID, transaction hash, and confirmation time |
| Alerts | Existing system issues, such as expired login credentials or failed API calls | Issue description and time; alerts of the same type have a five-minute cooldown |

Price triggers, quotes, and transaction submissions do not produce fill notifications. Order deduplication survives concurrent calls and background restarts. Changing platforms does not resend an already handled fill. Unconfigured notifications are not queued for later delivery, and orders and alerts do not fall back to each other.

Select **Disabled** and save to disable a notification type. Alternatively, clear its webhook; for Telegram, clear both Bot Token and Chat ID. Switching platforms clears the inputs for that notification type. **Changes take effect only after saving**, without affecting the other notification type or trading switches.

Messages follow the current language preference. Timestamps use the time zone of the system running the extension and include the UTC offset, for example `2026-10-21 07:30:00 GMT+08:00`. Switching languages does not change the time zone.

## Test connectivity

1. Select a platform and complete the configuration for the relevant notification type. The test button is disabled for disabled, blank, or invalid configurations.
2. Click **Send test notification**. It uses the **current draft without saving**. No FOMO connection, monitoring, or live trading is required.
3. The button shows progress and prevents duplicate clicks for that notification type. The result appears beneath its configuration. API success means the platform accepted the message; also check the destination chat for the message labeled **FOMO notification connectivity test**.
4. On failure, check the HTTP status, platform error code, or network guidance shown. A timeout can leave delivery uncertain: check the chat before deciding to test again manually. There is no automatic retry.
5. **Save notification settings after a successful test** to use that configuration for future real notifications. Editing the configuration hides the old result; test again after changes.

Orders and alerts have separate test buttons. Test messages contain only the notification type and timestamp; they do not indicate a fill or system issue, create orders, change trading switches, save drafts, or affect real fill deduplication or alert cooldowns. Attempts are recorded in operation logs without bot credentials or raw platform responses. Test requests do not occupy the market/trading command queue.

## Feishu

1. In the destination Feishu group's settings, add a **custom bot**. Appropriate group permissions are required; menu names may vary by client version.
2. Copy the complete webhook. Select **Feishu** for the relevant notification type in the extension and paste it.
3. If signature verification is enabled for the bot, enter its secret in **Signing secret**. Otherwise, leave that field blank.
4. If keyword verification is enabled, add `FOMO`. Both order and alert messages contain this keyword in either language.
5. Save notification settings. Create or configure separate bots if orders and alerts should go to different groups.

Webhook format (placeholder only):

```text
https://open.feishu.cn/open-apis/bot/v2/hook/<BOT_WEBHOOK_ID>
```

The extension sends text messages. Signing uses a timestamp in seconds, HMAC-SHA256, and Base64 according to the platform protocol. Existing order and alert Feishu webhooks are recognized automatically without re-entry.

[Official Feishu custom bot guide](https://open.feishu.cn/document/client-docs/bot-v3/add-custom-bot)

## DingTalk

1. Add a **custom bot** in the destination DingTalk group's bot management settings. The group must allow bots.
2. In security settings, enable signing or set the custom keyword to `FOMO`. If multiple checks are enabled, all must pass.
3. Copy the complete webhook, including the `access_token` query parameter.
4. Select **DingTalk** in the extension and paste the webhook. If signing is enabled, enter the secret beginning with `SEC` in **Signing secret**. Leave it blank when using keyword verification alone.
5. Save. Do not append your own `timestamp` or `sign` parameters to the webhook field; the extension generates them for each send.

```text
https://oapi.dingtalk.com/robot/send?access_token=<ACCESS_TOKEN>
```

The extension sends text messages. Signing uses a timestamp in milliseconds, HMAC-SHA256, Base64, and URL encoding according to the platform protocol. An incorrect system clock can cause signature verification to fail.

[Official DingTalk custom bot security guide](https://open.dingtalk.com/document/robots/customize-robot-security-settings)

## WeCom

1. Add a **group bot** in the destination WeCom group and copy its webhook. This integration uses group bots, rather than an enterprise application's messaging API.
2. Select **WeCom** in the extension and paste the complete webhook, including the `key` query parameter.
3. Save. An enterprise Corp ID, application Agent ID, or application Secret is not needed.

```text
https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=<BOT_KEY>
```

Bot availability depends on your organization and group type. The bot must be able to post in the group; refer to the WeCom client for restrictions such as unsupported external groups.

[Official WeCom group bot guide](https://developer.work.weixin.qq.com/document/path/91770)

## Telegram

### Create a bot and prepare the destination

1. Find the official **@BotFather** on Telegram. Send `/newbot`, follow the prompts, and obtain the **Bot Token**. Verify that you are using the official BotFather.
2. Prepare the destination: for a private chat, send `/start` to your bot first; for a group, add the bot and allow it to send messages; for a channel, make the bot an administrator with permission to post messages.
3. Obtain the **Chat ID**. This is a numeric chat identifier. Group and supergroup IDs are usually negative, such as `-1001234567890`. A public channel may also use `@your_channel_name`. A person's username cannot replace their private Chat ID.
4. Select **Telegram** in the extension, enter the Bot Token and Chat ID, and save. Both fields must be filled or both left blank.

### Find the Chat ID

Use the official Telegram Bot API's `getUpdates` method to query your own bot's updates. The following is an endpoint template: replace the placeholder with your own token. You do not need to give the token to another bot or a third-party lookup website.

```text
GET https://api.telegram.org/bot<BOT_TOKEN>/getUpdates
```

Send a new message in the destination chat first. In a group, use `/start@your_bot_username` so a bot with privacy mode enabled can receive the command. Look for `result[].message.chat.id` in the response, or `result[].channel_post.chat.id` for channel updates. Example:

```json
{
  "ok": true,
  "result": [
    {
      "message": {
        "chat": { "id": -1001234567890, "type": "supergroup" }
      }
    }
  ]
}
```

If updates are empty, send a new message and query again. `getUpdates` cannot be used while an incoming-message webhook is configured. Obtain the Chat ID through the existing integration or use a bot dedicated to this extension. Do not delete a working integration just to retrieve an ID. The extension only calls `sendMessage`: it does not poll or consume updates or change your bot's webhook.

Messages are sent as plain text through the official `api.telegram.org` endpoint, with no Markdown or HTML parsing. Special characters in token names do not need escaping. The device running the extension must be able to access the Telegram Bot API.

[Official BotFather guide](https://core.telegram.org/bots/features#botfather) · [getUpdates](https://core.telegram.org/bots/api#getupdates) · [sendMessage](https://core.telegram.org/bots/api#sendmessage)

## Troubleshooting and credential storage

| Symptom | Check |
| --- | --- |
| No notifications | Were settings saved? Is this notification type disabled or empty? Did the event meet the original notification rules? Was the order already notified? |
| Settings cannot be saved | Does the webhook match the selected platform's domain and path? Is it complete? Are both Telegram fields valid and filled together? |
| Feishu or DingTalk rejects messages | Does keyword verification include `FOMO`? Is the signing secret correct if signing is enabled? If an IP allowlist is enabled, is the current network's public IP allowed? |
| WeCom rejects messages | Is the group bot still available? Was it removed? Has a platform rate limit been reached? |
| Telegram fails | Check token validity, Chat ID, whether the private chat was started, group membership, posting permissions, and network access to the official API. |
| Logs show failed or unknown delivery | Check platform settings and network access. HTTP 200 can still indicate a business error. A timeout does not prove non-delivery; fill messages are not retried automatically. |
| Extension stops working after an update | Reload it in `chrome://extensions`. If Chrome requests permissions for the additional notification domains, confirm them, then reopen the side panel. |

Webhooks, signing secrets, Bot Tokens, and Chat IDs are stored in the extension's local IndexedDB. Credential inputs are masked. Credentials are not sent to FOMO or included in order or log exports. Notifications are sent only to the selected platform's official HTTPS bot endpoint, with redirects disabled. Raw platform responses and exceptions are not logged, and delivery failures do not recursively trigger alerts.

The extension has no background server: closing the browser still stops monitoring and notifications. `config/local.example.json` documents the data structure and is not loaded automatically. Configure actual destinations in the extension settings.
