# Observability

当前实现采用官方 OpenTelemetry（OTel）`NodeSDK`、`@hono/otel` 和原生 span processor（负责处理及导出追踪记录的组件）。backend 与 Agent 分别启动 NodeSDK，由 SDK 管理上下文和 W3C 追踪传播。模型、Agent 运行、工具使用 OTel GenAI 语义约定，通过 `gen_ai.operation.name` 分别记录 `chat`、`invoke_agent` 和 `execute_tool`；HTTP 等待使用普通 span。这些约定当前处于 Development（尚未稳定）阶段。未配置导出目的地时不导出数据。通用 OTel 导出保留 SDK 采样留下的 HTTP、业务操作和模型记录；Langfuse 使用独立处理组件，仅导出 Agent 执行相关记录。

空间规划的公开 `session_id` 复用原生 `ProviderDoc.sessionId`，这是 Pi 为一个 Conversation 保存的提供方会话标识。本项目同时用它填充业务、模型和观察器记录的 `session.id` 与 `gen_ai.conversation.id`，属于显式关联策略，不表示 Pi 提供方会话与 Langfuse Session 定义相同；观察器另用 `pi.durable.conversation_id` 记录内部数字会话 ID。每轮 `spatial-planning.run` 记录草稿修订号、空间／通道数量和问题数量。开启 `OTEL_INCLUDE_CONTENT` 后，业务输入包含本轮完整请求及原始图片，输出包含回答、澄清问题和完整草稿；模型仍采集实际发送的消息及图片。模型、业务与 Durable 运行／工具 span 都登记停机等待并在各自有限操作结束时关闭。

## 配置

在根目录 `.env` 中配置追踪，应用启动见[本地运行](../../docs/running.md)。可选的本地 Langfuse 与依赖统一由 `home-agent` Compose 项目管理，开关及初始化见[本地 Langfuse](../../docs/running.md#可选的本地-langfuse)。

本地查看 spans：

```dotenv
OTEL_TRACES_EXPORTER=console
LANGFUSE_TRACING_ENABLED=false
```

直接导出到 Langfuse：

```dotenv
OTEL_TRACES_EXPORTER=otlp
LANGFUSE_PUBLIC_KEY=你的项目公钥
LANGFUSE_SECRET_KEY=你的项目密钥
# LANGFUSE_BASE_URL=https://cloud.langfuse.com
```

两个服务必须使用同一 Langfuse 项目的公钥、密钥和服务地址。省略 `OTEL_TRACES_EXPORTER` 时，配置通用 Collector 地址或启用 Langfuse 项目密钥会自动启用 `otlp`，否则默认关闭；显式 `none` 关闭所有追踪导出。`LANGFUSE_TRACING_ENABLED` 默认 `true`，填写两个项目密钥后启用 Langfuse；设置为 `false` 仅关闭 Langfuse，通用 console 或 Collector 导出仍按自身配置运行。该开关可写入 `.env`，也可在根启动命令前通过进程环境覆盖，例如 `LANGFUSE_TRACING_ENABLED=false OTEL_TRACES_EXPORTER=console bun run start`。默认服务地址为 `https://cloud.langfuse.com`；`COMPOSE_PROFILES` 包含 `langfuse` 时默认使用 `http://localhost:${LANGFUSE_PORT}`（端口默认 3001）。显式地址优先于本地默认；其他区域或自托管实例通过 `LANGFUSE_BASE_URL` 设置其基址，不含 API 路径。默认关闭模型输入输出采集；需要在 Langfuse 检查对话内容时设置 `OTEL_INCLUDE_CONTENT=true`，这也会包含详细异常消息。

无需 Collector（集中接收并转发追踪数据的服务）即可使用。若已经有 Collector，设置完整的 `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`，例如 `http://127.0.0.1:4318/v1/traces`，或设置不含信号路径的 `OTEL_EXPORTER_OTLP_ENDPOINT`。自定义 endpoint 使用 OTLP/HTTP protobuf exporter 和标准 `OTEL_EXPORTER_OTLP_TRACES_HEADERS` / `OTEL_EXPORTER_OTLP_HEADERS`（逗号分隔、值可 URL 编码），不会自动收到 Langfuse 密钥。应用可同时把完整的已采样记录发送到该 Collector，把 Agent 相关记录直接发送到 Langfuse；两套认证配置独立。通用 endpoint 应指向 Collector 或 APM（应用性能监控平台）。Collector 若另行转发给 Langfuse，须在该转发通路按 `home_agent.trace.agent=true` 过滤并配置认证；不要把通用 endpoint 直接指向同一个 Langfuse 接收地址，以免绕过筛选或重复发送。

媒体不单独上传到 Langfuse 对象存储；开启内容采集时图片原始 base64 随模型 span 发给目标 exporter。大图片会增大 OTLP 请求体，接收端限制及 Langfuse 媒体展示尚未实机验证；本项目不保证原生 OTLP 图片在界面中自动渲染。

## 追踪链路

本地子 span 继承父 span 的执行标记；跨服务通过 W3C baggage（随请求传播的上下文条目）中的 `home-agent-agent-trace=true` 传递。`tracedFetch` 使用原生注入能力传递 traceparent、tracestate 与 baggage；Durable 恢复父 span 而没有恢复 baggage 时，从本地执行标记重建该条目，因此 Agent 回查任意 Backend 业务接口仍保留关联子调用。默认 NodeSDK propagator 包含 tracecontext 与 baggage；显式配置 `OTEL_PROPAGATORS` 时须保留这两项。不会因为父调用未采样而更换 trace ID；未采样调用仍遵循 SDK 采样策略，Agent 标记不强制采样。

有效追踪上下文的响应头 `x-trace-id`、错误响应和 Backend 请求日志中的 `trace_id` 可关联同一次调用，不依赖该调用是否导出到 Langfuse，也不依赖采样位。Backend HTTP 日志记录所有请求的方法、路径、响应状态和处理耗时，不记录 URL query、请求头或请求正文；耗时截止于响应创建，不代表 SSE 或媒体连接的完整持续时间。

```text
backend 接收: POST /api/chat              SERVER
└─ backend → agent: POST /api/chat        CLIENT（直到响应体读完或取消）
   └─ agent 接收: POST /api/chat          SERVER
      └─ household-assistant.run         本次任务与等待
         └─ invoke_agent household-assistant
            ├─ chat {模型 ID}            模型请求
            └─ execute_tool {工具名}     工具执行
```

上述父子链适用于已保存单一输入来源的 Durable 运行。运行创建时存在多个来源，则使用新的 trace 并添加 OTel links（跨 trace 的来源关联）；运行开始后接纳的新输入保留初始父级，同时补充来源 links。`pi.durable.inputs`、主提交 ID、任务 ID 和工具调用 ID 保留在元数据中。未保存的来源不能重建其追踪上下文；本项目也不承诺 Langfuse 界面展示 links。多轮 Session 分组不要求各轮共用一个 trace。

主助手的会话 ID 由 Agent 创建，聊天请求只携带消息；新建空间规划的会话 ID 也在 Agent 内产生。因此 Backend 只能从 Agent 响应取得这些请求的会话 ID。Agent 在响应的 `x-home-agent-session-id` 中返回已确认的 ID，并补上本次仍在记录的 HTTP 入口属性；Backend 收到后为对应的 CLIENT 和 HTTP 入口补上该属性，后续子调用沿用该 Session。这个内部响应头只用于按 Session 查找 HTTP 记录，Backend 不把它返回浏览器；HTTP 调用树本身通过 trace ID 关联。

关联对象按请求创建，不使用全局 trace 映射；一个请求只绑定一个 Session，冲突的后续值不覆盖现有绑定。错误响应同样可关联已确认的会话。HTTP 请求结束时释放入口引用，Durable 保存提交来源时移除请求关联对象，继续持有独立的会话属性及原生父级。

在收到响应头前已经取消、超时或失联的上游记录可能没有 Session；Session 确定前已经结束的准备操作也不能事后补写。已结束的 span 不重开或重复导出，后台模型和工具仍按 Durable 自己确认的 Session 关联。多个真实 Session 在同一次 HTTP 请求内并行处理尚不属于当前接口语义。

一次性 workflow 调用链为 Backend SERVER → `tracedFetch` CLIENT → Agent `/api/workflows` SERVER → `automation-generation.run` 或 `speech-interpretation.run` 业务 span → `chat {模型 ID}` 模型 span，不创建 Durable 会话。空间规划消息使用 `spatial-planning.run` → `invoke_agent spatial-planning` → 模型／工具。业务 span 记录校验结果和澄清数；供应商实际 token 用量和费用只由模型 generation（一次模型生成记录）承担，用量缺失时不填充估算值。

Langfuse LLM-as-a-Judge（用模型按给定材料评分）需要显式将业务任务、结果和所需的 `metadata.evaluation_context` 字段映射为评测器输入。子观测位于同一 trace 或同一 Session，不代表评测器会自动读取它们。本模块只准备观测材料，不创建评测器、生成 score（评分记录）或管理评测运行。

通过 Langfuse Observations API 读取时，评测材料位于 `metadata` 的 `evaluation_context.generations` 和 `evaluation_context.tools` 两个键中；它们是带点号的键，不是客户端 JSON 对象的嵌套路径。使用实际返回字段配置评测映射。

Agent 的语音判断 workflow 保留模型 span，并接续 Backend 客户端传播的追踪上下文。模型调用记录 `gen_ai.request.model`、供应商返回的 `gen_ai.response.model`、token 用量和执行状态；供应商未返回实际模型标识时不填充响应字段，用量缺失时不估算。确认供应商返回合法用量后，复用 pi-ai 的归一化结果，按规范把普通输入、缓存读取与缓存写入相加写入 `gen_ai.usage.input_tokens`，输出总数写入 `gen_ai.usage.output_tokens`，缓存读取、缓存写入及推理输出另记为总数的子集。Langfuse 接收端将这些字段转换为互不重叠的计费分桶，并按模型定义推算成本；自定义模型需在 Langfuse 配置对应价格。本项目不把本地未知价格的零值当成实际成本。

模型参数只从 pi-ai 最终发送的 payload 中提取白名单字段，输出上限与标准采样参数写入 `gen_ai.request.*`，其他 thinking 等设置写入 `home_agent.request.*`；调用方的 `onPayload` 修改先完成，因此记录的是合并及覆盖后的实际参数，不包含凭据、请求头或完整 options。首个供应商事件记录 `gen_ai.response.time_to_first_chunk`（秒），表示首个流式块的等待时间。首个非空文本、思考或工具参数增量另记 `langfuse.observation.completion_start_time` 时间属性，供 Langfuse 计算首 token 延迟（TTFT）；该时间不计入初始化事件、空增量和纯用量事件。模型输入输出仅在内容采集开启时记录，转换为 `gen_ai.input.messages` / `gen_ai.output.messages` 的 `role/parts` 结构；文字、推理、工具调用及工具结果分别使用标准 part 类型，图片使用带 MIME 类型的 `blob` part 和原始 base64 字节。系统指令和工具定义分别通过消息结构及 `gen_ai.tool.definitions` 记录。

单次聊天在模型执行结束后返回 JSON，Backend 代理与 Agent HTTP 入口分别产生 CLIENT 与 SERVER span，`household-assistant.run` 记录本次任务、提交与等待。pi-durable 调度执行可以超过 HTTP 等待期；保存的提交来源允许有限的 `invoke_agent {Agent 名称}`、模型和工具保留原生父子关系，即使父等待 span 已结束。`pi.durable.submission` 记录提交状态，观察器保留会话、提交、任务、调用及已观察到的父工具关系。它不重建遗漏的历史执行；运行观察不完整时使用 `pi.durable.observation_incomplete=true`。

聊天取消或等待超时只结束本次等待，并尝试撤回仍排队的输入；已开始的执行继续运行。模型请求与每次工具执行另有独立期限，沿用 `AGENT_RUN_TIMEOUT_MS`；工具通过 Chord Context 的 AbortSignal 合作式取消，注入的领域工具必须响应这个信号，忽略信号的实现无法由此强制中止。workflow 将请求取消及执行期限传给模型，并在执行结束后复核取消。失败使用统一 HTTP JSON 错误：模型执行超时为 `run_timeout`，Backend 调用 Agent 超时为 `agent_timeout`，请求取消为 `request_cancelled`，模型执行失败为 `agent_execution_failed`。客户端已断开时不保证收到错误响应。当前上下文 SSE 的同步与断线语义见[家庭运行时](../../docs/household-runtime.md#agent-当前数据与材料历史)。

## 官方资料与实现依据

- [Hono OpenTelemetry 中间件](https://github.com/honojs/middleware/tree/main/packages/otel)
- [Hono streaming 生命周期](https://hono.dev/docs/helpers/streaming)
- [OTel JavaScript instrumentation](https://opentelemetry.io/docs/languages/js/instrumentation/)
- [OTel context propagation](https://opentelemetry.io/docs/languages/js/propagation/)
- [OTel GenAI Agent 与工具语义约定](https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/gen-ai-agent-spans.md)
- [OTel GenAI 输入消息结构](https://github.com/open-telemetry/semantic-conventions-genai/blob/main/model/gen-ai/gen-ai-input-messages.json)
- [Langfuse OTel 接收、属性映射与 Collector](https://langfuse.com/integrations/native/opentelemetry)
- [Langfuse OTel 接收实现](https://github.com/langfuse/langfuse/blob/main/packages/shared/src/server/otel/OtelIngestionProcessor.ts)
- [Langfuse token 用量分桶与成本计算](https://langfuse.com/docs/observability/features/token-and-cost-tracking)
- [工作区 Pi Durable 观察器](../pi-langfuse/README.md)
- [pi-ai 请求 payload 与供应商事件观察](https://github.com/earendil-works/pi/blob/main/packages/ai/README.md#debugging-provider-payloads)
