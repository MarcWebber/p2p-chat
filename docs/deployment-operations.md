# Supabase、Vercel 与部署运维

## 1. 部署拓扑

| 服务 | 用途 | 是否保存聊天正文 |
| --- | --- | --- |
| Vercel | 托管页面资源，提供 TURN 凭据接口和同源 HTTPS 信令 | 否 |
| Supabase Realtime | 通过 WebSocket 转发 WebRTC 的 `hello / offer / answer / candidate / rejected` 信令 | 否 |
| Upstash Redis | 保存最多 180 秒的 AES-GCM 密文信令，供同源 HTTPS 路径读取 | 只保存临时信令密文 |
| STUN | 帮助发现可用于 ICE 的公网映射地址 | 否 |
| TURN（可选） | 直连失败时中继已经加密的 WebRTC 流量 | 不做应用存储，但会经过中继 |
| 浏览器 `localStorage` | 保存当前设备的 AES-GCM 密文历史 | 保存密文 |

项目不调用外部业务数据源，不读取第三方内容 API，也不使用 Supabase Database、Auth 或 Storage 保存聊天消息。

## 2. 当前生产资源

| 项目 | 当前值 |
| --- | --- |
| 正式站点 | `https://twoonly-chat.vercel.app` |
| Supabase 项目名 | `TwoOnly-Signaling` |
| Supabase Project Ref | `eamhclsnanmdkodrhgmz` |
| Supabase 区域 | `ap-southeast-1`（新加坡） |
| Supabase API URL | `https://eamhclsnanmdkodrhgmz.supabase.co` |
| Upstash 数据库 | `twoonly-signal-fallback`，Free，`sin1` |
| Realtime topic | `twoonly:<随机 roomId>` |
| Realtime event | `signal` |

Project Ref、URL 和 publishable key 都是客户端配置，不是服务端秘密。严禁把 Supabase secret key、`service_role` key 或数据库密码写入 `NEXT_PUBLIC_*`、源码、文档或客户端包。

最近一次生产验收（2026-08-11）：`/api/signal` 返回 `configured:true`，真实 Redis publish/poll 成功；阻断 Supabase 后，两端仅通过 HTTPS 信令完成握手、双向消息与单端刷新重连。该验收不包含跨运营商 TURN relay，不能据此承诺中国大陆网络成功率。

## 3. 环境变量

复制 `.env.example` 为 `.env.local`：

```dotenv
NEXT_PUBLIC_SUPABASE_URL=https://YOUR_PROJECT_REF.supabase.co
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=sb_publishable_xxx

UPSTASH_REDIS_REST_URL=https://YOUR_DATABASE.upstash.io
UPSTASH_REDIS_REST_TOKEN=xxx

NEXT_PUBLIC_STUN_URLS=stun:stun.cloudflare.com:3478,stun:stun.l.google.com:19302
NEXT_PUBLIC_TURN_URLS=
NEXT_PUBLIC_TURN_USERNAME=
NEXT_PUBLIC_TURN_CREDENTIAL=
CLOUDFLARE_TURN_KEY_ID=
CLOUDFLARE_TURN_API_TOKEN=

NEXT_PUBLIC_SITE_URL=https://your-domain.example
```

| 变量 | 必需 | 说明 |
| --- | --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | WebSocket 路径必需 | Supabase Project URL |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | WebSocket 路径必需 | 浏览器可公开的 publishable key |
| `UPSTASH_REDIS_REST_URL` | HTTPS 路径必需 | Upstash Redis REST URL，仅服务端使用 |
| `UPSTASH_REDIS_REST_TOKEN` | HTTPS 路径必需 | Upstash Standard REST Token，仅服务端使用 |
| `KV_REST_API_URL` / `KV_REST_API_TOKEN` | 二选一别名 | Vercel Marketplace 通常自动注入的等价名称；无需与 `UPSTASH_*` 同时配置 |
| `NEXT_PUBLIC_STUN_URLS` | 建议 | 逗号分隔；未设置时使用代码中的 Cloudflare/Google 默认值 |
| `NEXT_PUBLIC_TURN_URLS` | 稳定生产建议 | 逗号分隔，可含 `turn:` 与 `turns:` 地址 |
| `NEXT_PUBLIC_TURN_USERNAME` | 配置 TURN 时必需 | TURN 用户名 |
| `NEXT_PUBLIC_TURN_CREDENTIAL` | 配置 TURN 时必需 | TURN 凭证；当前写法会进入浏览器包 |
| `CLOUDFLARE_TURN_KEY_ID` | Cloudflare TURN 必需 | 服务端 TURN key ID，不加 `NEXT_PUBLIC_` |
| `CLOUDFLARE_TURN_API_TOKEN` | Cloudflare TURN 必需 | 服务端长期 Token；必须作为 Vercel Sensitive Secret 保存 |
| `NEXT_PUBLIC_SITE_URL` | 生产建议 | Open Graph/Twitter 分享图的绝对 URL 基址 |

所有 `NEXT_PUBLIC_*` 在构建时进入前端 JavaScript。三个 `NEXT_PUBLIC_TURN_*` 仅保留为自建 Coturn/联调兜底。生产推荐配置两项不带前缀的 `CLOUDFLARE_TURN_*`，由 `/api/turn-credentials` 在服务端生成 24 小时临时 credential；长期 Token 不会进入浏览器包。

## 4. Supabase 配置

### 创建与取值

1. 在 [Supabase Dashboard](https://supabase.com/dashboard) 创建项目，优先选择靠近主要用户的区域。
2. 在项目的 **Connect** 对话框复制 Project URL 和 publishable key。
3. 将两项分别写入 `NEXT_PUBLIC_SUPABASE_URL` 和 `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`。
4. 确认 Realtime 服务可用；当前实现不需要建表、执行 SQL、开启 Postgres Changes、配置 Storage 或 Auth。

Supabase 当前建议浏览器使用 `sb_publishable_...`，而不是把 secret 或 `service_role` key 暴露给客户端；参见 [Broadcast 初始化说明](https://supabase.com/docs/guides/realtime/broadcast#initialize-the-client)。

### 客户端配置

代码等价于：

```ts
const client = createClient(url, publishableKey, {
  auth: { persistSession: false },
});

const channel = client.channel(`twoonly:${roomId}`, {
  config: { broadcast: { ack: true } },
});

channel
  .on("broadcast", { event: "signal" }, receiveSignal)
  .subscribe();
```

- `persistSession: false`：项目不使用 Supabase Auth，不在本地维护登录会话。
- `ack: true`：要求 Realtime 服务确认已接收 Broadcast。
- 订阅成功后两个页面才开始发送 protocol v2 `hello`，避免信令通道尚未就绪时丢失对端发现消息。
- 卸载或切换房间时调用 `removeChannel` 释放连接。

官方文档说明：客户端订阅后，Broadcast 通过 WebSocket 发送；公共频道允许未登录客户端订阅。参见 [Supabase Realtime Broadcast](https://supabase.com/docs/guides/realtime/broadcast) 与 [Realtime Concepts](https://supabase.com/docs/guides/realtime/concepts)。这也是当前 MVP 快速建连和严格身份控制之间的主要取舍。

### 任一信令配置缺失时

两个 Supabase 公开变量任一缺失时，客户端记录 `signal.supabase.config.missing`，但仍会尝试同源 HTTPS。两项 Upstash 服务端变量缺失时，`/api/signal` 的 POST 返回 `503 signal_fallback_not_configured`，但 Supabase 正常时仍可建联。只有两条通道都不可用，聚合器才记录 `signal.route.unavailable`。

自建时至少要完整配置其中一条路径，生产环境建议两条都配置。本地开发应分别验证 Supabase-only、HTTPS-only 和双通道去重。项目没有恢复仅限同浏览器标签页的 `BroadcastChannel` 伪降级。

## 5. Vercel 部署

### Dashboard 方式

1. 把项目推送到 Git 仓库并在 [Vercel](https://vercel.com/new) 导入。
2. 如果仓库根目录不是 `twoonly`，把 Root Directory 设置为 `twoonly`。
3. Framework Preset 选择 Next.js；Install/Build 使用 `npm install` 和 `npm run build`，输出目录保持自动检测。
4. 在 Project Settings → Environment Variables 添加上节变量，并至少应用到 Production。
5. 在 [Vercel Marketplace](https://vercel.com/marketplace/upstash) 安装 Upstash Redis，连接到同一项目和 Production 环境；Marketplace 通常注入 `KV_REST_API_URL` 与 `KV_REST_API_TOKEN`，代码已兼容。
6. 部署后把 `NEXT_PUBLIC_SITE_URL` 改成正式域名，再重新部署。Vercel 环境变量只对新部署生效，参见 [Vercel Environment Variables](https://vercel.com/docs/environment-variables)。

重新部署后访问 `/api/signal`。`configured:true` 表示服务端已经读到 Redis 变量；随后还要用浏览器日志确认 `signal.https.send.ack` 和通过 `https` provider 到达的 `hello.received`。

### CLI 方式

```bash
npm install
npm run typecheck
npm run build
npx vercel --prod
```

不要提交 `.env.production` 或 `.env.local`。仓库只保留不含真实值的 `.env.example`。

## 6. TURN 配置与验证

可以直接按照独立的 [TURN 配置手册](turn-configuration.md) 完成托管服务接入或 Coturn 自建。下方是项目所需的最小配置摘要。

只有 STUN 时，部分对称 NAT、企业防火墙、UDP 受限网络无法建立 P2P。推荐 TURN 同时开放：

- UDP 3478：通常延迟最低；
- TCP 3478：UDP 被禁时兜底；
- TLS 443（`turns:`）：适合只允许 HTTPS 类流量的严格网络。

Cloudflare 方案使用服务端变量 `CLOUDFLARE_TURN_KEY_ID` 与 `CLOUDFLARE_TURN_API_TOKEN`。浏览器加载聊天会 POST `/api/turn-credentials`；接口失败时自动回退到静态 STUN/`NEXT_PUBLIC_TURN_*`，ICE 直连进入 `failed` 且没有可用 TURN 时会明确显示“直连失败（未配置 TURN）”。

示例：

```dotenv
NEXT_PUBLIC_TURN_URLS=turn:turn.example.com:3478?transport=udp,turn:turn.example.com:3478?transport=tcp,turns:turn.example.com:443?transport=tcp
NEXT_PUBLIC_TURN_USERNAME=<短时用户名>
NEXT_PUBLIC_TURN_CREDENTIAL=<短时凭证>
```

验收时应覆盖：不同运营商、家庭宽带与蜂窝网络、公司网络、UDP 禁用场景。连接后页面显示“TURN 加密中继”表示浏览器统计中的实际选中 Candidate Pair 含 relay；还应双向发送数据并在 TURN 服务端监控连接数、地域和流量。完整证据链见[常见问题与网络排障 FAQ](faq.md)。

## 7. 中国大陆稳定访问

`*.vercel.app` 和海外 WebSocket/ICE 服务无法保证在中国大陆稳定可达。仅修复前端代码不能解决跨境链路、DNS、运营商策略和 UDP 可用性。

### 正式稳定方案

1. 使用自有域名并完成 ICP 备案。
2. 把静态站点部署到中国大陆合规云/CDN节点。
3. 把信令服务部署到大陆可稳定访问的 WebSocket 服务；可继续用 Broadcast 模型，但不要依赖单一海外域名。
4. 在大陆及邻近区域部署 TURN，开放 UDP/TCP/TLS 443，并使用短时凭证。
5. 建立中国电信、联通、移动和教育网的真实探测与连接成功率监控。

当前已经按 [双活信令方案](signaling-resilience.md) 增加同源 Vercel HTTPS 通道。它能处理“页面可达但客户端 Supabase WebSocket 不可达”的情况；若 Vercel 本身也不可达，仍需把页面与同源信令迁移到大陆合规托管或增加另一个共同可达入口。

Vercel 官方也明确给出面向中国访问时使用自定义域名和面向中国优化 CDN/托管方案的建议，参见 [Accessing Vercel-hosted sites from mainland China](https://vercel.com/kb/guide/accessing-vercel-hosted-sites-from-mainland-china)。需要使用中国大陆 CDN 节点时通常涉及 ICP 备案；可参考 [阿里云 ICP 备案说明](https://www.alibabacloud.com/help/en/icp-filing/basic-icp-service/user-guide/icp-filing-application-overview)。

### 过渡方案

可先使用自有域名、香港或新加坡静态托管、邻近区域 Supabase/信令和香港 TURN。这通常比默认 `vercel.app` 好，但仍经过跨境链路，不能承诺中国大陆稳定访问。

## 8. 发布前检查

```bash
npm run typecheck
npm run build
```

浏览器至少检查：

1. 创建房间并复制完整邀请链接；
2. 第二个浏览器/设备加入，双方显示直连或 TURN；
3. 双向文字消息；
4. 1.5 MB 内图片与录音；
5. 刷新后从本地密文恢复；
6. 已连接的两个页面都保持 peer lock，第三个页面收到 `rejected(room-full)`；
7. 新建会话后旧身份锁、消息和连接状态被清理；
8. 清空历史只影响当前设备；
9. 浏览器 Console 无错误；
10. `/api/signal` 显示 `configured:true`，Vercel Function 与 Redis 无异常日志。
11. 分别阻断 Supabase 和 `/api/signal`，确认任意一条信令仍能完成握手。

## 9. 依赖与变更注意事项

当前关键版本见 `package.json` 和 `package-lock.json`。Supabase 变更较快，升级前应检查 [Supabase Changelog](https://supabase.com/changelog) 和 Broadcast 文档。浏览器端运行不受旧 Node.js transport 变更影响；Supabase JavaScript 客户端已经停止支持 Node.js 20，因此本项目声明 Node.js 22 或更高版本。
