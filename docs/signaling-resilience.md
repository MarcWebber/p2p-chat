# Supabase + Vercel HTTPS 主备信令

TwoOnly 的聊天正文走 WebRTC DataChannel，但新的 PeerConnection 仍需要交换 Wake、Offer、Answer 和 ICE Candidate。TURN 只能中继已经完成协商的 WebRTC 流量，不能替代信令。因此，某一端无法访问 Supabase Realtime 时，仅仅显示“TURN 凭据正常”仍不足以完成建联。

当前实现以低延迟 Supabase WebSocket 为主路径。只有客户端明确观察到 Supabase 错误或超时，才短时启用同源 `/api/signal`；健康状态下不会访问 Redis。

## 1. 当前结论

| 项目 | 当前实现 |
| --- | --- |
| WebSocket 路径 | Supabase Realtime Broadcast |
| 同源 HTTPS 路径 | Vercel Route Handler `/api/signal` |
| 共享短时队列 | Upstash Redis Stream，由 Vercel 服务端访问 |
| 客户端策略 | Supabase 主用；HTTPS / Redis 只在明确故障时有界启用 |
| 重复处理 | 每次发送生成 `signalId`，进入 WebRTC 状态机前去重 |
| HTTPS 信令内容 | 使用邀请 fragment 派生的独立 AES-GCM 密钥加密 |
| 队列边界 | 每房间约 128 条，最后一次写入 180 秒后过期 |
| 聊天正文 | 仍然只走 WebRTC DataChannel，不进入信令队列 |

这不是把应用或 Supabase 迁移到 Redis。Redis 只保存几分钟内用于建立 WebRTC 的临时密文事件。

## 2. 单边故障如何避免主备错台

假设 A 可以访问 Supabase，B 不可以。如果只让 B 写 Redis：

- A 继续在 Supabase 等待；
- B 改到 HTTPS 队列等待；
- 两端分别连接成功，却永远收不到对方。

v4 用一次短时桥接解决，不需要双方常驻 Redis：

1. B 把加密信令写入 `/api/signal`；
2. Vercel 暂存 Redis 后，用 Supabase Broadcast REST 把同一密文事件桥接到房间 channel；
3. A 通过健康 WebSocket 收到并在本地解密；
4. A 只针对 B 的 30 秒 bridge window 把 ACK、Offer、Answer 或 Candidate 写回 HTTPS；
5. B 在最多 7 次、约 25 秒的有界读取窗口中接收；
6. Supabase 恢复、DataChannel 打开或窗口到期后停止。

这样 Supabase 健康的一端不需要轮询 Redis，同时保留单边故障下的共同返回路径。

## 3. Vercel HTTPS 端点

浏览器只访问同源接口：

```text
POST /api/signal
```

请求分为两种动作：

| 动作 | 用途 |
| --- | --- |
| `publish` | 写入一条加密信令 |
| `poll` | 从上一个 Redis Stream cursor 继续读取 |

Route Handler 会校验同源请求、Content-Type、请求大小、room/participant/signal ID 和 cursor。它不会接收 URL fragment，也无法解密 payload。Redis Stream 使用服务端生成的单调 cursor，客户端不依赖本机时间排序。

v4 正常情况下只使用 Supabase；HTTPS / Redis 不启动。只有 Supabase 明确返回错误或超时后，客户端才进入一次最长约 25 秒、最多 7 次读取的降级窗口；Wake 本身只在 `0 / 1 / 3 / 7` 秒发送。Supabase 恢复或 DataChannel 打开后立即停止降级读取。

## 4. 配置 Upstash Redis

在 [Vercel Marketplace 的 Upstash 页面](https://vercel.com/marketplace/upstash)完成以下操作：

1. 点击安装并选择 `twoonly-chat` 项目；
2. 创建一个 Free Redis 数据库，区域尽量靠近 Vercel Function；
3. 把数据库连接到 Production 环境；
4. 确认 Vercel 自动注入下面两个变量；
5. 重新部署 Production。

```dotenv
KV_REST_API_URL=https://YOUR_DATABASE.upstash.io
KV_REST_API_TOKEN=xxx
```

代码也兼容手工创建 Upstash 时常用的 `UPSTASH_REDIS_REST_URL` 和 `UPSTASH_REDIS_REST_TOKEN`，并优先读取这组名称。两组任选其一即可。这些都是服务端秘密，不能添加 `NEXT_PUBLIC_` 前缀，也不能提交到仓库。

部署后检查：

```bash
curl https://twoonly-chat.vercel.app/api/signal
```

配置完成时应返回：

```json
{"ok":true,"configured":true,"bridgeConfigured":true}
```

`configured:true` 只证明 Redis 变量存在，`bridgeConfigured:true` 只证明 Supabase Bridge 变量存在。真正可用还要看到浏览器日志中的 `signal.https.send.ack`，以及另一端通过 `https` provider 收到 Wake。

## 5. 代码边界

| 文件 | 职责 |
| --- | --- |
| `src/signal/supabaseSignalTransport.ts` | Supabase 订阅、发送确认、心跳和清理 |
| `src/signal/httpsSignalTransport.ts` | 加密、发布、短轮询、恢复和暂停 |
| `src/signal/signalTransport.ts` | 聚合健康状态、双发、入站校验和去重 |
| `src/signal/httpsSignalProtocol.ts` | HTTPS 请求、事件和 cursor 的运行时校验 |
| `src/signal/serverSignalStore.ts` | 通过官方 Upstash SDK 操作 Redis Stream |
| `app/api/signal/route.ts` | 同源 Vercel HTTPS 入口 |
| `src/crypto/aesGcm.ts` | 聊天与信令共用的 AES-GCM JSON 基础能力 |

`WebRtcSession` 只接收经过聚合器验证、去重后的 `SignalMessage`，不知道消息来自 Supabase 还是 HTTPS。UI 也只关心“至少一条信令可用”，不会把某一个供应商的错误误报成整个聊天已经断开。

## 6. 日志预期

| 日志 | 含义 |
| --- | --- |
| `signal.supabase.ready` | Supabase Realtime 已订阅 |
| `signal.https.poll.start` | 开始同源 HTTPS 轮询 |
| `signal.https.send.ack` | 密文事件已写入 Redis Stream |
| `signal.route.dual` | 两条信令均可用 |
| `signal.route.degraded` | 至少一条可用，可以继续握手 |
| `signal.route.unavailable` | 两条信令均不可用 |
| `hello.received` | 已经通过某一信令通道发现对方 |

日志只记录 provider、事件类型、耗时和短 ID，不记录完整房间、SDP、Candidate、密钥或 Redis Token。

## 7. 必测矩阵

| 场景 | 期望结果 |
| --- | --- |
| Supabase 与 HTTPS 都正常 | `signal.route.dual`；重复信令被去重 |
| Supabase 对一方不可达 | 双方通过 HTTPS 完成 Hello 和协商 |
| Supabase 对双方不可达 | 双方通过 HTTPS 完成握手 |
| Redis 未配置或故障 | HTTPS 返回 503/502；Supabase 正常时仍能连接 |
| DataChannel 建立后 Supabase 中断 | 聊天继续；不恢复无意义轮询 |
| DataChannel 断开且 Supabase 仍不可达 | HTTPS 轮询恢复并完成新一轮协商 |
| 同一信令从两条通道到达 | 只进入 `WebRtcSession` 一次 |
| 第三个成员加入 | protocol v4 验签后发现公钥不属于两席，返回 `member-locked`；空房或断线也不转让席位 |

最关键的单通道验收方式是在两端浏览器阻断 Supabase 域名，但保留 TwoOnly Vercel 域名，然后重新进入同一房间。双方应出现 `signal.route.degraded`、`hello.received`、Offer/Answer、ICE 和 `data.open`。

## 8. 能保证什么，不能保证什么

这套方案解决的是“用户能访问 TwoOnly，但无法直接访问 Supabase”这一类故障。因为浏览器到 Vercel 的链路已经由页面和 TURN 凭据接口验证，HTTPS 信令不再要求它额外访问 Cloudflare Worker 域名。

它仍然不能保证所有网络 100% 成功：

- Vercel 本身不可达时，页面和同源 HTTPS 信令都会失效；
- Vercel 到 Upstash 的服务端链路仍可能故障；
- TURN 凭据成功不等于已经取得 relay candidate；
- 信令完成后，最终 WebRTC 直连或 TURN 路径仍必须可达。

但与原先的单一 Supabase 客户端 WebSocket 相比，故障边界已经变得清晰：只要页面可达，并且 Supabase 或 Vercel HTTPS 至少一条信令可用，就可以开始 WebRTC 握手。
