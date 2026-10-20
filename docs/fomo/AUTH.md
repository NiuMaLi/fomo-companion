# FOMO 认证与 Token

2026-10-19，v0.4.0。以下来自当前前端和已登录页面验证，不是官方稳定 API 合同。历史验证见 VERIFICATION.md。

## 获取与使用

- 页面 `privy:token` 提供访问凭据，解析后仅留在 MAIN 脚本闭包，供 WebSocket challengeResponse 与站内 RPC Bearer 使用。值不进入扩展消息、数据库、日志或文件。
- 当前 `privy:refresh_token` 为 deprecated，网站使用 Cookie 模式。`prod-api.fomo.family` 的余额和报价请求使用 credentials:include、Content-Type、X-Supported-Chains；不能假设复制一个 Bearer 即可重放所有 HTTP。
- 当前账户 ID 从网站正常 `/v2/users` 初始化响应获取，不主动 POST 注册账户，不从 JWT 声明猜测身份。
- 已验证站内 RPC `https://solana-provider-1.prod-edge.fomo.family` 的 getBlockHeight 和 simulateTransaction，使用当前页面访问凭据，credentials:omit。

## 钱包签名

`wallet.ts` 沿 DOM React Fiber 找到 HostRoot 的当前树，按 Provider 形状核对 fomoUser.id/address、walletState=ready、solanaWallet 及 Wallet Standard 的 solana:signMessage。每次签名前重新定位并匹配原账户；不读取私钥、不序列化钱包、不依赖发布文件 hash。

网站当前交易使用 wallet.signMessage({message:Uint8Array})，返回 signedMessage 和 64 字节 signature。插件同样只签报价原始 message，不让钱包直接广播；签名前后检查账户、行情、报价期限和撤销标记，合并代付签名后逐个 Ed25519 验签。后台先持久保存交易哈希，才能发出提交指令。

只验证了当前钱包对象和签名能力存在；**未实际请求签名**。MFA／交互确认／长期后台可用性仍待本人验收。站内 Provider 不是公开稳定接口，结构变化时能力检查失败并停止。

## 续期与异常

网站 fomoFetch 源码在认证失败后通过 `/refresh?silent=1` iframe 获取新 Token，校验 origin/contentWindow 并进行超时、并发合并和冷却。插件不复制这一协议，也不对交易 POST 自动续期重放；每次 RPC 从页面读取最新凭据。依赖网站正常登录和续期，401/403 暂停执行、触发配置好的系统告警。

未强制退出登录、制造 Token 失效或验证独立续期。关闭浏览器／FOMO 页后不能执行；独立服务需要无页面续期与经过授权的签名器，当前未开放。

## 桥接边界

后台只发固定 prepare/sign/submit/receipt/revoke 请求，校验资产、账户与请求 ID；页面返回有限状态、报价摘要和交易哈希，不返回完整交易或凭据。没有任意 URL、脚本执行或任意消息签名接口。MAIN 与网站脚本共享信任边界，不能将 postMessage 当作对恶意网站脚本的安全隔离；应只在可信的 FOMO 页面使用。

## 通知

两套飞书 Webhook 在扩展设置保存，默认空、不读取旧地址。认证／接口失败发告警，真实回执确认才发订单通知；去重标记先于请求持久保存，发送失败只写日志，不递归告警。配置、Cookie、Token、请求头和原始响应不进入通知或日志导出。


v0.5.0 保持认证边界不变：通知与附带保护不导出凭据。确认后余额核对 RPC 通过页面 closure 内的既有认证请求发送；桥接只传成交数值及剩余数量，不传 wallet 签名材料、Token 或 Cookie。余额查询失败使用未知值，不回退旧 session 伪造余额。

## v0.6.0 EVM 钱包

同一 ready Provider 中核对 fomoUser.id 和 evmWallet.address／fomoUser.evmAddress（EVM 忽略大小写）。只在页面内以 getEthereumProvider.request 交给网站原生签名流程；每次请求前后检查账户、撤销及报价时效。EVM 采用原生 EIP-7702 智能账户，而非复制 Token 或导出私钥。只向扩展传送经过格式校验的交易／UserOperation 哈希和公开执行意图。
