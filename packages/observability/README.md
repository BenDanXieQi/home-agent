# Observability

当前实现采用标准 OpenTelemetry JS SDK、`@hono/otel` 和 Langfuse `LangfuseSpanProcessor`。backend 与 Agent 分别创建 Provider，使用 AsyncLocalStorage 上下文管理和 W3C `traceparent` / `tracestate` 传播。默认不导出数据；开启后记录完整的追踪树，包括 HTTP、业务操作和模型调用。

`@home-agent/observability` 提供 SDK 初始化、Hono 入口、`tracedFetch`、`withSpan`、原生 Request 入口及关闭与导出能力，由 backend 与 Agent 接入。应用直接通过 `@earendil-works/pi-ai` 创建模型和服务提供者；`observeProvider()` 在原生服务提供者上增加 Langfuse 模型观测，并保持原生 pi-ai 调用方式。

## 配置

在根目录 `.env` 中配置追踪，应用启动见[本地运行](../../docs/running.md)。

本地查看 spans：

```dotenv
OTEL_TRACES_EXPORTER=console
```

直接导出到 Langfuse：

```dotenv
OTEL_TRACES_EXPORTER=otlp
LANGFUSE_PUBLIC_KEY=你的项目公钥
LANGFUSE_SECRET_KEY=你的项目密钥
# LANGFUSE_BASE_URL=https://cloud.langfuse.com
```

两个服务必须使用同一 Langfuse 项目的公钥、密钥和服务地址。默认服务地址为 `https://cloud.langfuse.com`；其他区域或自托管实例通过 `LANGFUSE_BASE_URL` 设置其基址，不含 API 路径。默认关闭模型输入输出采集；需要在 Langfuse 检查对话内容时设置 `OTEL_INCLUDE_CONTENT=true`，这也会包含详细异常消息。

无需 Collector（集中接收并转发追踪数据的服务）即可使用。若已经有 Collector，设置完整的 `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`，例如 `http://127.0.0.1:4318/v1/traces`，或设置不含信号路径的 `OTEL_EXPORTER_OTLP_ENDPOINT`。自定义 endpoint 使用 OTLP/HTTP protobuf exporter 和标准 `OTEL_EXPORTER_OTLP_TRACES_HEADERS` / `OTEL_EXPORTER_OTLP_HEADERS`（逗号分隔、值可 URL 编码），不会自动收到 Langfuse 密钥。Langfuse 转发凭据配置在 Collector 中。

## 追踪链路

响应头 `x-trace-id` 和 backend 请求日志中的 `trace_id` 可关联同一次请求。backend HTTP 日志记录方法、路径、响应状态、处理耗时和 trace ID，不记录 URL query、请求头或请求正文；耗时截止于响应创建，不代表 SSE 或媒体连接的完整持续时间。

```text
backend POST /api/chat                   SERVER
└─ backend → Agent POST /api/chat        CLIENT（直到响应体读完或取消）
   └─ Agent POST /api/chat               SERVER
```

Backend 与 Agent 的 Hono HTTP 入口先执行 `httpTracing()`，接收上游 W3C 追踪上下文并创建 SERVER span，再执行路由的本机访问及输入校验。因此被访问校验拒绝的请求也经过追踪中间件；开启追踪时，响应包含同一 `x-trace-id`。HTTP 入口 span 的耗时截止于响应创建，不代表响应流的完整持续时间。

workflow 调用链为 Backend SERVER → `tracedFetch` CLIENT → Agent `/api/workflows` SERVER → `automation.generate` 业务 span → `model.generate` 模型 span。业务 span 记录草稿校验结果、能力校验问题数和澄清数；模型 span 记录供应商返回的 token 用量，无用量时不填充估算值。正文仅在 `OTEL_INCLUDE_CONTENT=true` 时采集。

backend 的语音模型解释器保留模型 span。模型调用使用 `generation` 观测类型，记录模型标识、供应商返回的 token 用量和执行状态；用量缺失时不估算。确认供应商返回合法用量后，复用 pi-ai 的归一化结果，把普通输入、缓存读取、缓存写入和推理输出分成互不重叠的 Langfuse `usage_details` 字段，避免把缓存命中按普通输入价格计算。成本由 Langfuse 的模型定义推算；自定义模型需在 Langfuse 配置对应价格，不把本地未知价格的零值当成实际成本。

模型参数只从 pi-ai 最终发送的 payload 中提取白名单字段，保留输出上限、temperature、采样和 thinking 设置；调用方的 `onPayload` 修改先完成，因此记录的是合并及覆盖后的实际参数，不包含凭据、请求头或完整 options。首个非空文本、思考或工具参数增量设置 `completionStartTime`，供 Langfuse 计算首 token 延迟（TTFT）；初始化事件、空增量和纯用量事件不计入。模型输入输出仅在内容采集开启时记录；输入使用 pi-ai 的消息记录，其中系统消息包含系统指令和工具定义。

`observeProvider()` 只记录模型观测，不修改 pi-ai 的事件、工具参数或完成状态。Completions 与 Responses 均使用 pi-ai 原生解析；原生解析可能修补参数 JSON，因此不额外承诺原始 JSON 字节完整。pi-durable 按工具 schema 校验参数，自动化与语音判断另按业务 schema 校验结果。用量识别覆盖 Completions 的用量 chunk，以及 Responses 的 `response.completed` / `response.incomplete` 终态用量；缺失或为 `null` 的供应商用量不记录。

单次聊天在模型执行结束后返回 JSON，Backend 代理与 Agent HTTP 入口分别产生 CLIENT 与 SERVER span；pi-durable 运行产生 `agent` 观测，其模型调用、原生 `CodingTools`、前台委派及调用方提供的领域工具接入同一追踪上下文。工具通过官方 `wrapTool()` 接入 `tool` 观测，正常返回的工具错误也记录失败状态；工具优先记录 `structuredOutput`，否则记录显式 `output`，流式工具没有这两个字段时读取 `api.retainedOutput()`；同一输出正文不重复写入元数据。开启内容采集后，`bash` 的结构化输出包含退出码；工具返回的诊断单独记录，错误诊断写入状态说明。工具抛出异常时，按同一正文采集开关记录 `api.retainedOutput()` 中已保留的输出，再原样抛出异常，由追踪边界记录失败或取消。关闭内容采集时不记录任意工具诊断正文。

聊天与 workflow 将请求取消及执行期限通过 AbortSignal 传给模型，并在执行结束后复核取消。失败使用统一 HTTP JSON 错误：模型执行超时为 `run_timeout`，Backend 调用 Agent 超时为 `agent_timeout`，请求取消为 `request_cancelled`，模型执行失败为 `agent_execution_failed`。客户端已断开时不保证收到错误响应。当前上下文 SSE 的同步与断线语义见[家庭运行时](../../docs/household-runtime.md#agent-当前数据与材料历史)。

退出时先停止接收请求并等待在途请求：backend 使用 `BACKEND_SHUTDOWN_TIMEOUT_MS`（默认 30 秒），超时强制关闭连接；Agent 停止时立即关闭连接并取消请求。追踪模块随后最多等待 10 秒让已登记操作结束，再关闭 exporter。这 10 秒不是整个进程的停机期限；数据库关闭和 exporter 导出另需时间。强制终止进程无法保证导出。

## 代码边界

- `apps/backend/src/app.ts`、`apps/agent/src/app.ts`：Hono HTTP 入口、追踪中间件及统一错误响应装配。
- `apps/backend/src/chat/routes.ts`：受限 JSON 输入校验与聊天转发。
- `apps/backend/src/workflows/routes.ts`：生成请求的设备能力准备、运行失效取消及结果复核。
- `apps/backend/src/agent-client.ts`：聊天、workflow 与接收记录共用的 Agent 调用，使用 `tracedFetch` 传播追踪上下文并有界读取、校验响应。
- `apps/agent/src/chat.ts`：单次聊天执行、取消及期限、完整回答校验。
- `apps/agent/src/workflows/automation-generation/index.ts`：生成 workflow 的业务 span 与草稿校验属性。
- `packages/observability/src/model.ts`：原生 pi-ai 服务提供者的 generation span、供应商实际用量与失败状态。
- `apps/agent/src/runtime/index.ts`：Agent 应用内 pi-durable 运行与工具调用的观测。
- `apps/backend/src/connections/status.ts`：使用 `tracedFetch` 检查 Agent 与 go2rtc，连接探测也会产生 HTTP span。
- `apps/backend/src/mijia/operation.ts`：米家业务操作的安全错误转换与 span，包括授权恢复、凭据保存和播放操作。
- `apps/backend/src/mijia/media/go2rtc-adapter.ts`：专用协议的 CLIENT span，只记录固定操作名、HTTP 方法、响应状态码与白名单错误分类。
- `apps/backend/src/conversation/interpret.ts`：结构化模型调用的 span。

业务操作通过 `withSpan` 显式埋点；聊天转发和连接探测使用 `tracedFetch` 并消费或取消响应体。米家专用协议在完成错误脱敏后记录 CLIENT span，不记录目标 URL、账号凭据、请求／响应正文或 SDP，也不向 go2rtc 传播追踪上下文；这些 span 描述 backend 发起的调用，尚不包含 go2rtc 内部执行或视频媒体链路。pi-durable 内部调度和供应商 SDK 内部重试不会自动生成独立 span。

`mijia.session.restore` 覆盖授权读取、恢复与设备校验；`mijia.credentials.read`、`mijia.credentials.save` 和 `mijia.credentials.remove` 分别记录授权读取、导出与持久化、删除。操作失败先经过 span 边界，再转换为页面状态；HTTP 202 仅表示受理，后台结果应查看业务 span。米家业务与下游协议的 `error.type` 只使用各自已定义的静态错误码，内容采集关闭时仍可区分超时、授权拒绝和服务不可达。普通 HTTP 调用记录错误响应的状态码分类；无响应的未知传输错误使用通用分类，不读取任意异常对象的 `code`。

主动取消与故障分开记录：取消只标记 `operation.cancelled`，超时仍记为失败。恢复／绑定／源注册的后台退避、心跳和租约计时器在空的 `ROOT_CONTEXT` 下创建，后续工作不会持续附着在最初请求或安装的 trace 上。每次实际操作使用独立的短 span；同次有限操作内的调用仍保持父子关系，不为等待退避的整个生命周期持有一个 span。

`mijia.go2rtc.heartbeat.check` 覆盖完整心跳检查，包含其下的 HTTP CLIENT span、响应协议校验和租约判断。HTTP 200 不代表心跳业务成功；响应缺少合法的 `playbackIds` 等协议失败会在检查 span 中记录安全错误码和失败状态，再按 go2rtc 运行时会话的租约策略处理；该心跳不负责续期米家云账号凭据。

保持原生 OTLP trace/span ID 和父子关系。Langfuse processor 显式导出全部 span，保留模型观测的 HTTP 和业务祖先链，避免默认只保留模型 span 时形成断开的追踪树。模型 span 使用 `langfuse.observation.type=generation`；模型、用量和输入输出通过 Langfuse 支持的 OTel 属性映射展示。追踪导出由 `OTEL_TRACES_EXPORTER` 控制。

当前服务默认只监听本机，无用户鉴权。对外开放前，应在可信入口处理外部传入的追踪上下文；随意接受一个未导出的外部 parent 也会影响 Langfuse 的完整树展示。

## 官方资料与实现依据

- [Hono OpenTelemetry 中间件](https://github.com/honojs/middleware/tree/main/packages/otel)
- [Hono streaming 生命周期](https://hono.dev/docs/helpers/streaming)
- [OTel JavaScript instrumentation](https://opentelemetry.io/docs/languages/js/instrumentation/)
- [OTel context propagation](https://opentelemetry.io/docs/languages/js/propagation/)
- [Langfuse OTel 接收、属性映射与 Collector](https://langfuse.com/integrations/native/opentelemetry)
- [Langfuse span 过滤与完整追踪树](https://langfuse.com/docs/observability/sdk/advanced-features)
- [Langfuse token 用量分桶与成本计算](https://langfuse.com/docs/observability/features/token-and-cost-tracking)
- [pi-ai 请求 payload 与供应商事件观察](https://github.com/earendil-works/pi/blob/main/packages/ai/README.md#debugging-provider-payloads)
