# 代码规模与复杂度基线

这份文档记录模块化重构完成后的第一份基线，用来和后续功能开发对比。统计对象是独立仓库 `twoonly`，不包含父目录 `brainstorm` 的其他项目。

## 快照

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

## 目录分布

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

## 复杂度重点

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

脚本只统计 Git 已跟踪文件，因此 `.env.production`、`next-env.d.ts`、`.next/` 和 `node_modules/` 不会进入版本基线。新增模块后应先提交或暂存，再运行脚本，便于得到可复查的完整结果。
