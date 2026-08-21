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
    AL["IndexedDB 房间与密文历史"]
    AUI --> AC
    AC --> AP
    AC --> AL
  end

  subgraph S["建连基础设施"]
    SB["Supabase Realtime Broadcast"]
    VH["Vercel HTTPS /api/signal"]
    RS["Redis Stream 临时密文队列"]
    ICE["STUN / 可选 TURN"]
    VH --> RS
  end

  subgraph B["浏览器 B"]
    BP["RTCPeerConnection + DataChannel"]
    BC["AES-GCM 加密/解密"]
    BUI["聊天 UI"]
    BL["IndexedDB 房间与密文历史"]
    BP --> BC
    BC --> BUI
    BC --> BL
  end

  AP <-->|"加密聊天负载"| BP
  AP -. "SDP / ICE 信令" .-> SB
  SB -. "SDP / ICE 信令" .-> BP
  AP -. "AES-GCM 密文信令" .-> VH
  VH -. "AES-GCM 密文信令" .-> BP
  AP -. "候选地址发现 / 必要时中继" .-> ICE
  BP -. "候选地址发现 / 必要时中继" .-> ICE
```

Vercel 提供静态网页与资源，通过 `/api/turn-credentials` 生成短时 TURN 配置，并通过 `/api/signal` 提供同源 HTTPS 信令。Supabase 与 HTTPS 在 WebRTC 建连阶段双活；HTTPS payload 先由浏览器用邀请密钥加密，Redis 最多保留约 128 条并在 180 秒后过期。连接成功后，应用消息走 DataChannel，聊天正文不会写入 Supabase、Redis 或 Vercel Function。

## 2. 运行时组件

### Next.js 页面层

- `app/layout.tsx`：页面元数据、Open Graph 分享图、站点基础 URL。
- `app/page.tsx`：渲染唯一的聊天客户端组件。
- `app/globals.css`：启动页、桌面聊天、移动端聊天、连接状态和操作反馈样式。

页面本身可静态预渲染；TURN credential 与 HTTPS signal Route Handler 按请求动态运行。WebRTC、Web Crypto、录音、文件读取和本地存储仍全部在浏览器端执行。

### 聊天客户端

`components/TwoOnlyApp.tsx` 现在只是客户端边界：调用聊天控制器，再把结果交给 UI。具体职责拆分如下：

| 模块 | 职责 | 不负责 |
| --- | --- | --- |
| `src/config` | 产品策略、公开环境配置、服务端环境配置 | 业务流程、网络请求、UI 状态 |
| `src/chat` | 领域类型、React 状态和用例编排 | WebRTC/Supabase 的底层细节 |
| `src/crypto` | 随机值、安全码、AES-GCM 加解密 | 保存历史、发送网络消息 |
| `src/diagnostics` | 建连日志、脱敏、内存环形缓冲和 Console 输出 | 持久化日志、记录密钥或消息内容 |
| `src/signal` | 信令校验、Supabase/HTTPS 适配、双发去重和短时 Redis Stream | 聊天正文、PeerConnection 生命周期 |
| `src/server` | Route Handler 共用的同源请求校验 | 浏览器状态、房间密钥 |
| `src/webrtc` | Offer/Answer、ICE、DataChannel、发送背压、重连和 ICE Server 规范化 | React UI、本地历史 |
| `src/storage` | IndexedDB 房间目录、成员凭证、密文历史与本机消息方向 | 加解密、Supabase Database/Storage |
| `src/room` | 邀请链接和每房间 P-256 成员身份 | 连接状态机、账号身份 |
| `src/media` | 录音生命周期 | 消息加密、通用浏览器文件转换 |
| `src/protocol` | 密文信封分片、附件分块、资料同步、重组和协议格式 | 网络连接、React 状态 |
| `src/ui` | 首页、聊天页和展示组件 | 直接访问 Supabase、WebRTC 或浏览器存储 |
| `src/utils` | 剪贴板、Data URL、时间/容量格式、短 ID 和通用类型守卫 | 领域状态、网络策略、服务端秘密 |

这里特别需要区分：Supabase 和 Redis 都只承担建连信令，不保存聊天消息，因此属于 `signal`，不是聊天 `storage`。`storage` 只封装当前浏览器内的持久化。

### 配置边界

配置分为三层，避免业务代码直接散读环境变量：

- `config/policy.ts` 是环境无关的产品策略，集中保存附件上限、存储容量、协议版本、RTC 超时、Candidate 缓存上限和资源命名；
- `config/publicRuntime.ts` 只解析 `NEXT_PUBLIC_*`，生成可进入浏览器包的 Supabase 与静态 ICE 配置；
- `config/serverRuntime.ts` 以 `server-only` 标记，保存站点地址、Cloudflare TURN Key/Token 和 Upstash REST 凭据。客户端模块一旦误引入它，Next.js 会在构建期报错。

配置只描述值和环境，不执行握手或请求。通用行为放在 `utils`，ICE 领域行为放在 `webrtc/iceServers.ts`。例如服务端 TURN Route 与浏览器凭据解析现在共用 `normalizeIceServer` / `hasTurnServer`，不会再各维护一套校验规则。

## 3. 邀请链接与页面身份

创建聊天时生成两个随机值和一对仅属于该房间的 P-256 ECDSA 密钥：

```text
roomId = randomToken(9)      # Supabase topic 标识
secret = randomToken(32)     # 约 256 位随机会话秘密
memberKeyPair = P-256 ECDSA  # 创建者在这个房间的成员身份
```

邀请链接格式：

```text
https://站点/?room=<roomId>#secret=<secret>&owner=<ownerPublicKey>
```

- `room` 用于选择 Supabase topic 和 Redis Stream：`twoonly:<roomId>` / `twoonly:https-signal:<roomId>`。
- `secret` 和创建者公钥 `owner` 都放在 URL Fragment 中。浏览器不会把 Fragment 作为 HTTP 请求路径发送给 Vercel；客户端脚本从 `window.location.hash` 读取 `secret` 并派生 AES 密钥，用 `owner` 预先限定对端成员。
- 两端显示从同一 `secret` 计算出的安全码，用户可通过另一个可信渠道核对。
- 每个房间的成员公钥、可导出的私钥材料和已确认对端公钥保存在本机 IndexedDB；`memberId` 由成员公钥计算。它们只标识“本浏览器在这个房间的席位”，不是账号、MAC、浏览器指纹或跨设备身份。
- 每次页面加载仍会生成新的随机 `participantId`。它只用于本次页面的信令寻址和 Offer 发起方选举；同一个持久成员刷新页面后会得到新的 `participantId`，但继续使用原房间成员密钥。

解析器只读取 `room` 以及 fragment 中的 `secret`、`owner`。旧式 `#<secret>` 链接仍可解析，但没有本地已保存房间记录的新浏览器会拒绝这类缺少创建者公钥的邀请，避免两名后来者复用旧房间。URL 中的 `role` 等其他参数不会进入邀请对象，也不会影响谁发送 Offer、创建 DataChannel 或恢复消息方向。

## 4. “只允许两个人”的实现

每个页面实例生成随机 `participantId`，并在 Supabase 或 HTTPS 至少一条信令可用后周期性广播 Signal protocol v3 `hello`。Hello、Offer、Answer、Candidate 和 Rejected 都携带成员公钥、由公钥派生的 `memberId`，以及对房间 ID、会话秘密与稳定信令内容所作的 P-256 ECDSA 签名；无法验签的信令在进入 PeerLock 和 WebRTC 状态机前即被忽略。同一信令还携带 `signalId` 并发送到所有通道，重复到达时在进入状态机前丢弃。

创建者在收到首个有效但尚未登记的成员信令时，以 IndexedDB 单个读写事务原子确认第二席位；之后两个端点各自保存自己的私钥材料和对端公钥。后续只有这两把成员公钥签出的信令能进入协商。双方再通过页面级 `participantId` 字符串比较得到一致结论：较小 ID 是本轮临时 Offer 发起方，同时创建 DataChannel；另一端处理 Offer 并返回 Answer。连接打开后，两端能力完全相同，`owner` 只承担初次邀请的信任锚，不形成长期 UI 权限角色。

信令同时携带 `fromEpoch`、面向对端的 `toEpoch` 和每轮随机 `negotiationId`。本端重连时递增 local epoch；收到对方更大的 remote epoch 时关闭旧 Peer 并进入新轮次。Answer 和 Candidate 必须同时命中参与者、双方 epoch 与 negotiation ID；远端描述尚未就绪时，Candidate 也按这组键分桶缓存，避免旧轮次污染新连接。

第三个成员广播 Hello 时，已锁定房间会在验签后发现其公钥不属于两个席位，并回复签名的 `rejected(member-locked)`。断线、空房、页面关闭或 PeerLock 超时都不会转让成员席位；原来的两个成员仍可凭 IndexedDB 中的房间私钥重新进入。

`PeerLock` 仍然存在，但只处理同一合法成员可能同时出现的页面实例、epoch 和协商轮次。旧页面失败或超时后，新页面实例可以接替连接；Membership 不会因此接受一把新公钥。

这套约束不依赖中心成员数据库，但仍有四个明确边界：

1. 第二席位尚未确认前，拿到完整邀请链接的人仍可能抢先成为首个验签接收者；原子写入解决本机并发覆盖，不是服务端全局邀请核销。
2. 成员私钥是 IndexedDB 中的本地可导出材料，不是硬件安全密钥。清除站点数据、删除该房间或换设备都会丢失本机席位凭证；仅凭旧邀请链接不能恢复已经锁定的席位。
3. 不读取或保存 MAC、deviceId、浏览器指纹，也没有账号和跨设备身份。要迁移席位必须另行实现安全的密钥导出/导入或账号恢复，本版本没有该能力。
4. 公共 Broadcast topic 不是私有订阅授权。成员签名阻止陌生公钥进入 WebRTC 协商，但知道 `roomId` 的客户端仍可能观察信令元数据或制造可用性干扰。

旧版本保存的房间没有成员密钥或历史身份凭据。升级后，每个仍保存该房间的端点会生成成员密钥；最先完成 v3 相互验签的两个已保存端点会确定创建者和第二成员并固化两席，但系统无法证明它们就是最初创建、加入的两人。没有对应 IndexedDB 房间记录的新浏览器不能使用缺少 `owner` 的旧邀请链接加入。

## 5. 状态与生命周期

每个房间的连接状态都是 `waiting → connecting → connected`，失败或关闭后进入 `disconnected`。聊天控制器按 `roomId` 保存一组 `RoomRuntime`；每个运行时独立持有随机页面级 `participantId`、房间成员身份、消息加密器、信令传输、`WebRtcSession`、消息和诊断状态。IndexedDB 的 `rooms` object store 继续以 `roomId` 为唯一键，保存会话秘密、成员密钥与对端公钥，但不生成或保存 MAC、deviceId 或浏览器指纹。

页面启动时会为全部已保存房间创建运行时。侧栏切换只更新当前展示的 `activeRoomId`、URL 和输入状态，不销毁其他房间的 PeerConnection、DataChannel 或信令订阅；只有房间凭证被替换、房间被移除或页面卸载时才释放对应运行时。因此一台机器可以同时维持多个彼此独立的双人房间；每个房间先由持久 Membership 限定两把成员公钥，再由 `PeerLock` 限制当前连接到一个合法对端页面实例。

`WebRtcSession` 现在使用单一 `phase`（discovering / negotiating / connected / full / disposed）表达主生命周期，而不是让十几个布尔值互相组合。实例创建后已经具备发现能力，信令就绪才启动 Hello 定时器，因此不再保留没有独立行为的 `idle` 和空 `start()`。持久成员公钥先完成准入；同一成员的页面实例收敛为一条 `PeerLock`，本轮 Offer/Answer 收敛为一条 `Negotiation`，三个定时器统一放在 `Timers` 中；重连时通过一个入口清理 Peer、协商和 Candidate 缓存，但不清除持久 Membership。PeerConnection、DataChannel 与异步 SDP 回调仍会检查自己是否属于当前协商，避免旧实例污染新房间。

诊断日志统一经过 `trace(stage, code, message, options)`，连接状态和用户提示统一经过 `show(...)`。这两个入口保留了完整排障证据链，但删除了散落在主流程里的重复日志对象。Candidate 解析和最终 Candidate Pair 统计移到纯函数模块 `rtcStats.ts`，不再挤占会话状态机。

聊天消息中的 `author` 使用 `self / peer`，只表达本机 UI 方向。方向元数据随密文写入 IndexedDB，刷新或关闭标签页后仍可恢复。存储层只读取当前 IndexedDB 结构；无效记录会明确失败，不再回退到旧存储或猜测消息方向。

聊天名称和图标使用独立的 `room-metadata` 加密控制消息，不混入消息列表。昵称和头像使用独立的 `profile-metadata` 加密控制消息；接收端把最新资料写入房间并作为消息列表的显示覆盖层，因此历史消息会显示最新头像和昵称，但既有消息密文不会被重写。两类元数据都通过 revision 和 version ID 收敛，并在连接建立后重发当前版本。消息删除和聊天删除则刻意保持本地语义，不广播 tombstone，也不承诺双方历史一致。

## 6. 文件结构

```text
twoonly/
├── app/
│   ├── api/signal/
│   │   └── route.ts                # 同源 HTTPS 信令入口
│   ├── api/turn-credentials/
│   │   └── route.ts                # Cloudflare TURN 短时凭据与请求追踪
│   ├── globals.css                 # 全局与响应式 UI
│   ├── layout.tsx                  # 元数据和根布局
│   └── page.tsx                    # 首页入口
├── components/
│   └── TwoOnlyApp.tsx              # 客户端入口与首页/聊天页分流
├── src/
│   ├── config/
│   │   ├── policy.ts              # 产品限制、协议与 RTC 策略
│   │   ├── publicRuntime.ts       # NEXT_PUBLIC 环境配置
│   │   └── serverRuntime.ts       # server-only 站点、TURN 与 Redis 配置
│   ├── chat/
│   │   ├── roomRuntime.ts          # 单房间连接、消息与附件传输运行时
│   │   ├── types.ts                # 聊天领域类型
│   │   └── useTwoOnlyChat.ts       # 状态与用例协调器
│   ├── crypto/
│   │   ├── aesGcm.ts               # 通用 AES-GCM JSON 信封
│   │   └── messageCrypto.ts        # 随机值、安全码、聊天加解密
│   ├── diagnostics/
│   │   └── connectionDiagnostics.ts # 脱敏建连日志与内存缓冲
│   ├── media/
│   │   └── useAudioRecorder.ts     # 录音生命周期
│   ├── protocol/
│   │   ├── attachmentProtocol.ts   # 大附件分块、校验与 Base64 编解码
│   │   ├── profileMetadataProtocol.ts # 昵称头像资料的加密控制帧
│   │   └── wireProtocol.ts         # 密文分片编码与重组
│   ├── room/
│   │   ├── invitation.ts           # 房间 URL 与邀请链接
│   │   └── memberIdentity.ts       # 每房间 P-256 成员密钥与信令签名
│   ├── signal/
│   │   ├── types.ts                       # 信令协议与结构校验
│   │   ├── supabaseSignalTransport.ts     # Supabase WebSocket 信令
│   │   ├── httpsSignalTransport.ts        # 浏览器同源 HTTPS 信令
│   │   ├── httpsSignalProtocol.ts         # HTTPS 请求/响应校验
│   │   ├── serverSignalStore.ts           # 服务端 Redis Stream
│   │   └── signalTransport.ts             # 双活聚合与去重
│   ├── server/
│   │   └── requestSecurity.ts      # Route 同源请求校验
│   ├── storage/
│   │   └── chatStorage.ts          # 密文历史与本标签发送消息 ID
│   ├── ui/
│   │   ├── LandingScreen.tsx       # 首页与 Wiki
│   │   ├── ChatScreen.tsx          # 聊天页组合
│   │   ├── ChatHeader.tsx          # 状态与房间操作
│   │   ├── ConnectionDiagnosticsPanel.tsx # 保留的开发诊断面板，默认不渲染
│   │   ├── ChatSidebar.tsx         # 当前会话摘要
│   │   ├── MessageList.tsx         # 消息展示
│   │   └── MessageComposer.tsx     # 文字/图片/语音/文件与剪贴板输入
│   ├── utils/
│   │   ├── browser.ts              # 剪贴板与 Data URL
│   │   ├── format.ts               # 时间、容量与短 ID 格式
│   │   ├── guards.ts               # 通用运行时类型守卫
│   │   └── ids.ts                  # Trace ID
│   └── webrtc/
│       ├── WebRtcSession.ts        # Peer、握手、重连状态机
│       ├── iceConfig.ts            # STUN/TURN 配置
│       ├── iceServers.ts           # ICE Server 校验与摘要
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
│   └── assets/                     # 架构总览与 FAQ 编号流程图
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
  CONFIG["Config Policy"] --> CHAT["Chat Controller"]
  CONFIG --> SIGNAL["Signal Transport"]
  CONFIG --> WEBRTC["WebRTC Session"]
  CONFIG --> UI["UI"]
  CONFIG --> ROOM["Room"]
  CONFIG --> STORAGE["Storage"]
  CONFIG --> MEDIA["Media"]
  CONFIG --> PROTOCOL["Wire Protocol"]
  UTILS["Shared Utils"] --> CHAT
  UTILS --> WEBRTC
  UTILS --> SIGNAL
  UTILS --> UI
  UI --> CHAT
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
- 业务模块不直接读取 `process.env`；公开变量只能进入 `publicRuntime.ts`，长期 Token 只能进入 `serverRuntime.ts`；
- `policy.ts` 只保存跨模块策略与协议值，组件独有文案和展示映射留在组件附近，防止配置文件变成新的杂物间；
- `utils` 只接收普通参数并返回结果，不反向依赖 Chat、Signal 或 WebRTC 状态机；
- Signal 只传递并校验信令结构，不依赖具体 UI；成员签名和房间席位校验必须在进入 WebRTC 状态机前完成；
- WebRTC 只传输 `EncryptedWire`，不持有 AES 密钥或明文消息；
- Storage 只保存密文信封，不自行加解密；
- Crypto 的密钥实例绑定单个房间秘密，不能跨房间复用；
- 当前 Signal protocol v3 要求每条 Hello、Offer、Answer、Candidate 和 Rejected 都带每房间 P-256 ECDSA 成员签名；`participantId`、epoch 与 negotiation ID 继续只负责页面实例和协商轮次，不能替代持久 Membership。
