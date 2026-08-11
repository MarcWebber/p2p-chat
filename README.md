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
- [Supabase 不可达时的信令容灾方案](docs/signaling-resilience.md)
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
- 使用 Supabase Realtime Broadcast 完成跨设备 WebRTC 信令；缺少配置时明确报错，不做本地伪降级
- 连接中断后自动重新握手，并提供“立即重连”入口
- 按 `chat / crypto / signal / webrtc / storage / room / media / ui` 划分职责，客户端入口不再承载业务细节

## 本地运行

```bash
npm install
cp .env.example .env.local
npm run dev
```

配置 Supabase 后打开首页创建房间，再从第二个浏览器或设备打开邀请链接。

## 配置信令服务

在 Supabase 创建项目，从 Connect 面板取得 Project URL 和 publishable key，然后写入 `.env.local`：

```dotenv
NEXT_PUBLIC_SUPABASE_URL=https://YOUR_PROJECT.supabase.co
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=sb_publishable_xxx
```

Supabase 只用于交换 SDP 和 ICE 信令，聊天内容不经过 Supabase。当前生产项目已经配置 Cloudflare TURN 短时凭证，直连失败时可切换到加密中继；自建部署仍应单独配置 TURN。

## 部署到 Vercel

把 Vercel 项目的 Root Directory 指向 `twoonly`，添加上面的两个 Supabase 环境变量，并设置：

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
