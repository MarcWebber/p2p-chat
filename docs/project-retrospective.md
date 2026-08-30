# 34 万条 Redis 命令之后

TwoOnly 是一个只允许两位固定成员进入的浏览器聊天工具。服务端帮助双方交换建连信令，聊天正文经过 AES-GCM 加密后走 WebRTC DataChannel，本机历史留在 IndexedDB。线上版本可以在 [twoonly-chat.vercel.app](https://twoonly-chat.vercel.app) 打开。

2026 年 8 月，Upstash 控制台已经记下 338,418 条命令，其中有 203,446 次读取和 134,972 次写入。TwoOnly 当时还没有与这个数字相称的消息量。更奇怪的是，聊天正文根本不经过 Redis。双方连上以后，文字、图片、语音和文件都由 WebRTC DataChannel 传输。

顺着 `/api/signal` 往浏览器里查，找到了三个没有停下来的定时任务。它们都在等同一件事：另一个人上线。

## 页面挂着不动，请求仍在增加

旧版 protocol v3 会同时使用 Supabase Realtime 和 Vercel HTTPS。WebRTC 尚未连通时，浏览器每 1.5 秒向 Supabase 发送一次 Hello，每 5 秒向 HTTPS 路径再发一次，还要每 1.2 秒读取 Redis Stream。

HTTPS Hello 写入 Redis 时会执行 `XADD` 和 `EXPIRE`。一个页面守着一个没有回应的房间，连续运行 30 天，仅 Redis 部分就会得到下面这组数。

```text
读取：30 × 24 × 3600 ÷ 1.2 = 2,160,000
写入：30 × 24 × 3600 ÷ 5 × 2 = 1,036,800
合计：3,196,800 条命令
```

这是根据旧版常量算出的长期上限，不表示控制台里的 338,418 条命令全部来自同一个页面。它解释了数字为什么会一直涨。房间保存得越多，打开的标签页越多，浏览器创建的信令连接也越多。对方离线一天，页面就白问一天。

把五秒改成一分钟只能推迟额度耗尽。服务端限流也只能拒绝已经到达的请求，浏览器里的定时器仍会继续运行。要停下这批空转请求，等待本身必须结束。

## 新代码停了，旧页面没停

第一次改造上线后，Upstash 的累计值还是从 338,418 走到了免费额度的 500,000。新页面已经不再无限轮询，只能继续检查那些在发布前打开、一直没有刷新的标签页。

部署会替换服务端和以后加载的静态资源，不会改掉旧标签页内存里正在执行的 JavaScript。更麻烦的是，当时 v3 与 v4 发给 `/api/signal` 的外层请求长得一样。一个旧 poll 只有下面几个字段：

```json
{
  "action": "poll",
  "roomId": "...",
  "participantId": "...",
  "cursor": "0-0"
}
```

v4 的 `protocol: 4` 放在加密后的信令正文里。服务端只负责暂存密文，没有邀请秘密，也就读不到这个版本号。旧页面发来的 poll 会照常执行 `XRANGE`，publish 也会照常执行 `XADD` 和 `EXPIRE`。等新浏览器解密后发现协议不兼容，Redis 命令早已发生。

截图当时还剩 161,582 条免费命令。按一个旧页面每天 106,560 条的上限计算，约 36.4 小时就能用完。这项计算不能证明最后的用量只来自一个旧页面，却与额度很快见底的时间尺度相符。

## 七秒后，停止呼叫

protocol v4 删除了周期 Hello。浏览器在上线、恢复网络、重新订阅 Supabase 或 WebRTC 断开时创建一个新的 `wakeSeq`，并在 0、1、3、7 秒发送 Wake。时间写在 `src/config/policy.ts`。

```ts
wakeRetryDelaysMs: [0, 1_000, 3_000, 7_000]
```

四次发送共用一个 `wakeSeq`，每次传输仍有独立的 `signalId`。接收方把已经处理过的序号保存在 IndexedDB。更大的序号会启动新一轮协商；相同序号只补发 ACK；较小的序号已经过期，不能再拉起 PeerConnection。

只要 ACK 到达，`WebRtcSession.cancelWakeCampaign` 就会清掉尚未执行的定时任务。DataChannel 打开、页面交出网络租约或会话销毁时，也会调用同一个函数。四次都没有回应，本轮联系到此结束。

![同一轮 Wake 的序号判断](assets/wake-signaling/04-wake-sequence-decision.png)

第一次 Wake 没有延迟，在线重连仍会立刻开始。对方长期离线时，当前页面七秒后便不再发送。等对方重新打开网页，它会创建自己的 Wake，联系仍由刚上线的一端恢复。

## Redis 平时不再启动

浏览器创建信令传输时仍会准备 Supabase 和 HTTPS 两个 provider。启动顺序已经改变。`src/signal/signalTransport.ts` 先连接 Supabase。订阅成功后，HTTPS provider 保持休眠，不会访问 `/api/signal`。

Supabase 明确报告错误或订阅失败，`ensureHttpsStarted` 才会打开备用路径。Redis 读取也不再循环。当前配置安排了七次读取，等待时间依次为 0、1、2、4、5、6、7 秒。按实际发生时刻计算，请求约在第 0、1、3、7、12、18、25 秒到达，随后停止。

```ts
httpsFallbackPollDelaysMs: [0, 1_000, 2_000, 4_000, 5_000, 6_000, 7_000]
```

只有一端连不上 Supabase 时，Vercel 会把它提交的加密 Wake 暂存在 Redis，再通过 Supabase REST Broadcast 交给仍然在线的一端。健康端在 30 秒内把 ACK、Offer 和 ICE 发回 HTTPS。整个过程不要求健康端长期读取 Redis。

Redis Stream 最多保留约 128 条信令，末次写入 180 秒后过期。保存内容已经用邀请秘密加密。聊天正文依旧只在两个浏览器之间传输。

![Supabase 正常时 Redis 保持休眠](assets/wake-signaling/01-overall-architecture.png)

## 多开页面只留一个联网者

周期请求消失以后，同一个浏览器多开标签页仍会造成重复订阅。TwoOnly 会在 IndexedDB 中生成一个随机安装 ID。它只存在于当前浏览器配置目录，不读取 MAC 地址，也不采集指纹。

每个标签页都可以申请网络租约。持有者每 5 秒续期，15 秒没有续期，其他页面便可以接手。租约里的 fence 会阻止旧持有者恢复后继续联网。页面触发 `pagehide` 时主动释放租约；异常关闭则交给过期时间处理。

只有拿到租约的标签页会恢复房间运行时。多个房间仍可同时在线，底层共用一个 Supabase client。安装 ID 只负责同一浏览器里的协调，不能代替房间成员密钥，也不能用于换设备找回聊天。

## 服务端也要认识版本

这次修正把协议号放到了 HTTPS 请求外层。publish 和 poll 都必须携带当前的 `protocol`，Route Handler 解析 JSON 后先核对它，再检查 Redis 配置并进入存储函数。

```json
{
  "action": "poll",
  "protocol": 4,
  "roomId": "...",
  "participantId": "...",
  "cursor": "0-0"
}
```

没有版本号或版本不匹配的请求会收到 HTTP 426。返回内容不再只有一个字符串，客户端可以据此决定是否还值得重试。

```json
{
  "error": {
    "code": "client_upgrade_required",
    "level": "terminal",
    "retryable": false,
    "message": "当前页面版本过旧，请刷新页面后重试。",
    "expectedProtocol": 4
  },
  "requestId": "..."
}
```

`terminal` 表示继续发送同一格式的请求不会变好。新版客户端会停止这条 HTTPS 调度，取消尚未执行的 Wake，并把刷新提示显示在聊天界面。`recoverable` 留给 Redis 一类临时后端故障，原来的有界重试仍可继续。`retryable` 单独保留在响应里，让没有 TypeScript 类型信息的调用方也能直接作出判断。

旧 v3 页面不认识这份错误，仍可能每 1.2 秒访问一次 Vercel。现在这些请求会在 Redis 之前被挡住，Upstash 不再为它们记账。版本闸门保护的是 Redis 免费额度，无法远程关掉别人浏览器里已经运行的旧代码。

## 还要继续看数字

| 页面与网络状态 | Redis 行为 |
| --- | --- |
| 新客户端，Supabase 健康 | HTTPS 保持休眠，正常路径为 0 条命令 |
| 旧客户端继续轮询 | `/api/signal` 返回 426，不进入 Redis |
| 新客户端确认 Supabase 故障 | HTTPS 在约 25 秒的窗口内有限读写 |

事件唤醒改动收录在提交 [`1d7b251`](https://github.com/MarcWebber/p2p-chat/commit/1d7b251e1837e39fc476db5029339e6e0c618f40)。项目留下的验收记录显示，Supabase 正常时，生产回归没有产生 `/api/signal` 请求。这只能证明新客户端的正常路径已经绕开 Redis，不能证明 500,000 条命令全部来自旧页面。要分清剩余来源，仍需把 Upstash 分时数据与 Vercel 的 `/api/signal` 日志放在一起看。

这道闸门也不是限流。修改过的客户端可以伪造 `protocol: 4`，Supabase 心跳异常也可能让多个房间一起进入短时降级。真正要防恶意调用，还得按 IP、房间和总预算做限流与熔断。眼下先把最确定的漏洞堵住：旧页面可以继续敲门，服务端不再替它打开 Redis。
