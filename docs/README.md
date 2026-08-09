# TwoOnly 技术文档

TwoOnly 是一个纯浏览器双人加密聊天项目。网页由 Next.js 构建并部署到 Vercel；Supabase Realtime 只负责让两个浏览器交换 WebRTC 建连所需的信令；文字、图片和语音经浏览器本地 AES-GCM 加密后，通过 WebRTC DataChannel 传输，并以密文保存在各自设备的 `localStorage`。

## 文档导航

- [系统架构与文件结构](architecture.md)：组件边界、消息流、双人限制和源码目录。
- [WebRTC、双工通道与加密](webrtc-security.md)：Offer/Answer、ICE、STUN/TURN、DataChannel、AES-GCM、分片、威胁边界。
- [TURN 配置手册](turn-configuration.md)：托管服务和 Coturn 自建方式、端口、证书、Vercel 环境变量与验收。
- [Supabase、Vercel 与部署运维](deployment-operations.md)：环境变量、Supabase 配置、Vercel 部署、测试和国内访问方案。

## 当前实现摘要

| 项目 | 当前实现 |
| --- | --- |
| 前端 | Next.js 16、React 19、TypeScript 5 |
| 实时数据 | WebRTC `RTCDataChannel`，可靠且按序 |
| 信令 | Supabase Realtime Broadcast；无配置时回退到同浏览器 `BroadcastChannel` |
| 应用层加密 | Web Crypto API，随机会话秘密经 SHA-256 导入为 AES-GCM 密钥，每条消息使用独立 12 字节 IV |
| 历史记录 | 每台设备的 `localStorage`，仅保存 `{id, iv, data}` 密文，最多 200 条 |
| 消息类型 | 文字、图片、语音；图片/语音单条上限 1.5 MB |
| 大消息处理 | 加密后 JSON 按 12,000 字符分片，在接收端重组并解密 |
| 部署 | Vercel 静态预渲染；Supabase 新加坡区提供 WebSocket 信令 |

## 必须理解的边界

- “P2P”指聊天负载优先由两个浏览器直接传输。若配置 TURN 且直连失败，数据会经过 TURN 中继，但仍由 WebRTC 传输层和应用层 AES-GCM 保护。
- Supabase 看不到聊天正文，但会处理房间 topic、SDP、ICE Candidate 等建连元数据。
- 历史只在本机，双方离线时没有服务器信箱，也不会跨设备同步。
- “只允许两个人”是当前房主页面生命周期内的连接锁，不是账号身份系统。房主刷新后访客槽位会重新开放。
- 拿到完整邀请链接的人拥有会话秘密，可能冒充访客。请通过可信渠道分享，并在双方页面核对安全码。
- 当前生产配置只有公共 STUN，没有 TURN，因此部分严格 NAT、企业网络或跨境网络仍可能无法连接。

## 官方参考

- [WebRTC Peer Connection 入门](https://webrtc.org/getting-started/peer-connections)
- [W3C WebRTC 规范](https://www.w3.org/TR/webrtc/)
- [W3C Web Crypto API](https://www.w3.org/TR/WebCryptoAPI/)
- [Supabase Realtime Broadcast](https://supabase.com/docs/guides/realtime/broadcast)
- [Vercel 环境变量](https://vercel.com/docs/environment-variables)
