# Supabase 不可达时的信令容灾方案

TwoOnly 当前唯一明显的网络单点是 Supabase Realtime：TURN 可以解决 WebRTC 直连失败，却不能替双方交换 Hello、Offer、Answer 和 ICE Candidate。只要任意一方无法订阅 Supabase，新的 PeerConnection 就无法建立。

这份文档不直接改动现有产品，而是给后续开发留下一条可以逐步落地的路线。核心建议是：保留 Supabase，同时增加一个部署在长期在线 VPS 上的 Socket.IO 信令服务，让两个浏览器同时连接两套信令并对重复消息去重。

## 1. 推荐结论

| 项目 | 推荐选择 |
| --- | --- |
| 主信令 | 继续使用 Supabase Realtime |
| 备用信令 | 自建 Socket.IO，运行在长期在线 VPS，不放进 Vercel Function |
| 客户端模式 | 双通道同时订阅、同时发送，任意一条成功即可 |
| 传输端口 | WSS/TLS 443；Socket.IO 保留 HTTP long-polling 降级 |
| 房间状态 | 单实例可先放内存；多实例使用 Redis 和短 TTL |
| 消息去重 | 每条信令增加唯一 `signalId`，客户端在进入 WebRTC 状态机前去重 |
| 聊天正文 | 仍然只走 WebRTC DataChannel，不经过两套信令服务 |

最终目标不是“Supabase 报错后再换一个 URL”，而是让双方始终至少共享一条可用信令通道。

## 2. 为什么不能做简单的单边切换

假设参与者 A 能访问 Supabase，参与者 B 不能：

- A 会继续停留在 Supabase；
- B 检测失败后切到备用服务；
- 两边各自都显示“信令已连接”，却仍然收不到对方消息。

这叫信令分裂。WebRTC 不会替两个信令网络自动桥接。

因此客户端应当采用双活方式：

1. 页面加载后同时启动 Supabase 与备用 Socket.IO；
2. Hello、Offer、Answer、Candidate 发送到所有健康传输；
3. 任一传输确认发送成功，就认为本次信令至少有一条送达路径；
4. 收到消息后先按 `signalId` 去重，再交给 `WebRtcSession`；
5. 某条传输掉线时独立重连，不销毁另一条健康传输；
6. 两条传输都不可用时，才把信令状态标为 unavailable。

如果 A 只能访问 Supabase、B 只能访问备用服务，而且两端都无法连接另一条通道，那么它们仍然无法相遇。解决这个极端情况只能保证至少一个共同可达服务，或额外建设服务端桥接。对 TwoOnly 来说，优先把备用服务部署成双方都能访问，比增加跨服务桥接更简单、更可靠。

## 3. 客户端改造边界

建议把当前 `src/signal/signalTransport.ts` 拆成四个职责明确的文件：

| 文件 | 职责 |
| --- | --- |
| `supabaseSignalTransport.ts` | 当前 Supabase 创建、订阅、发送、心跳和清理逻辑 |
| `socketIoSignalTransport.ts` | 连接备用服务，加入房间，发送与接收信令 |
| `redundantSignalTransport.ts` | 同时管理多个传输，聚合健康状态、广播和去重 |
| `types.ts` | 信令消息、Transport 接口和运行时校验 |

统一 Transport 只需要保留四类能力：启动、发送、释放和状态/消息回调。不要把 PeerConnection、React 状态或聊天正文放进适配器。

### 3.1 信令信封

现有协议已经有 participant ID、双方 epoch 和 negotiation ID，后续只需在传输边界补充：

| 字段 | 用途 |
| --- | --- |
| `signalId` | 每次发送生成 UUID，用于跨传输去重 |
| `sentAt` | 排障和过期判断，不作为安全时间源 |
| `protocolVersion` | 拒绝不兼容客户端 |
| 现有 SignalMessage | Hello、Offer、Answer、Candidate 或 rejected 负载 |

去重缓存可以只保留最近 512 条 ID 或最近 60 秒记录。epoch 与 negotiation ID 继续负责拒绝旧协商；`signalId` 只解决同一条消息从两套传输重复到达的问题，两者不能互相替代。

### 3.2 健康状态

每个传输独立维护：

- `connecting`：正在建立连接或订阅；
- `ready`：已加入房间并通过一次发送确认或心跳；
- `degraded`：连接存在，但心跳或发送确认连续失败；
- `unavailable`：当前不可用，正在按退避策略重试。

聚合规则：至少一个传输 `ready` 即可开始 Hello；全部不可用才显示“信令服务不可用”。DataChannel 已经打开后，单条或全部信令中断只显示“信令降级”，不要把仍在工作的聊天误报为断开。

### 3.3 诊断日志

日志应带上传输名，建议新增：

- `signal.supabase.ready` / `signal.supabase.error`；
- `signal.fallback.ready` / `signal.fallback.error`；
- `signal.route.degraded` / `signal.route.recovered`；
- `signal.message.duplicate`；
- `signal.message.delivered`，只记录成功传输数量，不记录 SDP、Candidate 或秘密。

页面可以显示“信令：双通道”“信令：备用通道”或“信令：不可用”。这只描述握手路径，不能替代“P2P 直连 / TURN 中继”的数据路径文案。

## 4. 备用 Socket.IO 服务

### 4.1 最小职责

服务端只做以下事情：

1. 接受 TLS 连接并验证 Origin、消息大小和协议版本；
2. 让连接加入 `roomId` 对应的临时房间；
3. 把信令事件转发给房间中的另一位参与者；
4. 限制每个房间最多两个活跃参与者；
5. 断开后释放席位，空房间按 TTL 清理；
6. 提供健康检查、连接数、消息数、拒绝数和延迟指标。

它不应该接收或保存聊天正文，不参与 AES-GCM 解密，也不代理 DataChannel 数据。

### 4.2 部署位置

该服务需要长期维持 WebSocket，因此应运行在 VPS、容器服务或专门的长连接平台，不应塞进当前 Vercel Server Function。

最小部署组合：

- Node.js 22；
- Socket.IO Server；
- Nginx 或云负载均衡终止 TLS；
- WSS 443；
- systemd 或 PM2 负责进程拉起；
- 单实例房间 Map；
- HTTPS `/healthz`；
- 基础限流和结构化日志。

需要水平扩容时，再增加 Redis adapter、共享成员租约和负载均衡粘性策略。不要在只有一个实例时提前引入 Redis。

若主要用户在中国大陆，应优先选择实际可测的境内合规节点或香港/邻近区域，并准备自有域名、可信 TLS 证书和三网测试。只换云厂商名称不能替代 DNS、WSS 443 和真实运营商验证。

### 4.3 为什么选择 Socket.IO

这里选择 Socket.IO 不是为了把 WebRTC 数据改走服务器，而是利用它成熟的心跳、自动重连、房间和 HTTP long-polling 降级。严格网络无法建立 WebSocket 时，long-polling 有机会继续传递少量信令。

如果确定所有目标网络都允许 WSS，也可以使用更轻的 `ws`。两者都只承担低流量信令，架构边界相同。

## 5. 安全与双人限制

### 5.1 第一阶段：保持当前安全边界

第一版备用服务可以沿用当前模型：随机 room ID 作为难以猜测的 topic，浏览器 peer lock 拒绝第三人，服务端再限制一个房间最多两条活跃连接。这与当前 Supabase 公共频道的安全级别接近，适合先解决可达性。

服务端必须同时限制：

- 单 IP 连接速率；
- 单连接加入房间数；
- SDP/Candidate/ID 最大长度，复用当前 `SIGNAL_POLICY`；
- 房间空闲 TTL；
- 允许的 Web Origin；
- 日志脱敏，禁止输出完整 SDP、Candidate、邀请 secret 和凭据。

### 5.2 第二阶段：签名加入凭证

如果要把“只允许两个人”升级为服务端保证，可由 Vercel 创建房间接口签发短时加入 token，token 至少包含 room ID、过期时间和随机 nonce。备用信令服务器只接受签名有效且未超过两个席位的连接。

不要直接把 URL fragment 中的 AES 会话 secret 发给信令服务器，也不要复用 Cloudflare TURN Token 作为房间认证凭证。聊天密钥、信令权限和 TURN 权限应彼此独立。

## 6. 建议环境变量

| 变量 | 位置 | 说明 |
| --- | --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | 浏览器构建 | 当前主信令 URL |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | 浏览器构建 | 当前公开 key |
| `NEXT_PUBLIC_SIGNAL_FALLBACK_URL` | 浏览器构建 | 备用 Socket.IO HTTPS 基址，例如 `https://signal.example.com` |
| `NEXT_PUBLIC_SIGNAL_MODE` | 浏览器构建 | 建议默认 `dual`；紧急回滚可设 `supabase` |
| `SIGNAL_ALLOWED_ORIGINS` | 备用服务 | 允许的 TwoOnly 正式域名 |
| `SIGNAL_ROOM_TTL_SECONDS` | 备用服务 | 空房间与失联租约清理时间 |
| `SIGNAL_TOKEN_SIGNING_KEY` | 服务端秘密 | 第二阶段签名加入 token 使用 |
| `REDIS_URL` | 备用服务秘密 | 仅多实例阶段需要 |

公开 fallback URL 可以进入浏览器包；签名 key、Redis 凭据和任何服务端管理 token 不得使用 `NEXT_PUBLIC_` 前缀。

## 7. 实施顺序

### P0：准备备用服务

- 在目标地域创建 VPS；
- 部署最小 Socket.IO 房间转发服务；
- 配置自有域名、TLS 443、健康检查和进程守护；
- 用目标运营商分别验证 WebSocket 与 long-polling。

### P1：拆分当前信令适配器

- 把 Supabase 逻辑移到独立适配器；
- 定义统一 Transport 接口；
- 保持 `WebRtcSession` 和 UI 不感知具体服务商；
- 先只启用 Supabase，确认行为不变。

### P2：接入双通道

- 实现 Socket.IO 适配器；
- 给每条信令增加 `signalId`；
- 实现发送到全部健康传输、入站去重和聚合状态；
- Hello 定时广播走所有健康传输；
- DataChannel 打开后把信令故障降级为提示，不销毁有效连接。

### P3：灰度与观测

- 先让少量测试房间启用 `dual`；
- 分开统计 Supabase-only、fallback-only、双通道和全部失败；
- 记录首次 Hello、Offer/Answer、`data.open` 的阶段耗时；
- 检查重复消息是否被去重、是否出现双 Offer 或旧 Candidate 污染；
- 确认聊天正文从未进入信令日志。

### P4：身份强化

- 增加签名加入 token；
- 服务端原子分配两个成员槽；
- 增加密钥轮换、吊销和审计；
- 多实例时接入 Redis。

## 8. 必测矩阵

| 场景 | 期望结果 |
| --- | --- |
| Supabase 与备用服务都正常 | 双方连接；重复信令被去重 |
| Supabase 对一方不可达 | 双方通过备用服务完成握手 |
| Supabase 对双方不可达 | 双方通过备用服务完成握手 |
| 备用服务不可达 | 双方继续通过 Supabase 握手 |
| 建连后 Supabase 中断 | DataChannel 继续工作，信令显示降级 |
| DataChannel 断开且只剩备用服务 | 双方通过备用服务完成新一轮协商 |
| 两套信令同时不可达 | 明确显示不可用，不假装自动恢复成功 |
| 同一信令从两条通道重复到达 | 只进入 `WebRtcSession` 一次 |
| 第三位参与者加入 | 已建立的两人会话不被抢占 |
| WebSocket 被拦截但 HTTP 可用 | Socket.IO long-polling 能完成少量信令 |

验收仍需在两台真实设备、不同运营商和至少一个严格网络完成。浏览器双窗口只能作为快速回归，不能替代网络验收。

## 9. 上线与回滚

先部署备用服务，再发布支持双通道的客户端。这样新客户端启动时不会指向尚未存在的 fallback。

建议保留 `NEXT_PUBLIC_SIGNAL_MODE`：

- `supabase`：紧急关闭备用适配器；
- `dual`：正常生产模式；
- 不建议提供 `fallback-only` 给普通用户，只保留给运维验证。

任何 `NEXT_PUBLIC_*` 变更都需要重新构建和部署。回滚客户端不会影响已经建立的 DataChannel，但页面刷新后的新握手会回到旧信令策略。

## 10. 最终边界

完成这套方案后，TwoOnly 可以消除“单一 Supabase 域名不可达就完全无法建联”的主要单点，但仍不能承诺所有网络 100% 成功：网页域名、至少一条共同信令通道、STUN/TURN 和最终 WebRTC 路径仍必须可达。

真正有价值的改进是让这些依赖分别可观测、可替换、可降级，而不是再增加一个无法验证的本地 fallback。
