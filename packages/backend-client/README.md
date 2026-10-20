# Backend RPC 客户端

命令和材料通过 `client.api.provenance.commands`、`client.api.provenance.materials` 与 `client.api.provenance.diagnostics` 调用，响应可用 `@home-agent/api/action-provenance` 的 schema 校验。参数和限制见[家庭运行时](../../docs/household-runtime.md#命令与供应商材料)。

显式历史采集遇到同设备、同接口的在途请求时，返回 HTTP 409、`mijia_collection_busy`；调用方检查错误并稍后重试。

```ts
import { createBackendClient } from "@home-agent/backend-client";

const client = createBackendClient("http://127.0.0.1:3000");
```

本包导出 RPC 客户端、`chatStreamContract` 与按 Workflow 选择的 `agentWorkflowStreamContracts`。运行时出口为 `dist/index.js`，声明出口为 `dist/index.d.ts`。Vite 构建浏览器模块，裁除服务端执行代码；`hono/client` 与 `zod` 保留为外部依赖。Schema 跟随 Agent 中负责相应行为的模块：Workflow 请求在 `workflow.ts`，空间规划内容在 `extension.ts`，会话结果与进度在 `session.ts`。客户端构建消费这些定义，不另维护一份字段定义。Workflow 资源和空间规划扩展在服务端创建时初始化；导入 schema 不执行这些初始化，浏览器构建可裁除未使用的执行代码，无需在业务源码中添加打包注释。

Turbo 为本包构建以及 Web／Agent Host 的检查、构建与开发安排生成顺序。直接运行消费项目的类型检查或 lint 前，从仓库根目录执行：

```sh
bunx turbo run build --filter=@home-agent/backend-client
```

JavaScript 和声明产物不提交 Git，由构建缓存保存和恢复。本包构建等待 Backend 的 `build:rpc`，不启动完整 Backend、Web 或感知构建。Web／Agent Host 的 Turbo 开发任务同时运行 Backend 的 `dev:rpc` 以及本包的 `dev:types`、`dev:runtime`，更新路由声明、客户端声明和浏览器模块。单独运行子项目脚本时需自行维持声明监听任务。

Web 负责 UI 错误、Blob、响应校验、期限、容量与显式重试处理；RPC 类型推导不替代运行时校验。
