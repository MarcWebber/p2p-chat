# TwoOnly

只允许房主和一位访客进入的双人加密聊天 MVP。文字、图片和语音先在浏览器内使用 AES-GCM 加密，再通过 WebRTC DataChannel 传输；聊天历史以密文保存在各自设备的 `localStorage`。

完整技术文档：

- [文档入口](docs/README.md)
- [系统架构与文件结构](docs/architecture.md)
- [WebRTC、双工通道与加密](docs/webrtc-security.md)
- [TURN 配置手册](docs/turn-configuration.md)
- [Supabase、Vercel 与部署运维](docs/deployment-operations.md)

## 已实现

- 一条邀请链接对应一个房主和一个访客角色
- 房主接纳第一位访客后拒绝后续连接
- WebRTC 点对点数据通道
- AES-GCM 应用层二次加密和安全码
- 文字、1.5 MB 以内图片、语音消息
- 大消息分片传输
- 刷新后从本机密文恢复历史
- 无远程配置时，使用 `BroadcastChannel` 在同一浏览器双标签页联调
- 配置 Supabase 后，使用 Realtime Broadcast 完成跨设备 WebRTC 信令
- 连接中断后自动重新握手，并提供“立即重连”入口
- 按 `chat / crypto / signal / webrtc / storage / room / media / ui` 划分职责，客户端入口不再承载业务细节

## 本地运行

```bash
npm install
cp .env.example .env.local
npm run dev
```

打开首页创建房间，然后在另一个标签页打开邀请链接。

## 开启跨设备连接

在 Supabase 创建项目，从 Connect 面板取得 Project URL 和 publishable key，然后写入 `.env.local`：

```dotenv
NEXT_PUBLIC_SUPABASE_URL=https://YOUR_PROJECT.supabase.co
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=sb_publishable_xxx
```

Supabase 只用于交换 SDP 和 ICE 信令，聊天内容不经过 Supabase。生产环境还应配置 TURN 服务，解决严格 NAT 或企业防火墙下无法直连的问题。

## 部署到 Vercel

把 Vercel 项目的 Root Directory 指向 `twoonly`，添加上面的两个 Supabase 环境变量，并设置：

```dotenv
NEXT_PUBLIC_SITE_URL=https://your-domain.example
```

Next.js 构建命令和输出目录使用 Vercel 默认值即可。

## 当前 MVP 边界

- 历史记录只保留在各自设备，不会跨设备同步。
- 双方必须同时在线才能收到实时消息；离线时发送的消息只保留在发送方本机。
- “仅两个人”目前由房主运行时连接锁实现，刷新房主页面后会重新开放访客槽位。
- 邀请链接的 URL fragment 包含会话秘密，拿到完整链接的人可能冒充访客。
- 当前使用公共 STUN，没有 TURN 兜底。

正式版本应增加持久化成员公钥、一次性邀请核销、加密离线信箱、密钥恢复和 TURN 服务。
