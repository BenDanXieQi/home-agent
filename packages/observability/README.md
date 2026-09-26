# Observability

当前实现采用标准 OpenTelemetry JS SDK、`@hono/otel` 和 OTLP/HTTP protobuf exporter。backend 与 Agent 各自有一个 Provider，使用 AsyncLocalStorage 上下文管理和 W3C `traceparent` / `tracestate` 传播。默认不导出数据；开启后默认记录全部 trace。

`@home-agent/observability` 提供 SDK 初始化、Hono 入口、`tracedFetch`、`withSpan`、关闭与导出能力，由 backend 和 Agent 接入。

## 配置

在根目录 `.env` 中配置追踪，应用启动见[本地运行](../../docs/running.md)。

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

## 追踪链路

响应头 `x-trace-id`、SSE `run_started.traceId` 和 backend 请求日志中的 `trace_id` 可关联同一次请求。backend HTTP 日志记录方法、路径、响应状态、处理耗时和 trace ID，不记录 URL query、请求头或请求正文；耗时截止于响应创建，不代表 SSE 或媒体连接的完整持续时间。

```text
backend POST /api/chat                   SERVER
└─ backend → Agent POST /api/chat        CLIENT（直到响应体读完或取消）
   └─ Agent POST /api/chat               SERVER
      └─ agent.run                      INTERNAL（完整 SSE 执行）
         └─ chat <model>                INTERNAL / LangSmith llm
```

模型 span 记录模型名、可获得的 token 用量和失败状态。`agent.run` 记录业务 run ID、首 token 耗时和取消状态。兼容模型服务未提供 usage 时不编造 token 数。没有生成逐 token span。

`@hono/otel` 的 SERVER span 在 Hono handler 返回时结束；它的耗时不是整个 SSE 的持续时间。检查流式耗时应查看 `agent.run` 和 backend CLIENT span。HTTP 200 后模型仍可能失败，检查 Agent 执行 span 与 `run_failed` 事件，而不能仅看 HTTP 状态。

超时或断开会触发 AbortSignal 并关闭 SSE，包括解除慢客户端导致的写入背压；这种情况下不保证收到最后一个事件。普通模型错误在连接仍可用时发送 `run_failed`。

退出时先停止接收请求并等待在途请求：backend 使用 `BACKEND_SHUTDOWN_TIMEOUT_MS`（默认 30 秒），Agent 为 30 秒；超时则强制关闭连接。追踪模块随后最多等待 10 秒让已登记操作结束，再关闭 exporter。这 10 秒不是整个进程的停机期限；数据库关闭和 exporter 导出另需时间。强制终止进程无法保证导出。

## 代码边界

- `apps/backend/src/chat/routes.ts`：受限 JSON 请求和 SSE 透明转发，不解析模型内容。
- `apps/backend/src/connections/status.ts`：使用 `tracedFetch` 检查 Agent 与 go2rtc，连接探测也会产生 HTTP span。
- `apps/backend/src/mijia/operation.ts`：米家业务操作的安全错误转换与 span，包括授权恢复、凭据保存和播放操作。
- `apps/backend/src/mijia/media/go2rtc-adapter.ts`：专用协议的 CLIENT span，只记录固定操作名、HTTP 方法、响应状态码与白名单错误分类。
- `apps/agent/src/http/chat.ts`：在请求上下文内运行完整 SSE 生命周期。
- `apps/agent/src/graph/home-agent.ts`：在实际模型调用边界生成 LLM span。

业务操作通过 `withSpan` 显式埋点；聊天转发和连接探测使用 `tracedFetch` 并消费或取消响应体。米家专用协议在完成错误脱敏后记录 CLIENT span，不记录目标 URL、账号凭据、请求／响应正文或 SDP，也不向 go2rtc 传播追踪上下文；这些 span 描述 backend 发起的调用，尚不包含 go2rtc 内部执行或视频媒体链路。LangGraph 节点、工具和 SDK 内部重试不会自动生成独立 span。

`mijia.session.restore` 覆盖授权读取、恢复与设备校验；`mijia.credentials.read`、`mijia.credentials.save` 和 `mijia.credentials.remove` 分别记录授权读取、导出与持久化、删除。操作失败先经过 span 边界，再转换为页面状态；HTTP 202 仅表示受理，后台结果应查看业务 span。米家业务与下游协议的 `error.type` 只使用各自已定义的静态错误码，内容采集关闭时仍可区分超时、授权拒绝和服务不可达。普通 HTTP 调用记录错误响应的状态码分类；无响应的未知传输错误使用通用分类，不读取任意异常对象的 `code`。

主动取消与故障分开记录：取消只标记 `operation.cancelled`，超时仍记为失败。恢复／绑定／源注册的后台退避、心跳和租约计时器在空的 `ROOT_CONTEXT` 下创建，后续工作不会持续附着在最初请求或安装的 trace 上。每次实际操作使用独立的短 span；同次有限操作内的调用仍保持父子关系，不为等待退避的整个生命周期持有一个 span。

`mijia.go2rtc.heartbeat.check` 覆盖完整心跳检查，包含其下的 HTTP CLIENT span、响应协议校验和租约判断。HTTP 200 不代表心跳业务成功；响应缺少合法的 `playbackIds` 等协议失败会在检查 span 中记录安全错误码和失败状态，再按 go2rtc 运行时会话的租约策略处理；该心跳不负责续期米家云账号凭据。

不填写 `langsmith.trace.id`、`langsmith.span.id` 等覆盖字段，保持原生 OTLP trace/span ID 和父子关系。保留整个祖先链，不只导出 LLM span：LangSmith 官方说明，引用了始终未导出父级的子 span 会过期丢失，即使接收请求返回 200。

项目使用通用 OTel ingestion，不启用 LangSmith REST callback。当前安装的 LangChain 会在四个 tracing 环境开关中任意一个为 `true` 时启用自动追踪，因此初始化时统一关闭这些触发开关，避免重复调用树和意外采集内容。追踪导出由 `OTEL_TRACES_EXPORTER` 控制。

当前服务默认只监听本机，无用户鉴权。对外开放前，应在可信入口处理外部传入的追踪上下文；随意接受一个未导出的外部 parent 也会影响 LangSmith 的完整树展示。

## 官方资料与实现依据

- [Hono OpenTelemetry 中间件](https://github.com/honojs/middleware/tree/main/packages/otel)
- [Hono streaming 生命周期](https://hono.dev/docs/helpers/streaming)
- [OTel JavaScript instrumentation](https://opentelemetry.io/docs/languages/js/instrumentation/)
- [OTel context propagation](https://opentelemetry.io/docs/languages/js/propagation/)
- [LangSmith OTel 接收、属性映射、Collector 与父子关系](https://docs.langchain.com/langsmith/trace-with-opentelemetry)
