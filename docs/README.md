# TwoOnly 技术文档

TwoOnly 是一个纯浏览器双人加密聊天项目。网页由 Next.js 构建并部署到 Vercel；Supabase Realtime 与同源 Vercel HTTPS 共同交换 WebRTC 建连信令；文字、图片、语音和 Beta 文件经浏览器本地 AES-GCM 加密后，通过 WebRTC DataChannel 传输。常规消息以密文保存在各自设备的 IndexedDB，大附件只在当前页面保留。

## 推荐阅读顺序

如果你想从原理一直读到实战收尾，建议按下面三篇走：

1. [从一条邀请链接到一条加密 P2P 通道](field-guide.md)：用 TwoOnly 串起信令、ICE、STUN、TURN、DataChannel、AES-GCM、本地历史和重连。
2. [VPS、Socket.IO、Vercel 和 TURN](network-and-deployment.md)：解释常驻 Node 服务、托管信令、平台 Function 和中继服务分别适合放什么。
3. [TwoOnly 项目复盘](project-retrospective.md)：记录模块化过程、真实故障、生产部署、验收证据和项目边界。
4. [常见问题与网络排障 FAQ](faq.md)：回答“开了 TURN 为什么还失败”，并给出从凭证、relay candidate、选中路径到双向流量的完整证据链。

这组文档偏经验分享，代码很少，流程图比较多。想直接查配置或实现细节，再进入下面的专题手册。

## 专题手册

- [系统架构与文件结构](architecture.md)：组件边界、消息流、双人限制和源码目录。
- [代码规模与复杂度基线](code-metrics.md)：当前行数、目录分布、复杂度代理和重复统计方法。
- [WebRTC、双工通道与加密](webrtc-security.md)：Offer/Answer、ICE、STUN/TURN、DataChannel、AES-GCM、分片、威胁边界。
- [TURN 配置手册](turn-configuration.md)：托管服务和 Coturn 自建方式、端口、证书、Vercel 环境变量与验收。
- [常见问题与网络排障 FAQ](faq.md)：TURN 可达性、两端状态不一致、重连、国内网络和常见产品边界。
- [Supabase + Vercel HTTPS 双活信令](signaling-resilience.md)：两条信令、Redis Stream、去重和验收矩阵。
- [Supabase、Vercel 与部署运维](deployment-operations.md)：环境变量、Supabase 配置、Vercel 部署、测试和国内访问方案。

## 一张图看懂

![TwoOnly 架构总览](assets/twoonly-architecture-overview.png)

图片负责快速建立空间感和排障顺序；发生差异时，以源码和专题手册为准。

## 当前实现摘要

| 项目 | 当前实现 |
| --- | --- |
| 前端 | Next.js 16、React 19、TypeScript 5 |
| 实时数据 | WebRTC `RTCDataChannel`，可靠且按序 |
| 信令 | Supabase Realtime Broadcast + Vercel `/api/signal` HTTPS 短轮询；任意一条可用即可握手 |
| 协商协议 | protocol v3；所有信令带每房间 P-256 ECDSA 成员签名，participant ID 只确定临时 Offer 发起方，epoch + negotiation ID 隔离重连轮次 |
| 应用层加密 | Web Crypto API，随机会话秘密经 SHA-256 导入为 AES-GCM 密钥，每条消息使用独立 12 字节 IV |
| 本机恢复 | IndexedDB 按 `roomId` 唯一保存房间秘密、成员公私钥、对端公钥和 `{id, iv, data}` 密文；自动恢复全部房间，每个房间最多 200 条 |
| 双人席位 | 创建者公钥位于邀请 Fragment；首个验签接收者原子占第二席位，此后断线或空房都不允许陌生公钥替换 |
| 多聊天 | 每个已保存房间拥有独立信令和 WebRTC 运行时；切换界面不会释放其他房间连接 |
| 消息类型 | 文字、语音、最大 100 MB 图片、最大 100 MB Beta 文件；支持剪贴板复制粘贴 |
| 资料同步 | 最新昵称和头像通过 AES-GCM 加密控制帧同步，并作为历史消息显示覆盖层，不重写历史密文 |
| 大消息处理 | 大附件按 192 KB 分块独立加密；密文包按 12,000 字符分片，并按 DataChannel 高低水位执行背压 |
| 部署 | Vercel 页面、同源 HTTPS 信令与 Cloudflare TURN 凭证接口；Supabase 同时提供 WebSocket 信令 |

## 必须理解的边界

- “P2P”指聊天负载优先由两个浏览器直接传输。若配置 TURN 且直连失败，数据会经过 TURN 中继，但仍由 WebRTC 传输层和应用层 AES-GCM 保护。
- Supabase 看不到聊天正文，但会处理房间 topic、SDP、ICE Candidate 等建连元数据；Vercel HTTPS 队列只保存由邀请密钥加密后的临时信令。
- 历史只在本机，双方离线时没有服务器信箱，也不会跨设备同步。
- “只允许两个人”由每房间成员公钥实现：创建者公钥在 `#secret=…&owner=…` 邀请 Fragment 中，首个验签接收者占第二席位；`PeerLock` 只处理同一合法成员的页面实例和 epoch。页面全部关闭、断线或超时都不会转让席位。
- 拿到完整邀请链接的人拥有会话秘密，并可能在第二席位尚未确认时抢先占位。席位锁定后，只有原两把成员私钥能继续签名进入；请仍通过可信渠道分享，并在双方页面核对安全码。
- 成员私钥保存在本机 IndexedDB。清理站点数据、删除房间或换设备会丢失席位凭证；旧邀请不能恢复已锁定的成员，目前没有密钥迁移或账号找回。
- TwoOnly 不读取 MAC、deviceId 或浏览器指纹，也没有账号、全局设备身份或跨设备身份。旧记录没有历史成员证据；仍保存该旧房间的端点中，最先完成 v3 相互验签的两端会被固化，无法证明它们就是最初两人。无本地记录的新浏览器会拒绝缺少 `owner` 的旧式链接。
- Cloudflare TURN key 和 API token 只保存在 Vercel 服务端；浏览器按页面会话获取 24 小时临时凭证。
- TURN 解决 NAT/防火墙穿透，不等于中国大陆网络保障；网页、Supabase WebSocket 和 Cloudflare TURN 仍需分别实测。

## 官方参考

- [WebRTC Peer Connection 入门](https://webrtc.org/getting-started/peer-connections)
- [W3C WebRTC 规范](https://www.w3.org/TR/webrtc/)
- [W3C Web Crypto API](https://www.w3.org/TR/WebCryptoAPI/)
- [Supabase Realtime Broadcast](https://supabase.com/docs/guides/realtime/broadcast)
- [Vercel 环境变量](https://vercel.com/docs/environment-variables)
- [Socket.IO 工作原理](https://socket.io/docs/v4/how-it-works/)
- [Cloudflare TURN 短时凭证](https://developers.cloudflare.com/realtime/turn/generate-credentials/)
