# FOMO WebSocket 价格协议

核验日期：2026-10-16。实际连接地址：

```text
wss://prod-api.fomo.family/ws
```

## 已实测的会话

连接打开后，前端发送认证响应；收到 challenge 时也会重新响应。凭据从当前页面 Privy SDK 获取，以下仅为占位示例：

```json
{"type":"challengeResponse","jwt":"<当前访问凭据，不记录>"}
```

服务器返回：

```json
{"type":"challengeAccepted"}
```

认证通过后订阅 SOL：

```json
{
  "type":"subscribe",
  "topicType":"prices",
  "topicId":"So11111111111111111111111111111111111111112:1399811149"
}
```

**topicId 顺序是 `tokenAddress:networkId`。** 首次使用反向顺序得到 `SUBSCRIBE_REJECTED`，改为前端编码函数的结果后收到 `subscribed` 与 `data`。

本轮观察到的公开价格 payload：

```json
{
  "priceUsd": 105.78208112114291,
  "timestamp": 1792131832,
  "blockNumber": 0
}
```

该样本仅描述当次响应，不是当前报价。`timestamp` 样本为秒级 Unix 时间，`blockNumber:0` 不能当成有效区块高度。

## 源码补充

数据消息使用 `type:data`、`topicType`、`topicId`、`payload`。取消订阅使用 `type:unsubscribe` 与相同主题标识。服务器还可能返回 `challenge`、`subscribed`、`unsubscribed`、`error`。

每次重连需要重新认证，`challengeAccepted` 后恢复订阅。当前网页实现会在页面隐藏约 3 秒后暂停部分主题，包括 prices，并在重新显示时恢复。

因此，自动交易不能只监听网页现有价格状态；后台页面可能停止更新。扩展需要独立行情连接，并验证其实际认证来源与后台运行能力。

另有 Mobula WebSocket 用于图表和发现列表，本轮没有独立验证，不能与本协议混用。

## 插件适配要求

- 认证通过后才发订阅，维护主题引用计数。
- 校验网络和合约地址，拒绝非预期主题数据。
- 校验 priceUsd 为正且有限、时间戳可解析，记录服务器时间与本机接收时间。
- 拒绝时间倒退和明显过期数据；重复推送不得重复创建执行意图。
- 断线后清除行情健康状态，采用带抖动的退避；重新认证、订阅并拿到新鲜数据后才能触发订单。
- WebSocket 价格仅作为触发依据；提交前仍需最新可执行报价和风控检查。
- 不能把图表心跳格式直接套用到此连接；本连接的应用心跳／长期存活规则尚未独立核验。
- 本轮连接仅验证认证、订阅和首个价格数据，未测试长连接、Token 到期后重认证或断线恢复。


## v0.2.0 多资产

当前代币页的 mint 与待执行订单资产组成订阅集合，topicId 均为 `tokenAddress:networkId`。页面路径发生 SPA 切换时更新当前资产订阅，未结订单仍保留各自订阅。收到旧资产晚到消息时，仅在其仍属于订阅集合时转发，并始终带原资产身份。
