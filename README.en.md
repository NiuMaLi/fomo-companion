# FOMO Companion

[简体中文](README.md) | **English**

A Chrome extension for [FOMO](https://fomo.family), with real account positions, live market data, conditional limit orders, take-profit and stop-loss orders, trade logs, and Feishu notifications.

Built with WXT, React, TypeScript, and Manifest V3. Supports Simplified Chinese and English. Current version: **v0.8.0**.

> This is an unofficial extension that depends on FOMO's current web interfaces and wallet capabilities. Live execution paths are implemented, but complete live buy/sell validation on each network, extended unattended operation, and recovery after browser exit have not yet been verified. Read the execution notes and test records before use.

## Features

- **Accounts and positions**: Reads the currently signed-in account and displays token icons, actual quantities, average entry prices, and unrealized profit/loss.
- **Live market data**: Follows the current FOMO token page. Each pending conditional order subscribes to its own asset's prices independently; switching charts does not change an existing order's asset.
- **Chart price selection**: Click FOMO's main price chart to populate the target price and see the percentage change relative to the current price or entry cost.
- **Conditional orders**: Limit buys, limit sells, take-profit sells, and stop-loss sells, with 30% / 50% / 100% or custom position percentages for sells.
- **Attached take-profit and stop-loss orders**: Add a protection plan to a limit buy. Once the buy is confirmed, mutually exclusive sell orders are created using the actual quantity bought in that order.
- **Per-order slippage**: Maximum slippage is optional. Leaving it blank or setting it to 0 disables the extension's slippage protection without applying a default. Attached protection orders inherit their parent order's setting.
- **Live trading switch**: When disabled, the extension only saves orders and logs price triggers. It does not request quotes, sign or broadcast transactions, or create simulated fills or positions.
- **Orders and logs**: Persisted locally, with category filters, order snapshots at each event, full transaction hashes, and redacted JSON exports.
- **Feishu notifications**: Separate webhooks for confirmed fills and system alerts. No messages are sent when a webhook is not configured.
- **Language switching**: Saves your language preference and applies it to the interface, historical log display, and newly sent Feishu messages.

Integrates with FOMO's current Ethereum, BNB, Monad, Robinhood, Arc, Base, and Solana spot networks, using available platform quotes and native execution routes. The platform may reject trades because of balances, liquidity, trade size, network conditions, or wallet state. Network support does not guarantee that every token can be traded.

## Installation

### Install from a release package

1. Download and extract the project's Chrome ZIP package. Make sure the extracted directory contains `manifest.json`.
2. Open `chrome://extensions` and enable **Developer mode**.
3. Click **Load unpacked** and select the extracted directory.
4. Open FOMO and sign in. Refresh the page, then click the extension icon to open the side panel.

Installation currently uses manual loading. No Chrome Web Store installation link is available.

### Build from source

Requires **Node.js 22.12+**, npm, and **Chrome 116+** with Side Panel support. The Node.js requirement also depends on the build tools pinned in the lockfile.

After cloning the repository, run these commands in the project root:

```bash
npm ci
npm run build
```

Load `.output/chrome-mv3` in Chrome. Run `npm run zip` to generate `.output/fomo-companion-0.8.0-chrome.zip`.

To update, replace the files in the existing installation directory, reload the extension on the extensions page, and refresh FOMO. Avoid uninstalling and reinstalling: uninstalling or clearing extension data may delete local orders, logs, and settings.

## Usage

1. Open the token detail page you want to trade on FOMO. Wait for the account and market connections in the side panel to become ready.
2. On the trading tab, select an order type and enter the target price and buy amount or sell percentage. You can also click the chart to populate the price.
3. Optionally enter maximum slippage or attach take-profit and stop-loss orders to a limit buy, then save the conditional order.
4. To submit trades automatically, enable live trading in Settings once wallet capabilities are ready, then enable automatic monitoring.
5. View order states on the conditional orders tab, and expand events in the logs to see their order details.

### Execution and recovery

- **Chrome and at least one signed-in, usable FOMO execution page must remain running.** Conditional orders cannot execute while the browser or execution page is closed, the computer is asleep, or the connection is unavailable. There is currently no standalone server execution service.
- Orders, logs, and settings are stored in the extension's local IndexedDB. After reopening, execution waits for the account and fresh market data to recover. Stale prices are not used to make up missed trades.
- A price trigger, quote, or transaction submission is not a fill. Orders are marked as filled, attached protection is activated, and fill notifications are sent only after the actual fill has been reconciled successfully.
- Turning off live trading or monitoring stops subsequent submissions but cannot reverse transactions that have already been broadcast. Submitted transactions continue to be reconciled.
- When the result is unknown, the original transaction identifiers are retained for further reconciliation to avoid duplicate submissions. Do not create duplicate orders to bypass a pending reconciliation.
- The website wallet may require manual signing or verification. Website login and signing capabilities are not guaranteed to remain available indefinitely.

### Slippage and protection orders

Maximum slippage is configured independently for each conditional order. Positive values up to 5% are accepted, in increments of 0.01%. **Blank or 0 disables the extension's slippage protection.** The extension does not fall back to the old global setting or send a custom slippage parameter to the platform. Transactions built by the platform may still contain its own minimum-output or other constraints; the extension does not rewrite signed transactions.

With slippage protection enabled, limit and take-profit targets are checked against a conservative quote that accounts for slippage; stop-loss orders check quote deviation from the live price. With protection disabled, limit and take-profit orders still check that the expected quote meets the target, while stop-loss orders do not impose an additional quote-deviation cap. The separate 5% price-impact check remains in place. A target price does not guarantee the actual fill price.

Attached take-profit and stop-loss orders use the actual quantity bought by their parent order, rounded down to the token's precision. When one side fills, the other is cancelled, **even if only 30% of the position is sold**. Any remaining position needs a separate protection plan. Child orders are not activated while the parent buy is unfilled, failed, or cancelled.

The extension has no SOL-only restriction, fixed 2 USDC minimum trade size, or 10 USDC position cap. Trades must still satisfy platform rules, token precision, actual balances, and overselling checks. The live development test policy is documented separately and is not a product restriction.

### Feishu notifications

In Settings, configure and save two custom bot webhooks under Feishu notifications:

| Channel | Content |
| --- | --- |
| Order notifications | Confirmed fills: pair, side, price, quantity, value, remaining position at reconciliation, order ID, and transaction hash |
| Alert notifications | System issues such as expired login credentials or failed API calls, with cooldown-based deduplication for the same alert type |

An empty webhook disables its channel. Channels do not fall back to each other, and messages from periods without a configured webhook are not sent later. Feishu custom bot webhooks are supported; additional signing-secret configuration is not supported. If a balance cannot be reconciled, it is shown as unknown rather than zero.

Notification timestamps use the system time zone of the device running the extension and include the UTC offset, for example `2026-10-21 07:30:00 GMT+08:00`. Switching languages does not change the time zone. Fill notifications show the fill confirmation time; alert notifications show the alert time.

Configure webhooks directly in the extension. `config/local.example.json` only illustrates the settings structure and **is not loaded automatically**.

## Development

```bash
npm ci
npm run dev        # WXT development mode
npm run typecheck  # TypeScript checks
npm test           # Deterministic Vitest tests
npm run build     # Chrome production build
npm run zip       # Distribution ZIP
```

Automated tests use synthetic data and mocks. They do not require a FOMO login, real funds, or Feishu webhooks. Coverage includes market data isolation, order reservations, per-order slippage, mutually exclusive protection orders, duplicate execution prevention, fill reconciliation, database compatibility, notifications, logs, and internationalization.

Browser probes in `scripts/` are development diagnostics, not routine test or extension runtime dependencies. Read each script and the [verification records](docs/fomo/VERIFICATION.md) before running it, and use only dedicated test tabs. Real signing, broadcasting, and notification acceptance tests require separate authorization and must follow the test policy.

### Directory structure

```text
entrypoints/          Extension background, content script, and side panel entry points
src/
  components/         React interface and styles
  i18n/               English translations
  shared/             Data models, protocols, networks, and shared logic
  storage/            IndexedDB, logs, and legacy data compatibility
  trading/            Conditional orders, quotes, signing, execution, and fill reconciliation
  notifications/      Feishu notifications
config/               Credential-free settings and live test policy examples
tests/                Deterministic tests
scripts/              Development diagnostics
docs/                 Usage, architecture, interfaces, and verification documents
design-system/        Interface guidelines
```

### Contributions

Commit source code, tests, documentation, configuration examples, and `package-lock.json`. Do not commit generated directories such as `node_modules/`, `.wxt/`, or `.output/`. Distribution ZIP files can be attached to repository releases.

For features and fixes, run type checks, tests, and a production build. Changes to trade execution should also verify duplicate submission prevention, disabled-switch behavior, failed and unknown states, and recovery. When reporting issues, include the extension version, Chrome version, reproduction steps, and redacted errors. Do not submit tokens, cookies, webhooks, private wallet material, or complete account exports.

`.gitignore` excludes common local settings, logs, trade exports, browser network captures, and key files. Ignore rules apply only to untracked files. Previously committed files must be untracked separately, and adding ignore rules does not remove sensitive information from Git history.

## Documentation

The detailed documents linked below are currently in Simplified Chinese.

- [Installation and detailed usage](docs/INSTALL.md)
- [Architecture and order recovery](docs/ARCHITECTURE.md)
- [Authentication and token boundaries](docs/fomo/AUTH.md)
- [HTTP interface integration](docs/fomo/HTTP.md)
- [WebSocket protocol](docs/fomo/WEBSOCKET.md)
- [Test scope and acceptance](docs/TESTING.md)
- [Historical verification records](docs/fomo/VERIFICATION.md)
- [Requirements and implementation plan](docs/PLAN.md)
- [Settings structure example](config/local.example.json)
- [Live development test policy example](config/trade-test-policy.example.json)

Interface documentation describes observed platform behavior, not an official stable FOMO API contract. Changes to website interfaces or wallet modules may require integration updates.

## License

This project is licensed under the [MIT License](LICENSE). Rights to the FOMO name, platform services, and third-party dependencies belong to their respective owners.
