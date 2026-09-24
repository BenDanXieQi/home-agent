# 追踪接入

当前实现采用标准 OpenTelemetry JS SDK、`@hono/otel` 和 OTLP/HTTP protobuf exporter。backend 与 Agent 各自有一个 Provider，使用 AsyncLocalStorage 上下文管理和 W3C `traceparent` / `tracestate` 传播。默认不导出数据；开启后默认记录全部 trace。

## 运行

根目录复制 `.env.example` 为 `.env`，配置模型。`bun run dev` 同时启动 web、backend、Agent；`bun run start` 构建后启动 backend 和 Agent。浏览器界面仍只有健康状态，聊天目前通过 HTTP 使用：

```sh
curl -N http://127.0.0.1:3000/api/chat \
  -H 'Content-Type: application/json' \
  -d '{"message":"你好"}'
```

请求经过 backend 转发到 Agent。响应头 `x-trace-id`、SSE `run_started.traceId` 和 backend 请求日志中的 `trace_id` 可关联同一次请求。

本地查看 spans：

```dotenv
OTEL_TRACES_EXPORTER=console
```

直接导出到 LangSmith：

```dotenv
OTEL_TRACES_EXPORTER=otlp
LANGSMITH_API_KEY=你的密钥
LANGSMITH_PROJECT=home-agent
# 组织级密钥需指定 workspace
# LANGSMITH_WORKSPACE_ID=你的workspace-id
```

两个服务必须使用同一 LangSmith 项目、区域及 workspace。默认 API 为 `https://api.smith.langchain.com`；其他区域通过 `LANGSMITH_ENDPOINT` 设置其 API 基址（不含 `/otel`）。默认关闭模型输入输出采集；需要在 LangSmith 检查对话内容时设置 `OTEL_INCLUDE_CONTENT=true`，这也会包含详细异常消息。

无需 Collector 即可使用。若已经有 Collector，设置完整的 `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`，例如 `http://127.0.0.1:4318/v1/traces`，或设置不含信号路径的 `OTEL_EXPORTER_OTLP_ENDPOINT`。自定义 endpoint 使用标准 `OTEL_EXPORTER_OTLP_TRACES_HEADERS` / `OTEL_EXPORTER_OTLP_HEADERS`（逗号分隔、值可 URL 编码），不会自动收到 LangSmith 密钥。LangSmith 转发凭据配置在 Collector 中。

## 已覆盖的链路

```text
backend POST /api/chat                   SERVER
└─ backend → Agent POST /api/chat        CLIENT（直到响应体读完或取消）
   └─ Agent POST /api/chat               SERVER
      └─ agent.run                      INTERNAL（完整 SSE 执行）
         └─ chat <model>                INTERNAL / LangSmith llm
```

模型 span 记录模型名、可获得的 token 用量和失败状态。`agent.run` 记录业务 run ID、首 token 耗时和取消状态。兼容模型服务未提供 usage 时不编造 token 数。没有生成逐 token span。

`@hono/otel` 的 SERVER span 在 Hono handler 返回时结束；它的耗时不是整个 SSE 的持续时间。检查流式耗时应查看 `agent.run` 和 backend CLIENT span。HTTP 200 后模型仍可能失败，检查 Agent 执行 span 与 `run_failed` 事件，而不能仅看 HTTP 状态。

超时或断开会触发 AbortSignal 并关闭 SSE，包括解除慢客户端导致的写入背压；这种情况下不保证收到最后一个事件。普通模型错误在连接仍可用时发送 `run_failed`。退出时停止请求、给活跃执行最多 10 秒收尾，再关闭并 flush exporter。强制终止进程无法保证导出。

## 代码边界

- `packages/observability`：SDK 初始化、Hono 入口、`tracedFetch`、`withSpan`、关闭与导出。
- `apps/backend/src/chat.ts`：受限 JSON 请求和 SSE 透明转发，不解析模型内容。
- `apps/agent/src/http/chat.ts`：在请求上下文内运行完整 SSE 生命周期。
- `apps/agent/src/graph/home-agent.ts`：在实际模型调用边界生成 LLM span。

新增工具、数据库或设备操作时，在对应业务边界调用 `withSpan`；内部服务 HTTP 调用使用 `tracedFetch` 并消费或取消响应体。它目前不是任意 LangGraph 节点、工具和 SDK 内部重试的自动埋点器。当前只有一个模型节点，所以显式边界足够覆盖现有应用。

不填写 `langsmith.trace.id`、`langsmith.span.id` 等覆盖字段，保持原生 OTLP trace/span ID 和父子关系。保留整个祖先链，不只导出 LLM span：LangSmith 官方说明，引用了始终未导出父级的子 span 会过期丢失，即使接收请求返回 200。

项目不启用 LangSmith REST callback；初始化时关闭环境变量触发的 LangChain/LangSmith 自动 tracing，避免重复调用树。LangSmith JS 的 experimental OTel 路线不能直接视为 LangGraph callback 的替代：当前安装版本的 translator 会使用已有 active span，并不会替每个 callback 创建独立 span。本实现使用官方支持的通用 OTel ingestion。

当前服务默认只监听本机，无用户鉴权。对外开放前，应在可信入口处理外部传入的追踪上下文；随意接受一个未导出的外部 parent 也会影响 LangSmith 的完整树展示。

## 官方资料与实现依据

- [Hono OpenTelemetry 中间件](https://github.com/honojs/middleware/tree/main/packages/otel)
- [Hono streaming 生命周期](https://hono.dev/docs/helpers/streaming)
- [OTel JavaScript instrumentation](https://opentelemetry.io/docs/languages/js/instrumentation/)
- [OTel context propagation](https://opentelemetry.io/docs/languages/js/propagation/)
- [LangSmith OTel 接收、属性映射、Collector 与父子关系](https://docs.langchain.com/langsmith/trace-with-opentelemetry)
- [LangSmith JS OTel 支持范围说明](https://support.langchain.com/articles/7335403634-how-do-i-use-opentelemetry-otel-with-langsmith)（历史支持文章，接入时也核对了安装版本源码）
- [上下文传播讨论 #1725](https://github.com/langchain-ai/langsmith-sdk/issues/1725)（Python 历史案例，用于区分导出与执行上下文）
