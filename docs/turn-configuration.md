# TURN 配置手册

本文给出两种可以直接用于 TwoOnly 的方案：Cloudflare 托管 TURN，或在一台有公网 IP 的服务器上自建 Coturn。Cloudflare 使用服务端短时凭证；Coturn 仍可使用静态前端变量作为小规模兜底。

## 1. TURN 在项目中的作用

WebRTC 会优先尝试浏览器直连。遇到对称 NAT、企业防火墙、运营商 UDP 限制或复杂跨境网络时，直连可能失败；TURN 会为双方分配 relay candidate，并中继 WebRTC 流量。

TURN 不负责 Supabase 信令，也不保存聊天记录。经过 TURN 的负载仍受 WebRTC DTLS 和 TwoOnly 应用层 AES-GCM 双重保护，但中继服务可以看到连接时间、IP、流量大小等元数据。

WebRTC 官方同样建议为无法直接建立连接的场景提供 TURN，参见 [WebRTC TURN server](https://webrtc.org/getting-started/turn-server)。

## 2. 方案 A：托管 TURN

这是最快的生产接入方式。

1. 在 TURN 服务商控制台创建应用或 credential。
2. 取得三项信息：`urls`、`username`、`credential`。
3. 至少准备 UDP、TCP 和 TLS 三条地址，例如：

   ```text
   turn:global.turn-provider.example:3478?transport=udp
   turn:global.turn-provider.example:3478?transport=tcp
   turns:global.turn-provider.example:443?transport=tcp
   ```

4. 按第 5 节写入 Vercel 并重新部署。
5. 按第 6 节确认能采集到 `relay` candidate。

优先选择能覆盖主要用户地区、支持 TLS 443、提供短时凭证和连接成功率监控的服务。中国大陆用户较多时，应确认服务商对中国电信、联通、移动的实际可达性，不能只看机房地理位置。

### 2.1 当前推荐的落地顺序

项目已经实现 `/api/turn-credentials`，可以按投入从低到高选择：

1. **立即验证**：用专属 Coturn 长期用户名/随机密码接入现有的三个 `NEXT_PUBLIC_TURN_*` 变量。代码无需再改，但凭证会进入浏览器包，只适合小规模试运行。
2. **正式托管**：使用 Cloudflare Realtime TURN；现有 Vercel Route Handler 使用服务端 TURN key 和 API token 生成 24 小时短时凭证，浏览器只接收临时 `iceServers`。
3. **国内优先**：在目标用户附近自建 Coturn，使用 `use-auth-secret` 和短时 HMAC 凭证；至少覆盖 UDP 3478、TCP 3478 和 TLS 443，并按电信、联通、移动分别实测。

Cloudflare 的官方接入文档是 [Generate Credentials](https://developers.cloudflare.com/realtime/turn/generate-credentials/)。其凭证生成接口适合由后端调用，不应把 TURN key 暴露给浏览器。Cloudflare Realtime TURN 的全球网络不包含中国网络，因此它适合快速验证和海外访问，不应被当作中国大陆稳定性的保证。

## 3. 方案 B：Ubuntu 自建 Coturn

### 3.1 准备资源

- 一台带独立公网 IPv4 的 Ubuntu 服务器；
- 一个 DNS 子域名，例如 `turn.example.com`，A 记录指向该公网 IP；
- TLS 证书，证书域名与 TURN 子域名一致；
- 安全组与系统防火墙允许：

| 端口 | 协议 | 用途 |
| --- | --- | --- |
| `3478` | UDP + TCP | 标准 STUN/TURN |
| `5349` 或 `443` | TCP | TURN over TLS，即 `turns:` |
| `49160-49200` | UDP + TCP | 本手册示例的 relay 端口范围 |

relay 范围越小，并发容量越有限；小型双人聊天可先使用上面的范围，再根据监控扩容。

### 3.2 安装

```bash
sudo apt update
sudo apt install coturn
```

部分 Ubuntu 包需要在 `/etc/default/coturn` 中启用服务：

```text
TURNSERVER_ENABLED=1
```

### 3.3 配置长期凭证

编辑 `/etc/turnserver.conf`：

```ini
listening-port=3478
tls-listening-port=5349

listening-ip=0.0.0.0
relay-ip=<服务器内网或主网卡 IP>
external-ip=<服务器公网 IP>

realm=turn.example.com
server-name=turn.example.com
fingerprint
lt-cred-mech
user=twoonly:<替换成至少 24 位随机密码>

cert=/etc/letsencrypt/live/turn.example.com/fullchain.pem
pkey=/etc/letsencrypt/live/turn.example.com/privkey.pem

min-port=49160
max-port=49200
stale-nonce=600
user-quota=12
total-quota=120

no-cli
no-loopback-peers
no-multicast-peers
```

如果服务器位于一层 NAT 后面，`external-ip` 使用 Coturn 支持的公网/内网映射形式：

```ini
external-ip=<公网 IP>/<内网 IP>
```

Coturn 的完整配置项和默认行为以官方 [turnserver.conf 示例](https://github.com/coturn/coturn/blob/master/examples/etc/turnserver.conf) 与 [turnserver Wiki](https://github.com/coturn/coturn/wiki/turnserver) 为准。

### 3.4 TLS 443

严格网络通常更容易放行 TLS 443。若这台服务器的 443 没被网站或反向代理占用，可改为：

```ini
tls-listening-port=443
```

低端口绑定可能需要以系统服务启动或授予 `CAP_NET_BIND_SERVICE`。不要让 HTTPS Web 服务和 Coturn 直接争用同一个 IP:443；需要共存时应增加独立公网 IP，或使用服务商明确支持的 TURN TLS 代理方案。

### 3.5 启动与日志

```bash
sudo systemctl enable coturn
sudo systemctl restart coturn
sudo systemctl status coturn
sudo journalctl -u coturn -f
```

若启动失败，优先检查证书读取权限、端口占用、`relay-ip`/`external-ip` 和云安全组。

## 4. 凭证安全

TwoOnly 优先从 `/api/turn-credentials` 获取 Cloudflare 短时凭证；仅当接口不可用时才回退到 `NEXT_PUBLIC_TURN_*`。后者会进入浏览器 JavaScript，长期固定密码只适合小规模原型。

当前可执行的最低保护：

- 为 TwoOnly 单独创建 TURN 用户；
- 设置配额和带宽限制；
- 定期轮换随机密码；
- 监控异常地域、并发 allocation 和出口流量；
- 不复用服务器登录密码或其他系统凭证。

自建 Coturn 的正式方案是 `use-auth-secret`/TURN REST API：可信后端用共享秘密签发带过期时间的临时用户名和 HMAC credential，浏览器只拿短时凭证。Cloudflare 托管方案的服务端接口已经实现；Coturn HMAC 签发可在同一接口边界继续扩展。

托管 TURN 也遵循相同原则：例如 Cloudflare 要求后端保存 TURN key 和 API token，再为客户端生成有 TTL 的临时 `iceServers`。不要把服务商的长期 API token 写入任何 `NEXT_PUBLIC_*` 变量。

## 5. 写入 Vercel

Cloudflare 托管方案在 Vercel Production 添加以下服务端变量，均不得带 `NEXT_PUBLIC_` 前缀：

```dotenv
CLOUDFLARE_TURN_KEY_ID=<Cloudflare TURN key ID>
CLOUDFLARE_TURN_API_TOKEN=<Cloudflare TURN API token>
```

保存后必须重新部署。API Token 应标记为 Sensitive；不要提交到 Git 或上传到前端构建文件。

自建 Coturn 静态兜底方案才使用以下变量：

在 Vercel 项目 `twoonly-chat` 的 Settings → Environment Variables 中为 Production 添加：

```dotenv
NEXT_PUBLIC_TURN_URLS=turn:turn.example.com:3478?transport=udp,turn:turn.example.com:3478?transport=tcp,turns:turn.example.com:5349?transport=tcp
NEXT_PUBLIC_TURN_USERNAME=twoonly
NEXT_PUBLIC_TURN_CREDENTIAL=<第 3.3 节设置的随机密码>
```

如果 TLS 使用 443，把最后一条改为：

```text
turns:turn.example.com:443?transport=tcp
```

环境变量变更不会影响已经生成的部署，保存后必须重新部署 Production。项目会把 TURN 与默认 STUN 一起传入 `RTCPeerConnection`。

## 6. 验证

这里要区分三件事：凭证接口成功、收集到 relay candidate、实际选中 TURN 并产生双向流量。它们不是同一条证据。完整的分层判断和两端检查步骤见[常见问题与网络排障 FAQ](faq.md)。

### 6.1 先验证 TURN 服务

打开 WebRTC 官方示例 [Trickle ICE](https://webrtc.github.io/samples/src/content/peerconnection/trickle-ice/)：

1. 删除页面中的默认 ICE Server；
2. 添加你的 TURN URL、用户名和密码；
3. 点击 **Gather candidates**；
4. 结果中必须出现 `relay` 类型 candidate；
5. 分别验证 UDP 3478、TCP 3478、TLS 5349/443。

只有 `host` 或 `srflx` 而没有 `relay`，说明 TURN 分配没有成功。

### 6.2 再验证 TwoOnly

1. 重新部署后让参与者 A、B 分别使用两种不同网络，例如家庭宽带与手机热点；
2. 建立聊天并发送双向消息；
3. 切换网络或短暂断网，确认页面自动显示“正在重新建立加密连接”并恢复；
4. 在必须走中继的网络下，聊天页顶部应显示“TURN 加密中继”；该状态读取的是实际选中的 Candidate Pair，而不是候选池里是否曾经出现 relay；
5. 双向发送消息并在 WebRTC 内部统计中确认 `bytesSent`、`bytesReceived` 持续增长；
6. 同时检查 Coturn 日志或 Cloudflare TURN Analytics 是否出现 allocation、连接数和双向 relay 流量。

## 7. 常见问题

### 能生成 `srflx`，但没有 `relay`

通常是用户名/密码错误、3478/5349 未开放、`external-ip` 错误或 relay 端口范围未开放。

### TLS 连接失败

检查证书域名、完整证书链、私钥权限和系统时间。浏览器不会接受域名不匹配或不受信任的证书。

### 同一局域网成功，跨网络失败

通常说明只走了 host candidate；检查公网 IP、NAT 映射、安全组和 TURN relay candidate。

### 仍然无法保证中国大陆连接

TURN 只能改善 WebRTC 穿透。网页、Supabase 或 Vercel HTTPS 至少一条共同信令、DNS 和 TURN 本身都必须在目标运营商网络可达。正式方案仍需自有域名、合规托管、就近信令与多运营商实测。
