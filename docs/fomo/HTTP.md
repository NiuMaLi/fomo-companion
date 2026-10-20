# FOMO HTTP 与交易接口

2026-10-19，v0.4.0。Base URL：`https://prod-api.fomo.family`。当前前端协议可能变化；以下区分实测与源码／代码实现。

| 方法 | 路径 | 用途与证据 |
| --- | --- | --- |
| GET | `/v2/users/{id}/balances` | 真实 Cookie 余额，200/success=true |
| GET | `/config` | 各网络买卖最小金额 |
| POST | `/proxy/filterTokens` | 只读查询，body 为 token ID 数组，已验证 |
| GET | `/trades?userId=...&networkId=...&tokenAddress=...&orderBy=closedAt` | 目标资产历史，一页已验证，未做全量分页 |
| GET | `/trades/{tradeId}` | 详情，前端源码；本插件未接入全量历史 |
| POST | `/swaps/v3` | 获取报价与待签名字节，4U SOL 实测成功，尚未签名 |
| POST | Solana provider JSON-RPC | getBlockHeight／simulateTransaction 实测；sendTransaction／getSignatureStatuses／getTransaction 代码已接入，尚未真实广播验收 |

`POST /v2/users` 是网站账户初始化／注册逻辑，插件只观察网站自身响应，不能主动当作 GET 调用。

## 返回与认证

API 包装含 success、responseObject、errorCode/message，HTTP 状态与业务结果分别判断。API 使用 Cookie，RPC 使用页面当前 Privy Token Bearer；详情见 AUTH.md。完整返回与请求头不记录。

## 余额和元数据

balances 元素含 balance、tokenFilterResult、userToken、valuation。实际可用数量优先 balance.shiftedBalance，缺失时 userToken.humanAmountRemaining；原子余额为 balance.balance。

持仓展示使用 userToken.humanAmountRemaining、averageEntryPriceUsd；未实现盈亏由成本与当前价计算，不使用已实现收益代替。tokenFilterResult.token 含 address/networkId/symbol/name/decimals，头像依次取 info.imageThumbUrl/imageSmallUrl/imageLargeUrl。缺失头像或精度时每资产最多每分钟额外查询一次。

v0.5.0 不以 config.minPurchaseAmountByChain 或回退值作为本地建单限制；桥接仍读取该平台元数据。服务端仍可在报价阶段拒绝不满足其交易约束的小额订单；不自动补仓或放大金额。

## 报价金额与资产

真实执行覆盖平台当前七个现货网络，由 /swaps/v3 选择 Solana／Relay／Mobula 路线。资金现金腿固定为此链 USDC `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`。面板行情和账户展示仍支持其他已识别网络，SOL 只是开发实盘测试币种。

Token ID 为 `tokenAddress:networkId`。POST body：

```json
{
  "inTokenId": "输入资产地址:网络ID",
  "outTokenId": "输出资产地址:网络ID",
  "amount": "最小单位整数字符串",
  "retry": 0,
  "slippageBps": 100
}
```

买入4U：输入 USDC，amount=`4000000`；卖出：输入代币数量×10^decimals，必须为正整数。不得直接传美元人类单位。产品没有 SOL／10U 金额限制，测试规则另见 TESTING.md。

直接 Solana 无 Jito 路线使用本地字节校验与 RPC；其余路线使用网站原生单次执行模块。核对 expectedOutHumanAmount、dynamicSlippageBps、lastValidBlockHeight、swapTransaction、feePayerAddress/Signature；当本单配置正滑点时，超过该上限会拦截；价格影响绝对值5%的独立校验保留。

本单启用滑点时：限价买入按输入USDC/最小预计输出≤目标价，限价卖出／止盈按最小预计USDC/数量≥目标价；止损按新鲜实时价和允许滑点核对。未满足目标的报价只等待下一次，不生成成交。

v0.8.0 空值／0 不传 `slippageBps`，不采用插件默认值／旧全局值，不做本地滑点上限或止损报价偏离检查。限价／止盈改用预期输出检查目标价。FOMO 自身公开前端也在自定义滑点为 null 时省略此参数（2026-10-20 保存的 tokenWarnings-v2 模块源码已核验）；平台可能自动生成自身交易限制，不能宣称链上交易没有最小输出。本轮没有发起真实签名或广播。

## 交易编码与提交

当前真实报价为 **Solana v1**：message 在前、签名在后；message[1] 是签名数，静态签名账户从 offset 42 开始，最大4096字节。legacy/v0 为 compact 签名数、签名数组、message，最大1232字节。源码与真实报价核对了 v1 的两签名槽；单元测试覆盖三种编码和签名防篡改。

先合并代付签名，调用 simulateTransaction(sigVerify:false) 做无状态链上预检，再请求钱包 signMessage 对原始 message 签名。保持消息字节与已有签名不变，逐个 Ed25519 验证。预检不是模拟成交，不持久化任何模拟仓位。

后台持久化第一个签名的 Base58 哈希后，页面通过固定 provider RPC sendTransaction(base64,skipPreflight:false,maxRetries:2) 广播。提交异常进入 unknown，不自动重新报价／签名／重发。

getSignatureStatuses(searchTransactionHistory:true) 确认后再 getTransaction(jsonParsed,maxSupportedTransactionVersion:1)。回执要求 meta.err=null，并核对当前钱包的目标资产与 USDC 余额变化方向、真实数量和金额；原生SOL叠加lamports与WSOL变化，并扣除本人支付的交易费。只有核对后才记成交和发送订单通知。实际租金／费用边界仍待实盘验证。

当前网站还存在 trade edge、Jito 等其他路径；本实现不依赖这些路径，不声明所有 provider 均兼容。平台成交索引同步、真实签名、广播与回执尚未用真实交易验收。

## 网络映射

行情路由识别 ethereum=1、bnb=56、monad=143、robinhood=4663、arc=5042、base=8453、solana=1399811149。X-Supported-Chains 使用这些网络；未知网络不猜测，EVM 地址归一化小写，Solana Base58 保留大小写。原生多链执行从当前网页 modulepreload／资源／manifest 发现同源模块，不固定发布 hash；接口形状不匹配则在签名前停止。


## v0.5.0 确认后的剩余仓位

成交方向、价格、数量和 USDC 价值仍来自 getTransaction 的余额变化。额外只读调用 getTokenAccountsByOwner(owner, {mint}, {encoding:jsonParsed, commitment:confirmed, minContextSlot:成交slot})，汇总该钱包同币全部 SPL 账户；原生 SOL 另调用 getBalance。交易详情的 postTokenBalances 仅包含参与该交易的账户，不能当作整个钱包同币余额。额外查询失败不影响已证明的成交，剩余字段留空并通知“未获取”。新 RPC 路径本轮用确定性测试验证，尚未在实际成交后核验生产返回。

## v0.6.0 多链执行及索引核对

- `v2Swap.relaySwapId` 或 `mobulaSwap.intentId` 在执行前持久化，连同 inTokenId、outTokenId、来源链和开始时间。后台崩溃或通信超时后只查询既有意图。
- EVM 来源按 `preTransactions → approvalTransaction → depositTransaction → postTransactions` 批量执行。复用网站 AccountProvider 的 EIP-7702／智能账户与 bundler 流程；每次钱包 provider 请求及最终提交回调均检查撤销状态。保存 UserOperation 哈希用于恢复，不使用 eth_sendTransaction 替代原生流程。
- Solana 来源复用 swaps 的单次 signAndSendTransaction 与共享区块高度引用，不调用含新报价／多次签名重试的高级跨链入口。不读取或序列化私钥、钱包 provider、访问凭据。
- 状态：GET `/swaps/v2/status?relaySwapId=...`；GET `/swaps/v3/status?provider=mobula&intentId=...&wait=true`。SUCCESS 只代表路线状态，不能替代实际成交数量。
- Relay：GET `https://api.relay.link/requests/v2?id=...` 精确匹配持久请求 ID，核对 inTxs 来源哈希与网络，收集 outTxs 哈希。此第三方 GET 不附加 FOMO 凭据、Cookie 或业务头。
- EVM UserOperation 恢复：POST `https://bundler.prod-edge.fomo.family/v2/{chainId}/rpc`，eth_getUserOperationReceipt。null 仍待确认，success=false 明确失败。
- 只读核验真实 `/trades/{id}` 包含 `signature`、`inNetworkId/outNetworkId`、`inTokenAddress/outTokenAddress`、`inHumanAmount/outHumanAmount`、`humanUsdAmountIn/Out`。必须账户、币种两端及实际交易签名精确匹配才确认。买入用 outHumanAmount／humanUsdAmountIn；卖出反向，成交价为实际 USD／数量。
- Mobula 已接原生提交及状态恢复；状态接口缺少可精确关联的结算哈希时保留待核对，不能用时间、金额或总余额猜测成交。这种情况下保护单与通知等待成交索引。
- 当前原生模块复用方案面向加载解压目录；依赖网站接口，未做 Chrome Web Store 发布合规验收。网站版本升级会触发接口校验并停止，不静默切换签名路径。
