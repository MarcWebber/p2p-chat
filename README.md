# TwoOnly

只允许两位参与者进入的双人加密聊天 MVP。两端使用同一条邀请链接，以完全对等的方式完成 WebRTC 协商；文字、图片和语音先在浏览器内使用 AES-GCM 加密，再通过 DataChannel 传输，聊天历史以密文保存在各自设备的 `localStorage`。

完整技术文档：

- [文档入口](docs/README.md)
- [WebRTC 与加密 P2P 实战分享](docs/field-guide.md)
- [VPS、Socket.IO、Vercel 和 TURN](docs/network-and-deployment.md)
- [项目最终复盘](docs/project-retrospective.md)
- [系统架构与文件结构](docs/architecture.md)
- [WebRTC、双工通道与加密](docs/webrtc-security.md)
- [TURN 配置手册](docs/turn-configuration.md)
- [常见问题与网络排障 FAQ](docs/faq.md)
- [Supabase + Vercel HTTPS 双活信令](docs/signaling-resilience.md)
- [Supabase、Vercel 与部署运维](docs/deployment-operations.md)

## 已实现

- 一条无角色邀请链接供两位参与者使用；旧 `role=host/guest` 参数不再决定建连，仅用于兼容旧历史方向
- 双方广播 Hello，并按 `participantId` 字符串顺序确定本轮临时 Offer 发起方
- 双方各自锁定另一位参与者，已有双人会话会拒绝第三个页面
- WebRTC 点对点数据通道
- AES-GCM 应用层二次加密和安全码
- 文字、1.5 MB 以内图片、语音消息
- 大消息分片传输
- 刷新后从本机密文恢复历史
- 消息方向使用 `self / peer`，每个标签页用 `sessionStorage` 记录本端发送过的消息 ID
- Supabase Realtime 与同源 Vercel HTTPS 双信令；任意一条可用即可握手，跨通道消息按 `signalId` 去重
- 连接中断后自动重新握手，并提供“立即重连”入口
- 按 `chat / crypto / signal / webrtc / storage / room / media / ui` 划分职责，客户端入口不再承载业务细节

## 本地运行

```bash
npm install
cp .env.example .env.local
npm run dev
```

至少配置 Supabase 或 Upstash HTTPS 信令中的一条；生产环境建议两条都配置。然后打开首页创建房间，再从第二个浏览器或设备打开邀请链接。

## 配置信令服务

在 Supabase 创建项目，从 Connect 面板取得 Project URL 和 publishable key，然后写入 `.env.local`：

```dotenv
NEXT_PUBLIC_SUPABASE_URL=https://YOUR_PROJECT.supabase.co
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=sb_publishable_xxx
```

Supabase Realtime 和同源 Vercel HTTPS 都只交换 SDP/ICE 等建连信令，聊天正文不经过它们。Supabase 路径使用 WebSocket；HTTPS 路径先在浏览器加密信令，再暂存到 Redis Stream。当前生产项目已经配置 Cloudflare TURN 短时凭证；自建部署仍应单独配置 TURN。

如需在客户端无法访问 Supabase 时继续握手，在 Vercel Marketplace 给项目连接一个 Upstash Redis。Marketplace 通常自动注入：

```dotenv
KV_REST_API_URL=https://YOUR_DATABASE.upstash.io
KV_REST_API_TOKEN=xxx
```

手工配置时也可以改用等价的 `UPSTASH_REDIS_REST_URL` 与 `UPSTASH_REDIS_REST_TOKEN`；两组不需要同时存在。

浏览器会同时使用 Supabase 和同源 `/api/signal`。HTTPS 队列中的 SDP/ICE 已使用邀请 fragment 派生的独立 AES-GCM 密钥加密，Redis 只保存最多 128 条、180 秒过期的临时密文信令。

## 部署到 Vercel

把 Vercel 项目的 Root Directory 指向 `twoonly`，连接 Upstash Marketplace、添加 Supabase 环境变量，并设置：

```dotenv
NEXT_PUBLIC_SITE_URL=https://your-domain.example
```

Next.js 构建命令和输出目录使用 Vercel 默认值即可。

## 当前 MVP 边界

- 历史记录只保留在各自设备，不会跨设备同步。
- 双方必须同时在线才能收到实时消息；离线时发送的消息只保留在发送方本机。
- “仅两个人”目前由双方页面内存中的运行时 peer lock 实现，不是服务端身份系统；页面全部关闭或锁失效后，席位不会被持久保存。
- 邀请链接的 URL fragment 包含会话秘密，拿到完整链接的人可能作为参与者加入。
- 当前已接入 Cloudflare TURN 短时凭证作为直连失败兜底；中国大陆稳定性仍需要独立的网络与部署方案。

正式版本应增加持久化成员公钥、一次性邀请核销、加密离线信箱、密钥恢复、DataChannel 背压和多地域 TURN 监控。
