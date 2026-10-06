# Backend RPC 客户端

`@home-agent/backend-client` 提供 Web 与 Agent 共用的 `createBackendClient`，使用 Hono 原生 `hc`，路径、参数与响应类型从 Backend 实际路由推导。它不启动服务，不拥有家庭状态、连接重试、模型或数据库，也不自动执行响应校验或读取响应正文。

```ts
import { createBackendClient } from "@home-agent/backend-client";

const client = createBackendClient("http://127.0.0.1:3000");
```

Backend 的 `src/rpc.ts` 输出路由类型，`build:rpc` 生成服务端声明；本包的 `build` 随后通过 TypeScript 自动推导并生成 `dist/index.d.ts`，展开整份客户端结构。Web 与 Agent 的类型检查读取这份声明，不再各自从 `BackendApp` 生成客户端结构。源码不手写返回类型或接口声明；运行时仍使用 `src/index.ts`，只加载 Hono，Backend 引用为 type import。

Turbo 为本包声明构建以及 Web／Agent 的检查、构建与开发安排生成顺序。直接运行消费项目的类型检查或 lint 前，从仓库根目录执行：

```sh
bunx turbo run build --filter=@home-agent/backend-client
```

声明输出不提交 Git，由构建缓存保存和恢复。客户端声明构建只等待 Backend 的 `build:rpc`，不启动完整 Backend、Web 或感知构建。Web／Agent 的 Turbo 开发任务同时运行 Backend 的 `dev:rpc` 和本包的 `dev:types`，路由声明变化后更新客户端声明；单独运行子项目脚本时需自行维持这两个 watcher。

服务间调用注入 `@home-agent/observability` 的 `tracedFetch`，JSON 响应通过 `@home-agent/api/http/request-json` 有界读取及校验。Web 保留自身的 UI 错误、Blob 和显式重试处理。调用方负责设置期限及容量；RPC 类型推导不替代运行时校验。

Agent 的 SSE 接收器用同一个 RPC 客户端建立订阅，重连和当前视图由接收器管理。历史与引用材料由 `apps/agent/src/context/reader.ts` 复核当前接收资格；这些领域规则不进入通用 RPC 客户端。
