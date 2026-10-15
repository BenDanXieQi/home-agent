# Observability

当前实现采用官方 OpenTelemetry（OTel）`NodeSDK`、`@hono/otel` 和原生 span processor（负责处理及导出追踪记录的组件）。backend 与 Agent 分别启动 NodeSDK，由 SDK 管理上下文和 W3C 追踪传播。模型、Agent 运行、工具使用 OTel GenAI 语义约定，通过 `gen_ai.operation.name` 分别记录 `chat`、`invoke_agent` 和 `execute_tool`；HTTP 等待使用普通 span。这些约定当前处于 Development（尚未稳定）阶段。未配置导出目的地时不导出数据。通用 OTel 导出保留 SDK 采样留下的 HTTP、业务操作和模型记录；Langfuse 使用独立处理组件，仅导出 Agent 执行相关记录。

pi-durable 会话、提交、运行及工具由工作区的 [`@home-agent/pi-langfuse`](../pi-langfuse/README.md) 观察器采集。`@home-agent/observability/durable` 的 `createDurableTracing()` 将观察器的 `TraceBackend`（观测记录的后端接口）接到共享 NodeSDK，保留 `pi.durable.*` 元信息，并映射 GenAI Agent 与工具属性。观察器在主会话、委派子会话及空间规划会话创建后附着，读取已提交事件。长期 Conversation（原生会话）只拥有 Session 关联，不导出覆盖整个会话寿命的根 span；有限的运行才导出 `invoke_agent`，工具归属于运行或已观察到的父工具，因此会话空闲时间不计入运行耗时。

业务 `.run` span 覆盖本次请求的提交、等待与结果校验。`tracing.submit()` 保存提交来源的 OTel 上下文，Generation／Tool hook 在原生运行开始时恢复显式父级；模型和实际工具执行沿用该运行的上下文，不依赖调度器偶然保留的 HTTP 上下文。模型由原生 pi-ai Provider（封装模型清单、认证和请求协议的服务提供者）上的 `observeProvider()` 采集完整请求、图片、实际用量和首 token 时间。观察器显式设置 `generations: "provider"`，只维护运行轮次及工具关系，不创建或投影模型生成记录，避免重复采集同一模型调用与用量。各轮 trace 通过 `session.id` 关联为 Session（多轮追踪分组），原生会话、提交和任务标识用于进一步定位。

空间规划的公开 `session_id` 复用原生 `ProviderDoc.sessionId`，这是 Pi 为一个 Conversation 保存的提供方会话标识。本项目同时用它填充业务、模型和观察器记录的 `session.id` 与 `gen_ai.conversation.id`，属于显式关联策略，不表示 Pi 提供方会话与 Langfuse Session 定义相同；观察器另用 `pi.durable.conversation_id` 记录内部数字会话 ID。每轮 `spatial-planning.run` 记录草稿修订号、空间／通道数量和问题数量。开启 `OTEL_INCLUDE_CONTENT` 后，业务输入包含本轮完整请求及原始图片，输出包含回答、澄清问题和完整草稿；模型仍采集实际发送的消息及图片。模型、业务与 Durable 运行／工具 span 都登记停机等待并在各自有限操作结束时关闭。

`@home-agent/observability` 提供 SDK 初始化、Hono 入口、`tracedFetch`、`withSpan`、`withGenAiContext`、`withEvaluation`、`withAgentTrace`、原生 Request 入口及关闭与导出能力；`@home-agent/observability/durable` 提供 `createDurableTracing`、模型／工具上下文恢复和 `observeDurableRegistry`。Pi 的 [TelemetryContext 回调契约](https://github.com/earendil-works/pi/blob/main/packages/telemetry/README.md) 与观测平台无关；本项目的模型适配使用 `onPayload`、`onProviderStreamEvent` 和 generation hook，Durable 工具的提交状态及结果由会话事件观察器采集。`wrapTool()` 为实际工具执行恢复对应工具 span 的上下文，家庭助手另用它设置执行期限。

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

console 模式使用 `SimpleSpanProcessor` 与 `ConsoleSpanExporter`；Collector 使用 `BatchSpanProcessor` 与 `OTLPTraceExporter`，按 OTLP/HTTP protobuf（OTel 的追踪传输协议）发送。Langfuse 的 `createLangfuseTraceExporter()` 使用官方 OTLP 导出基类、HTTP transport（负责网络发送、重试及超时的组件）和 protobuf 序列化组件，直接配置此目的地的地址与 headers。地址为 `${LANGFUSE_BASE_URL}/api/public/otel/v1/traces`，请求包含 protobuf 内容类型、公钥与密钥组成的 Basic Auth 认证，以及 `x-langfuse-ingestion-version: 4`；通用 `OTEL_EXPORTER_OTLP_*` 环境配置只作用于 Collector，Langfuse 使用原生默认的 10 秒导出期限、不压缩和保持连接配置。

`@opentelemetry/otlp-exporter-base` 与 `@opentelemetry/otlp-transformer` 使用已发布的模块入口，但上游将这些低层包标为内部使用；本仓库把它们与 OTLP exporter 统一锁定版本，升级时须一起核对接口及导出行为。项目适配只负责目的地配置，序列化、重试、并发与刷新仍由原生组件完成。Collector 与 console 无需 Langfuse 项目密钥。`console` 模式也可与 Langfuse 并行；只需本地输出时设置 `LANGFUSE_TRACING_ENABLED=false`。Langfuse 处理组件只负责入队前的 Agent 筛选，批量导出、刷新和退出仍复用原生 `BatchSpanProcessor`。关联属性通过 OTel context 传递，并由 `withSpan()` 写入各条记录，不依赖 Langfuse SDK。

媒体不单独上传到 Langfuse 对象存储；开启内容采集时图片原始 base64 随模型 span 发给目标 exporter。大图片会增大 OTLP 请求体，接收端限制及 Langfuse 媒体展示尚未实机验证；本项目不保证原生 OTLP 图片在界面中自动渲染。

## 追踪链路

SDK 使用原生及环境配置的采样策略；Agent 分类与是否采样、导出目的地分开。`AgentTraceMarker` 为记录添加 `home_agent.trace.agent=true`，只有 Langfuse 专用处理组件按该标记筛选，通用 console 和 Collector 处理组件不筛选。Backend 和 Agent 的 `POST /api/chat`、`POST /api/workflows` 在 HTTP 中间件内标记执行入口，包含访问及输入校验失败。Backend Agent 客户端通过 `withAgentTrace()` 标记聊天与 workflow，后台语音判断也归入执行链路。模型和 Durable 记录通过已有的 `gen_ai.operation.name` 或 `gen_ai.agent.name` 识别。独立健康检查、接收记录轮询、上下文 SSE 同步、设备操作、连接探测和媒体心跳只进入通用 OTel；执行中的这些子调用仍进入 Langfuse。接口的 `/api/agent` 前缀不作为唯一筛选依据。

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

Backend 与 Agent 的 Hono HTTP 入口先执行 `httpTracing("backend")` / `httpTracing("agent")`，接收上游 W3C 追踪上下文并创建 SERVER span，再执行路由的本机访问及输入校验。因此执行入口上被访问校验拒绝的请求也会记录；具有有效追踪上下文时，响应包含同一 `x-trace-id`。HTTP 入口 span 的耗时截止于响应创建，不代表响应流的完整持续时间。

上述父子链适用于已保存单一输入来源的 Durable 运行。运行创建时存在多个来源，则使用新的 trace 并添加 OTel links（跨 trace 的来源关联）；运行开始后接纳的新输入保留初始父级，同时补充来源 links。`pi.durable.inputs`、主提交 ID、任务 ID 和工具调用 ID 保留在元数据中。未保存的来源不能重建其追踪上下文；本项目也不承诺 Langfuse 界面展示 links。多轮 Session 分组不要求各轮共用一个 trace。

Session 由业务确认：主助手使用其进程内会话 ID；空间规划创建时读取原生提供方会话 ID，后续请求先核对会话存在及家庭 scope（会话所属家庭与运行代次），再绑定 Session。HTTP 执行入口不采用调用者携带的 Session。`withGenAiContext()` 保持每层关联属性独立，同时绑定当前请求的 Session；原生 span processor 将已确认的 Session 复制到后续观测，显式指定的 span 属性优先。Agent 与 Backend 的内部 `tracedFetch` 通过 W3C baggage（随追踪上下文传播的键值字段）中的 `home-agent-session-id` 传递 Session，其他目的地不携带这个字段。接收端只解析这一选定字段，不把任意 baggage 复制为观测属性；Session 只用于追踪，不参与鉴权或业务路由。

主助手的会话 ID 由 Agent 创建，聊天请求只携带消息；新建空间规划的会话 ID 也在 Agent 内产生。因此 Backend 只能从 Agent 响应取得这些请求的会话 ID。Agent 在响应的 `x-home-agent-session-id` 中返回已确认的 ID，并补上本次仍在记录的 HTTP 入口属性；Backend 收到后为对应的 CLIENT 和 HTTP 入口补上该属性，后续子调用沿用该 Session。这个内部响应头只用于按 Session 查找 HTTP 记录，Backend 不把它返回浏览器；HTTP 调用树本身通过 trace ID 关联。

关联对象按请求创建，不使用全局 trace 映射；一个请求只绑定一个 Session，冲突的后续值不覆盖现有绑定。错误响应同样可关联已确认的会话。HTTP 请求结束时释放入口引用，Durable 保存提交来源时移除请求关联对象，继续持有独立的会话属性及原生父级。

在收到响应头前已经取消、超时或失联的上游记录可能没有 Session；Session 确定前已经结束的准备操作也不能事后补写。已结束的 span 不重开或重复导出，后台模型和工具仍按 Durable 自己确认的 Session 关联。多个真实 Session 在同一次 HTTP 请求内并行处理尚不属于当前接口语义。

一次性 workflow 调用链为 Backend SERVER → `tracedFetch` CLIENT → Agent `/api/workflows` SERVER → `automation-generation.run` 或 `speech-interpretation.run` 业务 span → `chat {模型 ID}` 模型 span，不创建 Durable 会话。空间规划消息使用 `spatial-planning.run` → `invoke_agent spatial-planning` → 模型／工具。业务 span 记录校验结果和澄清数；供应商实际 token 用量和费用只由模型 generation（一次模型生成记录）承担，用量缺失时不填充估算值。

`withEvaluation()` 以 `langfuse.internal.is_app_root=true` 声明逻辑评测根。`household-assistant.run`、`spatial-planning.run`、`automation-generation.run` 和 `speech-interpretation.run` 在 `langfuse.observation.input/output` 记录本次业务任务与最终结果，并在 `langfuse.observation.metadata` 的 `evaluation_context` 中汇集实际模型输入及工具轨迹：`generations` 每项包含 `span_id`、GenAI `messages` 和实际 `tool_definitions`，`tools` 每项包含调用 ID、名称、参数、状态和已获得的结果，错误结果正文省略。这些内容仅在 `OTEL_INCLUDE_CONTENT=true` 且业务根仍在记录时采集；记录根结束后继续执行的后台工作不会补写已经结束的评测根。没有调用方评测根的 Durable 运行以提交 ID 建立自己的有限评测根。

Langfuse LLM-as-a-Judge（用模型按给定材料评分）需要显式将业务任务、结果和所需的 `metadata.evaluation_context` 字段映射为评测器输入。子观测位于同一 trace 或同一 Session，不代表评测器会自动读取它们。本模块只准备观测材料，不创建评测器、生成 score（评分记录）或管理评测运行。

通过 Langfuse Observations API 读取时，评测材料位于 `metadata` 的 `evaluation_context.generations` 和 `evaluation_context.tools` 两个键中；它们是带点号的键，不是客户端 JSON 对象的嵌套路径。使用实际返回字段配置评测映射。

Agent 的语音判断 workflow 保留模型 span，并接续 Backend 客户端传播的追踪上下文。模型调用记录 `gen_ai.request.model`、供应商返回的 `gen_ai.response.model`、token 用量和执行状态；供应商未返回实际模型标识时不填充响应字段，用量缺失时不估算。确认供应商返回合法用量后，复用 pi-ai 的归一化结果，按规范把普通输入、缓存读取与缓存写入相加写入 `gen_ai.usage.input_tokens`，输出总数写入 `gen_ai.usage.output_tokens`，缓存读取、缓存写入及推理输出另记为总数的子集。Langfuse 接收端将这些字段转换为互不重叠的计费分桶，并按模型定义推算成本；自定义模型需在 Langfuse 配置对应价格。本项目不把本地未知价格的零值当成实际成本。

模型参数只从 pi-ai 最终发送的 payload 中提取白名单字段，输出上限与标准采样参数写入 `gen_ai.request.*`，其他 thinking 等设置写入 `home_agent.request.*`；调用方的 `onPayload` 修改先完成，因此记录的是合并及覆盖后的实际参数，不包含凭据、请求头或完整 options。首个供应商事件记录 `gen_ai.response.time_to_first_chunk`（秒），表示首个流式块的等待时间。首个非空文本、思考或工具参数增量另记 `langfuse.observation.completion_start_time` 时间属性，供 Langfuse 计算首 token 延迟（TTFT）；该时间不计入初始化事件、空增量和纯用量事件。模型输入输出仅在内容采集开启时记录，转换为 `gen_ai.input.messages` / `gen_ai.output.messages` 的 `role/parts` 结构；文字、推理、工具调用及工具结果分别使用标准 part 类型，图片使用带 MIME 类型的 `blob` part 和原始 base64 字节。系统指令和工具定义分别通过消息结构及 `gen_ai.tool.definitions` 记录。

`observeProvider()` 只记录模型观测，不修改 pi-ai 的事件、工具参数或完成状态。模型协议使用 pi-ai 原生解析；原生解析可能修补参数 JSON，因此不额外承诺原始 JSON 字节完整。pi-durable 按工具 schema 校验参数，自动化与语音判断另按业务 schema 校验结果。用量存在性按当前原生协议识别：Completions 和 Mistral 的用量 chunk、Responses／Azure／Codex 的终态用量、Anthropic 的消息起始和增量用量、Google／Vertex 的 `usageMetadata`、Bedrock 的 metadata 用量及 Pi Messages 的终态用量。实际 token 数复用 pi-ai 归一化结果；缺失、为 `null` 或未知协议的供应商用量不估算。

单次聊天在模型执行结束后返回 JSON，Backend 代理与 Agent HTTP 入口分别产生 CLIENT 与 SERVER span，`household-assistant.run` 记录本次任务、提交与等待。pi-durable 调度执行可以超过 HTTP 等待期；保存的提交来源允许有限的 `invoke_agent {Agent 名称}`、模型和工具保留原生父子关系，即使父等待 span 已结束。`pi.durable.submission` 记录提交状态，观察器保留会话、提交、任务、调用及已观察到的父工具关系。它不重建遗漏的历史执行；运行观察不完整时使用 `pi.durable.observation_incomplete=true`。

主助手创建一个随机 UUID 作为 `session.id`，将业务、模型和主／子会话记录归入同一个 Session，重启后更换 ID。Generation／Tool hook 从原生 `LiveDoc` 读取运行及输入提交 ID；模型通过本次调用的 AbortSignal 找到对应运行 span，实际工具通过会话、任务和调用 ID 找到对应工具 span。前台委派在父工具上下文中提交子会话，子运行延续该来源。`observeDurableRegistry()` 通过公开 RegistryReader（Harness 读取任务定义的接口）装饰原生 CompactionTask 的 `summarize` 阶段，保留原压缩实现并记录有限的 `conversation.compact`。摘要阶段返回后读取已提交的任务状态，记录 `pi.durable.task_status` 和已决定的 `pi.durable.compaction_outcome`；提交为 `failed` 的摘要标为 `ERROR`，进入重试的任务保留运行状态，不提前标为完成。观测读取失败时标记 `WARNING` 和观测不完整，保留原执行结果。阻塞当前生成的压缩按 `task.owner === live.run.taskId` 归入该运行，实际模型输入也进入仍在记录的业务评测根；后台或手动压缩使用独立 trace 并保留会话和 Session 关联。绑定发生在真实摘要执行时，因此直接恢复到该阶段也使用正确模型上下文。

工具参数和结果映射为 `gen_ai.tool.call.arguments` / `gen_ai.tool.call.result`，正常返回的工具错误也标为失败。观察器只采集已提交内容：普通工具从 `ToolResultEntry.model` 投影结果并移除尾部诊断文本，嵌套调用从 `NestedToolExecutionResult` 取得结构化输出。已提交消息投影为 `role/parts`，保留完整文字、集合、推理和工具调用的含义；图片用包含 MIME 类型的省略文本表示。内容和元数据通过原生 JSON 序列化复制，保留投影结构，不添加替代消息。连续性签名、识别出的凭证字段、内嵌 base64 媒体及原始错误正文不进入观察器记录；工具详情也经过同一投影。关闭内容采集时不导出工具参数、结果和详情。观察器不读取尚未提交的 `api.retainedOutput()`，因此不保证异常发生前的流式工具输出已被采集。完整模型输入与图片仍遵循 provider 适配器的正文开关和媒体边界。观察中断或缺少已提交结果使用 `WARNING`，错误使用 `ERROR`，原始级别及状态说明传递到 Langfuse；只有错误设置 OTel 错误状态。

聊天取消或等待超时只结束本次等待，并尝试撤回仍排队的输入；已开始的执行继续运行。模型请求与每次工具执行另有独立期限，沿用 `AGENT_RUN_TIMEOUT_MS`；工具通过 Chord Context 的 AbortSignal 合作式取消，注入的领域工具必须响应这个信号，忽略信号的实现无法由此强制中止。workflow 将请求取消及执行期限传给模型，并在执行结束后复核取消。失败使用统一 HTTP JSON 错误：模型执行超时为 `run_timeout`，Backend 调用 Agent 超时为 `agent_timeout`，请求取消为 `request_cancelled`，模型执行失败为 `agent_execution_failed`。客户端已断开时不保证收到错误响应。当前上下文 SSE 的同步与断线语义见[家庭运行时](../../docs/household-runtime.md#agent-当前数据与材料历史)。

退出时先停止接收请求并等待在途请求：backend 使用 `BACKEND_SHUTDOWN_TIMEOUT_MS`（默认 30 秒），超时强制关闭连接；Agent 停止时立即关闭连接并取消请求。Agent 先关闭 Harness 及会话观察器，观察器运行时通过 `flushTelemetry()` 刷新共享 processor；其后端 `shutdown()` 不关闭进程的 NodeSDK。追踪模块随后最多等待 10 秒让已登记操作结束，再关闭 exporter。这 10 秒不是整个进程的停机期限；数据库关闭和 exporter 导出另需时间。强制终止进程无法保证导出。

## 代码边界

- `apps/backend/src/app.ts`、`apps/agent/src/routes/index.ts`：Hono HTTP 入口、追踪中间件及统一错误响应装配。
- `apps/backend/src/chat/routes.ts`：受限 JSON 输入校验与聊天转发。
- `apps/backend/src/workflows/routes.ts`：生成请求的设备能力准备、运行失效取消及结果复核。
- `apps/backend/src/agent-client.ts`：聊天、workflow 与接收记录共用的 Agent 调用，使用 `tracedFetch` 传播追踪上下文并有界读取、校验响应。
- `apps/agent/src/assistant/conversation.ts`：原生会话的单次聊天提交与等待、取消及期限、完整回答校验。
- `apps/agent/src/workflows/automation-generation.ts`：生成 workflow 的业务 span 与草稿校验属性。
- `apps/agent/src/workflows/spatial-planning.ts`：原生规划会话 ID、每轮问答、草稿工具及修订元信息的 Session 关联。
- `packages/observability/src/model.ts`：原生 pi-ai 服务提供者的 GenAI `chat` span、供应商实际用量与失败状态。
- `packages/observability/src/agent-trace.ts`：Agent 执行标记、本地与跨服务继承，以及 Langfuse 专用导出筛选。
- `packages/observability/src/session.ts`：请求级 Session 绑定、内部传播、响应回填及请求关联对象释放。
- `packages/observability/src/langfuse-exporter.ts`：Langfuse 专用目的地配置与官方 OTLP 导出组件装配。
- `packages/observability/src/durable.ts`：Durable 观察器的 OTel 后端、提交来源及运行／工具上下文、会话附着及分离、共享 processor 刷新。
- `packages/observability/src/durable-compaction.ts`：通过公开任务定义接口观察原生摘要阶段，不复制压缩实现。
- `packages/observability/src/evaluation.ts`：有限业务根的任务与结果、实际模型输入和工具轨迹汇集。
- `packages/pi-langfuse`：会话事件观察、提交／运行／工具关联和内容投影。
- `apps/agent/src/assistant/assistant.ts`、`apps/agent/src/assistant/conversation.ts`：原生 pi-durable 装配、观察器附着及聊天等待。
- `apps/backend/src/connections/status.ts`：使用 `tracedFetch` 检查 Agent 与 go2rtc；通用 OTel 保留连接探测，独立探测不进入 Langfuse。
- `apps/backend/src/mijia/operation.ts`：米家业务操作的安全错误转换与 span，包括授权恢复、凭据保存和播放操作。
- `apps/backend/src/mijia/media/go2rtc-adapter.ts`：专用协议的 CLIENT span，只记录固定操作名、HTTP 方法、响应状态码与白名单错误分类。
- `apps/agent/src/workflows/speech-interpretation.ts`：结构化模型调用的 span。

Backend 业务操作、Agent workflow、HTTP 等待及模型通过 `withSpan` 显式埋点，保留通用 OTel 属性、错误脱敏和停机等待；`withGenAiContext` 负责调用间的关联属性。Durable 运行与工具由会话事件观察器采集，经 `TraceBackend` 转换为原生 span。聊天转发和连接探测使用 `tracedFetch` 并消费或取消响应体。米家专用协议在完成错误脱敏后记录 CLIENT span，不记录目标 URL、账号凭据、请求／响应正文或 SDP，也不向 go2rtc 传播追踪上下文；这些 span 描述 backend 发起的调用，尚不包含 go2rtc 内部执行或视频媒体链路。观察器记录 Durable 会话事件及运行状态，不为内部每次调度或供应商 SDK 内部重试生成独立 span。

`mijia.session.restore` 覆盖授权读取、恢复与设备校验；`mijia.credentials.read`、`mijia.credentials.save` 和 `mijia.credentials.remove` 分别记录授权读取、导出与持久化、删除。操作失败先经过 span 边界，再转换为页面状态；HTTP 202 仅表示受理，后台结果应查看业务 span。米家业务与下游协议的 `error.type` 只使用各自已定义的静态错误码，内容采集关闭时仍可区分超时、授权拒绝和服务不可达。普通 HTTP 调用记录错误响应的状态码分类；无响应的未知传输错误使用通用分类，不读取任意异常对象的 `code`。

`initializeTelemetry(serviceName)` 装配共享 SDK 与独立导出目的地。`httpTracing(service, isAgentExecution?)` 由应用声明 HTTP 执行入口；`withAgentTrace(run)` 由应用执行边界标记当前 span 并传递上下文。`tracedFetch(direction, input, init?)` 的首个参数指定 `{ from, to }`，只负责 HTTP 追踪和原生上下文传播。Agent 使用 Radash 的 `partial(tracedFetch, { from: "agent", to: "backend" })` 固定方向，作为 RPC 客户端的 fetch 函数；普通数据同步与执行中读取通过各自上下文分类。

主动取消与故障分开记录：取消只标记 `operation.cancelled`，超时仍记为失败。恢复／绑定／源注册的后台退避、心跳和租约计时器在空的 `ROOT_CONTEXT` 下创建，后续工作不会持续附着在最初请求或安装的 trace 上。每次实际操作使用独立的短 span；同次有限操作内的调用仍保持父子关系，不为等待退避的整个生命周期持有一个 span。

`mijia.go2rtc.heartbeat.check` 覆盖完整心跳检查，包含其下的 HTTP CLIENT span、响应协议校验和租约判断。HTTP 200 不代表心跳业务成功；响应缺少合法的 `playbackIds` 等协议失败会在检查 span 中记录安全错误码和失败状态，再按 go2rtc 运行时会话的租约策略处理；该心跳不负责续期米家云账号凭据。

保持原生 OTLP trace/span ID 和父子关系。通用 processor 导出全部已采样 span；Langfuse processor 只接收带 Agent 标记的记录，保留执行入口、相关 HTTP 和业务子调用。Langfuse 根据 `gen_ai.operation.name` 判断模型、Agent 和工具观测类型，并映射模型、会话、用量及输入输出；在本项目发送的字段中，Langfuse 当前接收实现优先用 `session.id` 分组，没有该字段时使用 `gen_ai.conversation.id`；两者并非同一个 ID 空间，定位记录时须结合 Session 分组与原生会话标识。追踪导出由 `OTEL_TRACES_EXPORTER` 控制。单轮聊天与工具失败可通过 Observations API 核对原生父子关系、业务输入输出、评测材料及模型用量；真实空间规划的创建、读取、关闭已核验并发会话的 Session、Agent HTTP 入口及内部 CLIENT 的关联、未确认会话的拒绝关联。编码等价路径使用 Hono 的路由路径执行相同的入口识别与 Session 隔离。Backend 完整应用中的 HTTP 入口补写、规划模型生成、工具回查 Backend 或取消竞争尚未实机核验。多来源合并、自动压缩及恢复尚未实机核验，费用计算、图片界面展示和 Judge 实际评分也未验证。

观察器、压缩阶段包装及 OTel 底层导出组件的保留理由、升级核对与替换条件见[Agent 观测维护决策](../../docs/agent/observability-maintenance.md)。

当前服务默认只监听本机，无用户鉴权。对外开放前，应在可信入口处理外部传入的追踪上下文；随意接受一个未导出的外部 parent 也会影响 Langfuse 的完整树展示。

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
