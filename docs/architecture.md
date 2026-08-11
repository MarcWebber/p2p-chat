# 系统架构与文件结构

![TwoOnly 架构总览](assets/twoonly-architecture-overview.png)

这张图用于快速理解组件位置；下方 Mermaid 图用于准确表达数据流。总览图由 OpenAI ImageGen 生成。

## 1. 总体架构

```mermaid
flowchart LR
  subgraph A["浏览器 A"]
    AUI["聊天 UI"]
    AC["AES-GCM 加密/解密"]
    AP["RTCPeerConnection + DataChannel"]
    AL["localStorage 密文历史"]
    AUI --> AC
    AC --> AP
    AC --> AL
  end

  subgraph S["建连基础设施"]
    SB["Supabase Realtime Broadcast"]
    ICE["STUN / 可选 TURN"]
  end

  subgraph B["浏览器 B"]
    BP["RTCPeerConnection + DataChannel"]
    BC["AES-GCM 加密/解密"]
    BUI["聊天 UI"]
    BL["localStorage 密文历史"]
    BP --> BC
    BC --> BUI
    BC --> BL
  end

  AP <-->|"加密聊天负载"| BP
  AP -. "SDP / ICE 信令" .-> SB
  SB -. "SDP / ICE 信令" .-> BP
  AP -. "候选地址发现 / 必要时中继" .-> ICE
  BP -. "候选地址发现 / 必要时中继" .-> ICE
```

Vercel 提供静态网页与资源，并通过 `/api/turn-credentials` 用服务端 Cloudflare Token 生成短时 TURN 配置。该 Function 不接收聊天正文。Supabase 只在 WebRTC 建连阶段交换信令；连接成功后，应用消息走 DataChannel，代码不会把聊天正文写入 Supabase Database、Storage 或 Vercel Function。

## 2. 运行时组件

### Next.js 页面层

- `app/layout.tsx`：页面元数据、Open Graph 分享图、站点基础 URL。
- `app/page.tsx`：渲染唯一的聊天客户端组件。
- `app/globals.css`：启动页、桌面聊天、移动端聊天、连接状态和操作反馈样式。

页面本身可静态预渲染；TURN credential Route Handler 按请求动态运行。WebRTC、Web Crypto、录音、文件读取和本地存储仍全部在浏览器端执行。

### 聊天客户端

`components/TwoOnlyApp.tsx` 现在只是客户端边界：调用聊天控制器，再把结果交给 UI。具体职责拆分如下：

| 模块 | 职责 | 不负责 |
| --- | --- | --- |
| `src/chat` | 领域类型、React 状态和用例编排 | WebRTC/Supabase 的底层细节 |
| `src/crypto` | 随机值、安全码、AES-GCM 加解密 | 保存历史、发送网络消息 |
| `src/diagnostics` | 建连日志、脱敏、内存环形缓冲和 Console 输出 | 持久化日志、记录密钥或消息内容 |
| `src/signal` | 信令类型校验、Supabase/BroadcastChannel 适配 | 聊天正文、PeerConnection 生命周期 |
| `src/webrtc` | Offer/Answer、ICE、DataChannel、重连和密文分片传输 | React UI、本地历史 |
| `src/storage` | `localStorage` 密文历史、`sessionStorage` 本标签发送消息 ID | 加解密、Supabase Database/Storage |
| `src/room` | 无角色邀请链接的解析、生成与旧链接兼容 | 连接状态机 |
| `src/media` | 文件 Data URL、文件限制、录音生命周期 | 消息加密和发送 |
| `src/protocol` | 密文信封的分片编码、重组和协议格式 | 网络连接、明文消息 |
| `src/ui` | 首页、聊天页和展示组件 | 直接访问 Supabase、WebRTC 或浏览器存储 |

这里特别需要区分：Supabase 当前只提供 Realtime Broadcast 信令，不保存聊天消息，因此它属于 `signal`，不是 `storage`。`storage` 只封装当前浏览器内的持久化。

## 3. 邀请链接与页面身份

任意一端创建聊天时生成两个随机值：

```text
roomId = randomToken(9)      # Supabase topic 标识
secret = randomToken(32)     # 约 256 位随机会话秘密
```

邀请链接格式：

```text
https://站点/?room=<roomId>#<secret>
```

- `room` 用于选择信令 topic：`twoonly:<roomId>`。
- `secret` 放在 URL Fragment 中，浏览器不会把 Fragment 作为 HTTP 请求路径发送给 Vercel；客户端脚本从 `window.location.hash` 读取它并派生 AES 密钥。
- 两端显示从同一 `secret` 计算出的安全码，用户可通过另一个可信渠道核对。
- 每次页面加载都会生成新的随机 `participantId`。它用于本次页面的信令寻址和 Offer 发起方选举，不是账号或长期设备身份。

旧版曾生成 `?room=<roomId>&role=host#<secret>` 与 `role=guest` 链接。v2 仍会解析这两种链接以恢复已有本地历史，但 `role` 只作为旧消息方向迁移提示，不再决定谁发送 Offer 或创建 DataChannel；新复制的链接不再包含该参数。

## 4. “只允许两个人”的实现

每个页面实例生成随机 `participantId`，并在 Supabase 订阅成功后周期性广播 protocol v2 `hello`。双方收到对方 Hello 后各自在内存中锁定同一个 peer，并通过 `participantId` 字符串比较得到一致结论：较小 ID 是本轮临时 Offer 发起方，同时创建 DataChannel；另一端处理 Offer 并返回 Answer。连接打开后，两端能力完全相同，没有长期房主或访客角色。

信令同时携带 `fromEpoch`、面向对端的 `toEpoch` 和每轮随机 `negotiationId`。本端重连时递增 local epoch；收到对方更大的 remote epoch 时关闭旧 Peer 并进入新轮次。Answer 和 Candidate 必须同时命中参与者、双方 epoch 与 negotiation ID；远端描述尚未就绪时，Candidate 也按这组键分桶缓存，避免旧轮次污染新连接。

第三个页面广播 Hello 时，两个已连接页面都会因为 peer lock 已被占用而回复 `rejected(room-full)`。DataChannel 已打开时不会因超时让位；只有通道没有打开，并且旧 Peer 已明确失败/关闭，或连续 10 秒没有旧 peer 信令时，锁才允许新的页面实例接替。这是一种运行时恢复策略，不是服务端成员认证。

这能满足临时双人房间的 MVP 需求，但有三个明确限制：

1. 锁分别存在两个页面的内存中；页面全部关闭后没有持久成员席位。
2. 没有账号或公钥身份，拿到完整链接并先完成互锁的页面占用位置。
3. 公共 Broadcast topic 不是访问控制；随机 `roomId` 和邀请秘密降低误入概率，但不是认证机制。
4. 三个页面近同时首次进入时，可能因 Hello 到达顺序不同形成临时非对称锁；当前没有服务端成员槽仲裁，需关闭多余页面后重连。

若要升级为严格的双人产品，应增加一次性邀请核销、持久化成员公钥、签名握手和私有 Realtime Channel 授权。

## 5. 状态与生命周期

连接状态为 `waiting → connecting → connected`，失败或关闭后进入 `disconnected`。新建聊天会同时清理：

- 旧 PeerConnection 与 DataChannel；
- 对方身份锁、local/remote epoch、协商 ID、已处理 Offer 和按轮次缓存的 ICE；
- 未完成消息分片、输入框和当前消息列表；
- 连接模式和提示状态。

`WebRtcSession` 现在使用单一 `phase`（idle / discovering / negotiating / connected / full / disposed）表达主生命周期，而不是让十几个布尔值互相组合。对端身份收敛为一条 `PeerLock`，本轮 Offer/Answer 收敛为一条 `Negotiation`，三个定时器统一放在 `Timers` 中；重连或换届时通过一个入口清理 Peer、协商和 Candidate 缓存。PeerConnection、DataChannel 与异步 SDP 回调仍会检查自己是否属于当前协商，避免旧实例污染新房间。

诊断日志统一经过 `trace(stage, code, message, options)`，连接状态和用户提示统一经过 `show(...)`。这两个入口保留了完整排障证据链，但删除了散落在主流程里的重复日志对象。Candidate 解析和最终 Candidate Pair 统计移到纯函数模块 `rtcStats.ts`，不再挤占会话状态机。

聊天消息中的 `author` 使用 `self / peer`，只表达当前标签页的 UI 方向。每次发送时，本标签页把消息 ID 追加到 `sessionStorage` 的 `twoonly:<roomId>:sent-message-ids:v2`；刷新后先解密 `localStorage` 历史，再用这份 ID 列表恢复“我/对方”。旧版密文里的 `host / guest` author 仍能借助旧 URL role 提示迁移读取，但不会再写入新消息。

## 6. 文件结构

```text
twoonly/
├── app/
│   ├── api/turn-credentials/
│   │   └── route.ts                # Cloudflare TURN 短时凭据与请求追踪
│   ├── globals.css                 # 全局与响应式 UI
│   ├── layout.tsx                  # 元数据和根布局
│   └── page.tsx                    # 首页入口
├── components/
│   └── TwoOnlyApp.tsx              # 10 行客户端入口
├── src/
│   ├── chat/
│   │   ├── types.ts                # 聊天领域类型
│   │   └── useTwoOnlyChat.ts       # 状态与用例协调器
│   ├── crypto/
│   │   └── messageCrypto.ts        # 随机值、安全码、AES-GCM
│   ├── diagnostics/
│   │   └── connectionDiagnostics.ts # 脱敏建连日志与内存缓冲
│   ├── media/
│   │   ├── files.ts                # 文件限制与 Data URL
│   │   └── useAudioRecorder.ts     # 录音生命周期
│   ├── protocol/
│   │   └── wireProtocol.ts         # 密文分片编码与重组
│   ├── room/
│   │   └── invitation.ts           # 房间 URL 与邀请链接
│   ├── signal/
│   │   ├── types.ts                # 信令协议与结构校验
│   │   └── signalTransport.ts      # Supabase/本地信令适配器
│   ├── storage/
│   │   └── chatStorage.ts          # 密文历史与本标签发送消息 ID
│   ├── ui/
│   │   ├── TwoOnlyView.tsx         # 页面状态分流
│   │   ├── LandingScreen.tsx       # 首页与 Wiki
│   │   ├── ChatScreen.tsx          # 聊天页组合
│   │   ├── ChatHeader.tsx          # 状态与房间操作
│   │   ├── ConnectionDiagnosticsPanel.tsx # 六阶段连接诊断面板
│   │   ├── ChatSidebar.tsx         # 当前会话摘要
│   │   ├── MessageList.tsx         # 消息展示
│   │   ├── MessageComposer.tsx     # 文字/图片/语音输入
│   │   └── formatters.ts           # UI 格式化
│   └── webrtc/
│       ├── WebRtcSession.ts        # Peer、握手、重连状态机
│       ├── iceConfig.ts            # STUN/TURN 配置
│       └── rtcStats.ts             # Candidate 摘要与选中路径统计
├── docs/
│   ├── README.md                   # 文档索引
│   ├── field-guide.md              # WebRTC 原理与项目实战主线
│   ├── network-and-deployment.md   # VPS、Socket.IO 与部署选择
│   ├── project-retrospective.md    # 故障、验收与最终复盘
│   ├── architecture.md             # 本文
│   ├── code-metrics.md             # 代码规模和复杂度基线
│   ├── deployment-operations.md    # Supabase/Vercel/运维
│   ├── turn-configuration.md       # TURN 配置
│   ├── faq.md                      # 常见问题与连接排障
│   ├── webrtc-security.md          # 通道与安全实现
│   └── assets/
│       └── twoonly-architecture-overview.png
├── public/
│   ├── og.jpg                      # 分享卡片
│   └── og.png                      # 分享卡片源图
├── .env.example                    # 环境变量模板
├── next.config.ts                  # Next.js 配置
├── package.json                    # 依赖与命令
├── package-lock.json               # 锁定后的依赖树
├── tsconfig.json                   # TypeScript 配置
└── README.md                       # 项目说明
```

## 7. 依赖方向与扩展规则

```mermaid
flowchart TD
  UI["UI"] --> CHAT["Chat Controller"]
  CHAT --> ROOM["Room"]
  CHAT --> CRYPTO["Crypto"]
  CHAT --> STORAGE["Storage"]
  CHAT --> SIGNAL["Signal Transport"]
  CHAT --> WEBRTC["WebRTC Session"]
  CHAT --> MEDIA["Media"]
  WEBRTC --> SIGNAL_TYPES["Signal Types"]
  WEBRTC --> PROTOCOL["Wire Protocol"]
```

后续开发应保持以下边界：

- UI 只能调用控制器暴露的状态和动作，不直接操作 `RTCPeerConnection`、Supabase 或浏览器存储；
- Signal 只传递并校验信令结构，不依赖具体 UI；
- WebRTC 只传输 `EncryptedWire`，不持有 AES 密钥或明文消息；
- Storage 只保存密文信封，不自行加解密；
- Crypto 的密钥实例绑定单个房间秘密，不能跨房间复用；
- 当前 Signal protocol v2 只做结构、版本、目标 ID、epoch 与协商轮次校验，没有数字签名。未来增加信令认证时，应在 Crypto 中增加独立的 HMAC/签名模块，而不是把它伪装成已有能力。
