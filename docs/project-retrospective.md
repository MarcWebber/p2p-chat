# TwoOnly 项目复盘：真正费时间的不是聊天框

这个项目从一个很小的想法开始：做一个可以快速部署、只允许两个人使用的 P2P 加密聊天，支持文字、图片、语音，还能在本机保留一点历史。

回头看，UI 和消息列表反而不是最难的部分。真正决定“能不能用”的，是信令能否恢复、TURN 是否真的走通、密钥是否留在正确边界，以及部署环境是否和本地一致。

## 最终交付是什么

当前生产地址：<https://twoonly-chat.vercel.app>

| 能力 | 最终状态 |
| --- | --- |
| 双人房间 | 房主锁定首位访客，第三人被拒绝 |
| 文字 / 图片 / 语音 | 已实现，媒体单条上限 1.5 MB |
| 实时链路 | WebRTC DataChannel |
| 信令 | Supabase Realtime Broadcast |
| NAT 穿透 | STUN + Cloudflare TURN 兜底 |
| 应用加密 | AES-GCM，每条消息独立 IV |
| 本地历史 | 每设备、每房间最多 200 条密文 |
| 断线恢复 | 自动重新握手 + 手动“立即重连” |
| 部署 | Next.js on Vercel，TURN Key 仅在服务端 |

## 项目是怎么一步步变得“可用”的

```mermaid
timeline
  title TwoOnly 演进
  最小原型 : 单页完成建房、邀请和 DataChannel
  可聊天 : 加入文字、图片、语音与本地密文历史
  可维护 : 从大型单文件拆成 chat / crypto / signal / webrtc / storage / ui
  可恢复 : 增加 negotiationId、信令队列和自动重新握手
  可跨网 : 接入 Supabase Realtime 信令
  可兜底 : 接入 Cloudflare TURN 短时凭证
  可部署 : 持久化 Vercel Production 环境变量并完成线上验收
```

### 第一阶段：能连上，不等于架构成立

最初所有逻辑放在一个大组件里，创建房间、加密、Supabase、PeerConnection、UI 和录音互相引用。它确实能快速验证想法，但任何连接状态变化都会穿过整份文件。

模块化重构以后，边界变成：

```mermaid
flowchart TD
  UI["src/ui"] --> CHAT["src/chat"]
  CHAT --> ROOM["src/room"]
  CHAT --> CRYPTO["src/crypto"]
  CHAT --> STORAGE["src/storage"]
  CHAT --> SIGNAL["src/signal"]
  CHAT --> WEBRTC["src/webrtc"]
  CHAT --> MEDIA["src/media"]
  WEBRTC --> PROTOCOL["src/protocol"]
```

最大的收益不是文件变短，而是可以准确说出：

- Signal 只传信令，不懂聊天正文；
- WebRTC 只传密文，不持有 AES 密钥；
- Storage 只存密文，不自行解密；
- UI 只调控制器，不直接操作 Supabase 和 PeerConnection。

详细基线见 [代码规模与复杂度](code-metrics.md)。`processSignal` 仍然是最复杂的函数，也是未来最值得继续按消息类型拆分的地方。

## 这次遇到的几个真实问题

### 1. 同一台电脑能用，外部用户不能用

同浏览器双标签页会走 `BroadcastChannel`，它只能证明本地信令适配器和 WebRTC 代码基本能跑，不能证明跨设备网络成立。

跨设备需要至少三件事同时正确：

1. Supabase URL 和 publishable key 进入生产构建；
2. Realtime Channel 真正订阅成功；
3. 两端网络能建立 WebSocket 并完成 ICE。

这次经验很直接：**本地双标签页不是跨网络 E2E。**以后验收必须明确区分本地静态检查、浏览器双标签页、不同设备、不同网络和生产环境。

### 2. 信令恢复了，双方却不会重新握手

WebSocket 自动重连只会恢复“联系渠道”，不会自动重建已经失败的 PeerConnection。最初缺少一套完整的重协商协议，导致断开后双方都在等对方先动。

最终修复包含：

- 访客恢复周期性 `hello`；
- 房主针对同一 senderId 重新生成 Offer；
- `createOffer({ iceRestart: true })`；
- 新协商生成新 `negotiationId`；
- 旧 Candidate 和旧 Answer 被过滤；
- 800 ms 自动重试和手动重连共用同一入口。

这件事说明：**重连不是某个按钮，而是一套双端一致的状态机。**

### 3. 配了 STUN，严格网络还是失败

STUN 只能帮忙发现映射，并不能保证 NAT 允许对端使用这个映射。没有 TURN 时，对称 NAT、企业防火墙和 UDP 受限网络仍然会失败。

项目后来增加 `/api/turn-credentials`，由 Vercel 服务端用 Cloudflare 长期 Token 生成短时凭证。浏览器拿到的是临时 `iceServers`，长期 Token 不进入前端包。

验证时没有只看“接口返回成功”，而是把 `iceTransportPolicy` 强制设为 `relay`，让两端都显示“TURN 加密中继”，再实际发送一条加密消息。这个测试把“有配置”提升成了“确实有流量走中继”。

### 4. 本地接口正常，线上却返回 403

Route Handler 最初用请求 URL 的内部 Origin 和浏览器 `Origin` 直接比较。在 Vercel 代理链路里，内部 host/protocol 与公开域名可能不同，于是同源请求被误杀。

修复方式不是关闭校验，而是根据 `x-forwarded-host`、`host`、`x-forwarded-proto` 重建公开 Origin，同时拒绝明确的 `cross-site` 请求。

这类问题的教训是：**部署平台上的请求经过代理，安全校验必须理解代理头，但也不能盲目信任任意客户端伪造的拓扑。**当前实现适合 Vercel 受控代理链路；若迁移到自管 Nginx，应重新确认可信代理边界。

### 5. 部署成功了，TURN 仍然是 503

第一次部署虽然 `READY`，但环境变量只是跟随某次部署上传，并没有持久保存到指定项目的 Production Environment。新 Function 找不到 `CLOUDFLARE_TURN_*`，因此正确地返回了 `turn_not_configured`。

最终在 `marcwebbers-projects/twoonly-chat` 中持久保存了：

- `CLOUDFLARE_TURN_KEY_ID`；
- `CLOUDFLARE_TURN_API_TOKEN`；
- Supabase URL；
- Supabase publishable key；
- 正式站点 URL。

随后强制生产部署，线上首页和 TURN 接口均为 200。旧部署的 503 仍会出现在一小时日志窗口里，所以排查日志时必须按 deployment ID 区分，而不能只看项目级时间范围。

### 6. Guest 显示已连接，Host 却卡在自动重连

这不是 TURN “只连通了一边”，而是客户端把一次瞬时 `RTCPeerConnection.disconnected` 立即写进 UI；连接在重连定时器触发前恢复后，定时器因为 DataChannel 仍为 `open` 而直接返回，却没有把 Host 状态恢复为 `connected`。

修复后，瞬时断开先进入 2.5 秒波动确认期；PeerConnection 或 DataChannel 恢复时统一清理重连定时器并重新标记连接成功，持续断开才创建新一轮协商。同时，TURN 状态改为读取实际选中的 Candidate Pair，而不是只要候选池中出现过 relay 就显示正在中继。

## 最终验收是怎么做的

```mermaid
flowchart LR
  STATIC["typecheck / build"] --> LOCAL["本地双标签页"]
  LOCAL --> RELAY["强制 TURN relay"]
  RELAY --> DEPLOY["Vercel Production"]
  DEPLOY --> HTTP["首页与 API 200"]
  HTTP --> LOGS["部署级日志无 error / warning / 5xx"]
```

最后一轮证据包括：

- TypeScript 检查通过；
- Next.js 生产构建通过；
- 本地房主和访客强制使用 TURN，双方显示中继模式；
- 加密测试消息成功到达对端；
- 生产首页 HTTP 200；
- 生产凭证接口 HTTP 200；
- 接口返回 2 组 ICE Server、6 个 TURN URL、约 24 小时 TTL；
- 当前生产 deployment 没有 error、warning 或 5xx；
- 仓库没有跟踪任何 Cloudflare 长期 Token。

这不等于“已经在全国所有运营商完成 SLA 级验证”。它证明的是：代码、生产配置、TURN API 和真实中继路径已经分别跑通。中国大陆稳定性仍需要真实地域与运营商测试。

## 安全边界：我们保护了什么

### 已经做到

- 聊天正文进入网络前先经过 AES-GCM；
- DataChannel 自身还有 DTLS；
- 本机历史只保存密文信封；
- 每条消息独立随机 IV；
- Cloudflare 长期 Token 只在 Vercel 服务端；
- URL Fragment 中的 secret 不随页面 HTTP 请求发送；
- 安全码可以通过另一个可信渠道人工核对。

### 没有做到

- 没有账号、设备公钥和签名身份；
- 完整邀请链接等同于加入能力和解密能力；
- 公共 Supabase topic 不是访问控制；
- 房主刷新会丢失运行时双人锁；
- 没有前向保密的应用层密钥轮换；
- 没有离线投递、跨设备历史或删除同步；
- TURN、Supabase 和网络运营者仍能观察 IP、连接时间和流量大小等元数据。

“端到端加密”不能只看算法名字，还要看密钥如何分发、身份如何确认、元数据谁能看到。TwoOnly 当前更准确的描述是：**共享随机会话秘密驱动的应用层加密 P2P 聊天 MVP。**

## 如果继续开发，优先级应该是什么

项目在这里结束，但如果未来重新打开，我会按这个顺序继续：

1. 私有信令频道、一次性邀请和设备公钥；
2. DataChannel 背压、二进制媒体和更严格的分片边界；
3. TURN 多地域与连接成功率监控；
4. 加密离线信箱和消息确认；
5. 大陆合规托管、自有域名和三网实测；
6. 再考虑更丰富的 UI、表情和文件能力。

原因很简单：一款聊天工具最先要保证的是“连得上、连回来、发得出、看不见”，而不是按钮更多。

## 最后的结论

TwoOnly 没有试图成为一个完整即时通讯产品。它完成的是一条很清楚的技术闭环：

```text
邀请链接
→ 托管信令
→ ICE / STUN / TURN
→ WebRTC 双工 DataChannel
→ 浏览器本地 AES-GCM
→ 本地密文历史
→ 断线后重新握手
→ Vercel 生产部署
```

它最有价值的部分，不是某一段 API 调用，而是这些边界在真实部署和故障中都被走过一遍。到这里，这个项目可以正式收尾了。
