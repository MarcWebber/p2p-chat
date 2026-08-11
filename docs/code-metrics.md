# 代码规模与复杂度基线

这份文档只保留当前可复查快照，不再堆叠每轮清理流水账。历史变化已经保存在 Git 提交中；需要重新统计时直接运行 `npm run metrics`。

## 当前快照

统计日期：2026-08-11；基线提交：`3696ce4f3277c1296cbb3b67fd98d282cc4cc1fc`

| 指标 | 当前值 |
| --- | ---: |
| Git 跟踪文件 | 67 |
| 跟踪文本总行数 | 7,823 |
| 应用源文件 | 40 |
| 应用源代码行数 | 4,124 |
| TypeScript/React 函数或方法 | 260 |
| 圈复杂度代理总和 | 866 |
| 圈复杂度代理平均值 | 3.33 |
| 单函数最高复杂度代理 | 24 |

“应用源代码”只统计 `app/`、`components/` 和 `src/` 中的 TypeScript、TSX、CSS 与 MJS；不包含 Markdown、图片、依赖锁文件、`.next/` 和 `node_modules/`。

| 目录 | 应用代码行数 |
| --- | ---: |
| `app` | 754 |
| `components` | 12 |
| `src` | 3,358 |

## HTTPS 双活信令带来的增量

与加入 HTTPS 路径前的提交 `1107cb7` 相比，应用源码增加 826 行、删除 227 行，净增加 599 行。这个数字包含模块移动，不等于 599 行全是新行为：原 Supabase 传输从聚合器中拆成了独立的 161 行模块。

主要模块当前规模：

| 模块 | 行数 | 职责 |
| --- | ---: | --- |
| `signal/signalTransport.ts` | 200 | 双通道聚合、健康状态与去重 |
| `signal/supabaseSignalTransport.ts` | 161 | Realtime WebSocket 适配器 |
| `signal/httpsSignalTransport.ts` | 184 | 密文发布、短轮询和恢复 |
| `signal/httpsSignalProtocol.ts` | 71 | 不可信 HTTP 数据校验 |
| `signal/serverSignalStore.ts` | 78 | Upstash Redis Stream 存取 |
| `app/api/signal/route.ts` | 76 | 同源 HTTPS Route Handler |
| `crypto/aesGcm.ts` | 53 | 聊天与信令共用 AES-GCM |
| `server/requestSecurity.ts` | 12 | Route 同源检查 |

Vercel Marketplace 曾在工作区生成约 3,521 行 `.agents/skills` 参考资料。它们不参与构建，已删除并通过 `.gitignore` 排除，不计入上述基线。

## 当前复杂度热点

| 文件 | 函数 | 圈复杂度代理 |
| --- | --- | ---: |
| `src/signal/types.ts` | `isSignalMessage` | 24 |
| `src/signal/httpsSignalTransport.ts` | `poll` | 21 |
| `src/webrtc/WebRtcSession.ts` | `processSignal` | 20 |
| `src/webrtc/iceConfig.ts` | `resolveIceConfiguration` | 18 |
| `src/signal/signalTransport.ts` | `updateAggregateState` | 17 |

这些热点分别处在不可信输入校验、异步轮询、协商状态机、ICE 配置和多供应商状态汇总边界。继续清理时应优先减少状态与分支，不要为了压行数删除校验、重连代际或资源释放逻辑。

## 维护约束

- 只有出现明确职责边界或第二个真实调用方时才新增模块；
- 不为几行转发逻辑创建别名或薄包装；
- 配置统一进入 `src/config`，通用无状态行为进入 `src/utils`；
- 删除能力时同时删除配置、状态、日志、UI 和文档，不保留空兼容层；
- 每次较大改动后运行 `npm run metrics`，用趋势而不是单次行数判断复杂度。

统计脚本位于 [`scripts/code-metrics.mjs`](../scripts/code-metrics.mjs)，使用 TypeScript AST 计算一个项目内可重复比较的圈复杂度代理值：

```bash
npm run metrics
npm run metrics -- --json
```
