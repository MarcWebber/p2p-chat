# 代码规模与复杂度基线

这份文档记录代码规模变化，用来防止“小功能靠堆状态和日志膨胀成大文件”。统计对象是独立仓库 `twoonly`，不包含父目录 `brainstorm` 的其他项目。

## 2026-08-11 全局第二轮清理

对比基准为提交 `ddf872d`。这一轮按调用关系检查了 `app`、`components`、`src` 和统计脚本，没有只压缩 WebRTC，也没有把代码换个文件继续计数。

| 指标 | 修改前 | 修改后 | 变化 |
| --- | ---: | ---: | ---: |
| 应用源代码行数 | 3,658 | 3,473 | -185（-5.1%） |
| 应用源文件 | 28 | 27 | -1 |
| `WebRtcSession.ts` | 758 | 717 | -41（-5.4%） |
| WebRTC 会话与统计模块合计 | 832 | 778 | -54（-6.5%） |
| `signalTransport.ts` | 332 | 283 | -49（-14.8%） |
| TypeScript/React 函数或方法 | 236 | 219 | -17（-7.2%） |
| 圈复杂度代理总和 | 769 | 743 | -26（-3.4%） |
| 圈复杂度代理平均值 | 3.26 | 3.39 | +0.13 |
| 单函数最高复杂度代理 | 21 | 21 | 不变 |

平均复杂度略升不是主流程变复杂，而是优先删除了大量复杂度为 1 的包装函数，分母下降得更快。总复杂度、函数数和代码量都下降；最高点仍是边界处的运行时信令校验，后续如果要动它，目标应是保持校验强度，而不是单纯压数字。

主要减法包括：删除没有行为的 WebRTC `start()` 与一次性错误转发方法；统一 SDP 重发和 ICE Candidate 应用；让定时器共用一个清理入口；删除只转发一次的 Candidate key 别名；让信令的 Supabase 与 BroadcastChannel 共用入站校验和收发诊断；移除聊天 Hook 中未被读取的 transport ref、无收益的 `useMemo` / `useCallback`；把只负责再转发一层的 `TwoOnlyView` 合回客户端入口；并用浏览器自带的 RTC Stats 类型替代手写字段镜像。

加密编解码、信令结构校验、存储 key、Peer/Negotiation 过期检查等短函数仍然保留。它们虽然短，但承担输入校验、数据格式或异步一致性边界，内联反而会让主流程更难审查。

从最初 1,284 行单体 WebRTC 会话到本轮结束，`WebRtcSession.ts` 已降到 717 行；把 61 行纯统计模块算上，WebRTC 会话与统计合计 778 行，累计净减 506 行（-39.4%）。同期应用源代码从 4,110 行降到 3,473 行，累计净减 637 行（-15.5%）。

## 2026-08-11 WebRTC 状态机瘦身

对比基准为提交 `84570bc`。这次不是把大文件原样搬进更多文件：主会话删除 526 行，只新增 74 行纯统计模块，WebRTC 模块净减少 452 行。

| 指标 | 修改前 | 修改后 | 变化 |
| --- | ---: | ---: | ---: |
| 应用源代码行数 | 4,110 | 3,658 | -452（-11.0%） |
| `WebRtcSession.ts` | 1,284 | 758 | -526（-41.0%） |
| WebRTC 会话与统计模块合计 | 1,284 | 832 | -452（-35.2%） |
| `WebRtcSession` 状态字段 | 36 | 16 | -20 |
| 会话内诊断调用 | 61 | 36 | -25 |
| 最大方法行数 | 138 | 66 | -72 |
| 圈复杂度代理总和 | 792 | 769 | -23 |
| 圈复杂度代理平均值 | 3.43 | 3.26 | -0.17 |

具体做法：用一个 `phase` 替代分散的生命周期布尔值；用 `PeerLock` 和 `Negotiation` 各保存一份身份与协商状态；删除一次性 Hello 回复集合，改为双方在连接前周期广播；日志和 UI 状态改走统一入口；Candidate/连接路径统计拆成无状态纯函数。双标签、双向消息、第三页拒绝和单边刷新重连均做了浏览器回归。

## 初始模块化基线

### 快照

快照提交：`d4370d67b3fd1dcf33715498cfc27d60a58164e8`（`refactor: modularize TwoOnly architecture`）

统计日期：2026-08-09

| 指标 | 数值 |
| --- | ---: |
| Git 跟踪文件 | 40 |
| 其中文本文件 | 37 |
| 跟踪文本总行数 | 4,077 |
| 跟踪文件总大小 | 1,106,865 bytes（约 1.06 MiB） |
| 应用源文件（`app`、`components`、`src`） | 24 |
| 应用源代码行数 | 1,957 |
| TypeScript/React 函数或方法 | 132 |
| 圈复杂度代理总和 | 325 |
| 圈复杂度代理平均值 | 2.46 |
| 单函数最高复杂度代理 | 36 |

这里的“应用源代码行数”只统计 `app/`、`components/` 和 `src/` 下的 TypeScript、TSX、CSS 文件；文档、配置、图片和依赖锁文件另行计入跟踪文件总量。图片资源占据约 963 KB，主要来自 `public/og.jpg` 和 `public/og.png`。

### 目录分布

| 目录 | 文件数 | 文本行数 | 文件大小 |
| --- | ---: | ---: | ---: |
| `app` | 3 | 528 | 15,679 bytes |
| `components` | 1 | 9 | 232 bytes |
| `src` | 20 | 1,420 | 49,305 bytes |
| `docs` | 5 | 770 | 35,265 bytes |
| 根目录配置/说明 | 9 | 1,350 | 43,609 bytes |
| `public` 二进制资源 | 2 | — | 962,775 bytes |

应用代码中最大的文件是：

- `app/globals.css`：493 行；
- `src/webrtc/WebRtcSession.ts`：357 行；
- `src/chat/useTwoOnlyChat.ts`：268 行；
- `src/media/useAudioRecorder.ts`：85 行。

相比原先 919 行的单一 `TwoOnlyApp`，现在最大的业务 TypeScript 文件是 WebRTC 会话状态机，页面入口只有 9 行。

### 复杂度重点

复杂度脚本使用 TypeScript AST 计算一个可重复的代理值：基础值为 1，每个 `if`、循环、`catch`、条件表达式、`case` 以及 `&&`/`||`/`??` 分支增加 1。它不是完整的 SonarQube 或商业静态分析结果，适合做本项目内部的趋势比较。

当前最高的函数/方法：

| 文件 | 函数/方法 | 复杂度代理 |
| --- | --- | ---: |
| `src/webrtc/WebRtcSession.ts` | `processSignal` | 36 |
| `src/ui/MessageComposer.tsx` | `MessageComposer` | 10 |
| `src/ui/MessageList.tsx` | `MessageList` | 8 |
| `src/signal/types.ts` | `isSignalMessage` | 7 |
| `src/media/useAudioRecorder.ts` | 录音回调 | 6 |
| `src/chat/useTwoOnlyChat.ts` | `acceptWire` | 5 |

`processSignal` 是后续最值得继续拆分的点：可以按 `hello`、Offer/Answer、Candidate、拒绝分成独立处理器，但必须保留串行信令队列和协商 ID 过滤。

## 如何重新统计

统计脚本位于 [`scripts/code-metrics.mjs`](../scripts/code-metrics.mjs)，不依赖额外 npm 包：

```bash
npm run metrics
npm run metrics -- --json
```

脚本只统计 Git 已跟踪且当前仍存在的文件，因此工作区删除文件时也能直接运行；`.env.production`、`next-env.d.ts`、`.next/` 和 `node_modules/` 不会进入版本基线。新增模块后应先提交或暂存，再运行脚本，便于得到可复查的完整结果。
