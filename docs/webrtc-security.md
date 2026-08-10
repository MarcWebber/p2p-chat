# WebRTC、双工通道与加密

## 1. 为什么仍然需要信令服务

WebRTC 定义了浏览器之间的连接能力，但不规定应用如何交换 SDP 和 ICE Candidate。TwoOnly 使用 Supabase Realtime Broadcast 作为信令总线；它帮助双方找到彼此，连接建立后不承载聊天消息。

官方说明可参考 [WebRTC Peer Connection](https://webrtc.org/getting-started/peer-connections)：Offer/Answer 描述双方能力，ICE Candidate 描述可能的网络路径，应用需要自行提供信令机制完成交换。

## 2. Offer/Answer 建连过程

```mermaid
sequenceDiagram
  participant G as "访客浏览器"
  participant S as "Supabase Realtime"
  participant H as "房主浏览器"

  G->>S: "hello(senderId)"
  S->>H: "转发 hello"
  H->>H: "锁定首个访客并创建 DataChannel"
  H->>H: "createOffer + setLocalDescription"
  H->>S: "offer + negotiationId"
  S->>G: "转发 offer"
  G->>G: "setRemoteDescription + createAnswer"
  G->>S: "answer + negotiationId"
  S->>H: "转发 answer"
  H->>H: "setRemoteDescription"
  H-->>S: "ICE candidates"
  G-->>S: "ICE candidates"
  S-->>H: "对端 candidates"
  S-->>G: "对端 candidates"
  H<<->>G: "RTCDataChannel open"
```

实现中有几项可靠性保护：

- 每次协商生成 `negotiationId`，忽略过期 Answer；
- 所有信令进入 Promise 队列串行处理，避免并发修改 `signalingState`；
- 重复 Offer 会复用已经生成的 Answer，而不是重复设置远端描述；
- 远端描述尚未设置时先缓存 ICE Candidate，设置后统一补入；
- 收到 Offer 后访客停止周期 `hello`，避免重复触发协商；
- 新会话会清空旧访客锁和协商状态，旧 Peer/DataChannel 回调不能覆盖新状态。
- DataChannel 或 PeerConnection 中断后，双方会延迟 800 ms 自动重握手；访客恢复 `hello`，房主为同一个访客生成新的 Offer。
- 每轮重连都有新的 `negotiationId`，ICE Candidate 也携带该 ID，旧协商产生的 Candidate 会被忽略。
- 用户可点击“立即重连”跳过等待；同一标签页刷新后通过 `sessionStorage` 复用本次发送方身份。

## 3. 双工 DataChannel

房主在 `RTCPeerConnection` 上创建：

```ts
peer.createDataChannel("twoonly-messages", { ordered: true })
```

访客通过 `peer.ondatachannel` 取得同一逻辑通道。通道打开后，双方都能调用 `send()`，也都监听 `message`，因此它是一个全双工通道，而不是“请求—响应”接口。

`ordered: true` 且未设置 `maxRetransmits` / `maxPacketLifeTime`，对应可靠、按序传输。WebRTC 规范将 `RTCDataChannel` 定义为双向数据通道，底层使用 SCTP 数据传输；参见 [W3C WebRTC Peer-to-peer Data API](https://www.w3.org/TR/webrtc/#peer-to-peer-data-api) 和 [WebRTC Data Channels](https://webrtc.org/getting-started/data-channels)。

## 4. ICE、STUN 与 TURN

`RTCPeerConnection` 从环境变量构造 ICE Server 列表：

- STUN 帮助浏览器发现 NAT 映射后的候选地址；
- ICE 尝试主机候选、反射候选等路径并选择可用候选对；
- 当直连不可达时，TURN 作为中继转发 WebRTC 流量。

当前默认 STUN：

```dotenv
NEXT_PUBLIC_STUN_URLS=stun:stun.cloudflare.com:3478,stun:stun.l.google.com:19302
```

生产稳定性通常需要 TURN。官方说明指出，许多 WebRTC 应用必须使用 TURN 处理无法直接建立 socket 的网络，参见 [WebRTC TURN server](https://webrtc.org/getting-started/turn-server)。

本项目的可执行配置步骤见 [TURN 配置手册](turn-configuration.md)。


页面通过 `RTCPeerConnection.getStats()` 找到当前 transport 实际选中的 Candidate Pair，再沿 `localCandidateId` / `remoteCandidateId` 检查候选类型：选中路径任一端是 `relay` 时显示“TURN 加密中继”，否则显示“WebRTC 点对点直连”。如果浏览器暂时没有暴露可判定的选中候选对，则只显示“WebRTC 已连接”，不会因为候选池里曾收集到 relay 就误报正在使用 TURN。该文字是运行时观测，不代表所有未来数据包永远不会切换路径。

## 5. 应用层 AES-GCM

WebRTC 自身包含 DTLS 保护。TwoOnly 在其上增加一层应用加密，使消息在进入 DataChannel 前已经成为密文。

### 密钥派生

1. 创建房间时用 `crypto.getRandomValues` 生成约 256 位随机 `secret`。
2. 浏览器计算 `SHA-256(secret)`。
3. 使用 `crypto.subtle.importKey` 把 256 位结果导入为不可导出的 AES-GCM 密钥。

这里使用 SHA-256 是因为输入本身是高熵随机秘密；如果未来改成用户短密码，必须改用带 salt 且成本可调的密码派生算法，不能继续直接哈希。

### 每条消息的加密格式

```ts
type EncryptedWire = {
  id: string;
  iv: string;    // 随机 12 字节 IV，Base64
  data: string;  // AES-GCM 密文和认证标签，Base64
};
```

AES-GCM 同时提供机密性和完整性校验；篡改 IV 或密文会导致 `decrypt()` 失败。每条消息生成独立随机 IV，避免在同一密钥下重复 nonce。算法定义见 [W3C Web Crypto API：AES-GCM](https://www.w3.org/TR/WebCryptoAPI/#aes-gcm-operations)。

当前没有把房间号、作者或协议版本放入 Additional Authenticated Data。若未来增加协议版本或可路由头部，应把这些不可加密但必须防篡改的字段加入 AAD。

## 6. 消息、图片和语音

统一明文结构：

```ts
type ChatMessage = {
  id: string;
  kind: "text" | "image" | "audio";
  content: string;
  author: "host" | "guest";
  createdAt: number;
  fileName?: string;
};
```

- 文字直接进入 `content`；
- 图片通过 `FileReader.readAsDataURL` 转成 Data URL；
- 语音通过 `getUserMedia({audio:true})` 和 `MediaRecorder` 录制，优先使用 WebM/Opus，再转成 Data URL；
- 图片和语音在编码前限制为 1.5 MB，避免浏览器内存、本地存储和 DataChannel 队列失控。

消息 JSON 先整体加密，再把密文 JSON 按 12,000 字符切成 `ChunkPacket`。接收端按消息 ID 和序号重组，只有分片完整后才执行 AES-GCM 解密。

当前未实现发送背压；持续发送多个大文件可能增大 `RTCDataChannel.bufferedAmount`。正式版应设置 `bufferedAmountLowThreshold` 并等待 `bufferedamountlow`。

## 7. 本地加密历史

每个房间的存储键为：

```text
twoonly:<roomId>:messages
```

数组中只保存 `EncryptedWire`，不保存明文 `ChatMessage`，并保留最新 200 条。刷新页面后，从 URL Fragment 重新取得 `secret`，逐条解密并渲染。清空记录只删除当前设备、当前房间对应的 `localStorage`。

注意：

- `localStorage` 不是抗取证或硬件安全存储；能控制当前浏览器环境的脚本、扩展或本机用户可能读取密文和页面内存中的密钥。
- 清理浏览器数据、换设备或丢失完整邀请链接后，历史无法恢复。
- 对方离线时，新消息只保存在发送方本机，不会自动补发。

## 8. 安全模型

### 已保护

- Supabase 和 Vercel 不接收聊天正文；
- DataChannel 上传输的是 AES-GCM 密文；
- 本机历史保存为 AES-GCM 密文；
- 随机 IV 和 GCM 认证标签可检测传输或存储篡改；
- 安全码可辅助双方发现邀请秘密不一致。

### 未保护或未实现

- 没有账号、设备公钥、数字签名或长期身份认证；
- 拿到完整邀请链接的人同时拿到房间号和加密秘密；
- 公共 Supabase topic 可被知道 roomId 的客户端订阅或干扰；
- 房主刷新会重置“两人锁”；
- 不提供前向保密的应用层密钥轮换，也不提供消息删除同步；
- SDP/ICE 等网络元数据需要经过 Supabase，TURN 中继也能观察连接元数据和流量体积，但不能读取 AES-GCM 正文。
