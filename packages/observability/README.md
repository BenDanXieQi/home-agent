# Observability

当前实现采用官方 OpenTelemetry（OTel）`NodeSDK`、`@hono/otel` 和原生 span processor（负责处理及导出追踪记录的组件）。backend 与 Agent 分别启动 NodeSDK，由 SDK 管理上下文和 W3C 追踪传播。模型、Agent 运行、工具使用 OTel GenAI 语义约定，通过 `gen_ai.operation.name` 分别记录 `chat`、`invoke_agent` 和 `execute_tool`；HTTP 等待使用普通 span。这些约定当前处于 Development（尚未稳定）阶段。未配置导出目的地时不导出数据。通用 OTel 导出保留 SDK 采样留下的 HTTP、业务操作和模型记录；Langfuse 使用独立处理组件，仅导出 Agent 执行相关记录。

空间规划的公开 `session_id` 复用原生 `ProviderDoc.sessionId`，这是 Pi 为一个 Conversation 保存的提供方会话标识。本项目同时用它填充业务、模型和观察器记录的 `session.id` 与 `gen_ai.conversation.id`，属于显式关联策略，不表示 Pi 提供方会话与 Langfuse Session 定义相同；观察器另用 `pi.durable.conversation_id` 记录内部数字会话 ID。每轮 `spatial-planning.run` 记录空间／通道数量和问题数量。开启 `OTEL_INCLUDE_CONTENT` 后，业务输入包含本轮完整请求及原始图片，输出包含回答、澄清问题和完整草稿；模型仍采集实际发送的消息及图片。模型、业务与 Durable 运行／工具 span 都登记停机等待并在各自有限操作结束时关闭。

## 配置

本模块仅导出追踪记录，显式关闭 NodeSDK 默认的指标与日志导出；不会自动连接本地 Collector 上报这两类数据。应用终端日志仍正常输出。

请求级观测统一通过 `observeAgentOperation()` 创建有限业务 span 和评测上下文，并在开始、完成回调中投影业务输入与最终结果。主助手与 Workflow 各自的观察适配器负责字段转换，业务执行代码不传递 span。应用层通过 `createObservedHarnessOptions(modelCollection, extensions)` 为主助手与空间规划共用的 Harness 创建执行选项：包装模型父上下文，按传入顺序安装业务扩展，再安装 Generation／Tool hooks（生成与工具调用的生命周期钩子）及工具执行观测，最后包装注册器以观测摘要阶段。追踪扩展读取已注册工具的快照，因此业务扩展必须在追踪扩展之前安装。返回值中的 `observationExtension` 供对话与自己的业务扩展一起显式选择；运行时的 Harness 默认只选择观测扩展。模型用量仍由 `observeProvider()` 单独采集。共享 Durable 提交适配器记录提交 ID，已提交事件观察器维护运行与工具终态。

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

Langfuse 保留 Agent 任务及会话生命周期相关的追踪，包括空间规划 `message/close` 的 HTTP 调用；普通健康检查、设备操作等不因自身请求而导出到 Langfuse。HTTP 记录保存调用信息，不自动采集请求和响应正文；没有 `input/output`（输入／输出正文）不表示调用没有发生，也不是排除追踪的依据。查看完整过程时使用无正文筛选的视图；“All observations with I/O” 只展示同时有输入和输出正文的观测，可能隐藏创建会话等仅有 HTTP 信息的记录。

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

主助手的会话 ID 由 Agent 创建，聊天请求只携带消息；新建空间规划的会话 ID 也在 Agent 内产生。因此 Backend 从 Agent 响应取得这些请求的会话 ID。聊天和 Workflow 的 SSE 响应通过已校验的进度数据中的 `session_id` 建立关联，因为开始发送响应头时可能尚未创建会话。已知会话仍可通过内部响应头 `x-home-agent-session-id` 关联。有限 SSE 的生产任务通过 `trackHttpStream()` 登记完成信号，HTTP 中间件先交付响应头，待生产任务结束后才关闭 SERVER span 和请求会话。后到的会话 ID 同时补到仍在记录的 HTTP 入口与 CLIENT span，后续子调用沿用该 Session。这个内部响应头只用于按 Session 查找 HTTP 记录，Backend 不把它返回浏览器；HTTP 调用树本身通过 trace ID 关联。

关联对象按请求创建，不使用全局 trace 映射；一个请求只绑定一个 Session，冲突的后续值不覆盖现有绑定。错误响应同样可关联已确认的会话。HTTP 请求结束时释放入口引用，Durable 保存提交来源时移除请求关联对象，继续持有独立的会话属性及原生父级。

在收到响应头前已经取消、超时或失联的上游记录可能没有 Session；Session 确定前已经结束的准备操作也不能事后补写。已结束的 span 不重开或重复导出，后台模型和工具仍按 Durable 自己确认的 Session 关联。多个真实 Session 在同一次 HTTP 请求内并行处理尚不属于当前接口语义。

一次性 workflow 调用链为 Backend SERVER → `tracedFetch` CLIENT → Agent `/api/workflows` SERVER → `automation-generation.run` 或 `speech-interpretation.run` 业务 span → `chat {模型 ID}` 模型 span，不创建 Durable 会话。空间规划消息使用 `spatial-planning.run` → `invoke_agent spatial-planning` → 模型／工具。业务 span 由 Agent 的统一 Workflow 执行入口建立，开始与完成回调负责采集输入、经过响应校验的最终结果及归一化后的错误；具体 Workflow 不操作 span。自动化的有效草稿标记和澄清数、空间规划的对象及问题数量均从最终结果提取。模型标识、供应商实际 token 用量和费用由模型 generation（一次模型生成记录）承担，用量缺失时不填充估算值；不另记录业务内的中间校验问题计数。

Langfuse LLM-as-a-Judge（用模型按给定材料评分）需要显式将业务任务、结果和所需的 `metadata.evaluation_context` 字段映射为评测器输入。子观测位于同一 trace 或同一 Session，不代表评测器会自动读取它们。本模块只准备观测材料，不创建评测器、生成 score（评分记录）或管理评测运行。

开启内容采集时，在 Pi 的 `onPayload` 回调中等待调用方修改完成，再对请求体生成 JSON 快照，供模型 span 与评测上下文共用。模型 Input 通过 `langfuse.observation.input` 保存 Provider 转换后的请求体，包括其原生格式的系统指令、消息、媒体、工具定义和生成参数；不再把 Pi 内部 transcript（消息记录）的投影当作发送请求。若 Provider 在一次生成中重新准备请求，每次回调都进入评测材料，模型 Input 保留最后一次快照。准备请求体之前的失败没有模型 Input，不补造请求。评测过程在内存收集生成记录和工具状态，在所属业务或 Durable 评测根结束前统一序列化并释放收集的数据；成功、失败和取消均执行这一步。HTTP 等待提前结束时只包含当时已观察到的材料，不会等待后台任务补全。序列化失败会报告观测错误，不覆盖业务执行结果。

全部追踪关闭时，模型适配器直接调用原 Provider，保留调用方回调，不创建转发事件流或解析观测用量。

通过 Langfuse Observations API 读取时，评测材料位于 `metadata` 的 `evaluation_context.generations` 和 `evaluation_context.tools` 两个键中；它们是带点号的键，不是客户端 JSON 对象的嵌套路径。每项 generation 包含 `span_id` 和 `input`，其中 `input` 与对应请求体快照一致；字段结构遵循所用 Provider 的协议。使用实际返回字段配置评测映射。

Agent 的语音判断 workflow 保留模型 span，并接续 Backend 客户端传播的追踪上下文。模型调用记录 `gen_ai.request.model`、供应商返回的 `gen_ai.response.model`、token 用量和执行状态；供应商未返回实际模型标识时不填充响应字段，用量缺失时不估算。确认供应商返回合法用量后，复用 pi-ai 的归一化结果，按规范把普通输入、缓存读取与缓存写入相加写入 `gen_ai.usage.input_tokens`，输出总数写入 `gen_ai.usage.output_tokens`，缓存读取、缓存写入及推理输出另记为总数的子集。Langfuse 接收端将这些字段转换为互不重叠的计费分桶，并按模型定义推算成本；自定义模型需在 Langfuse 配置对应价格。本项目不把本地未知价格的零值当成实际成本。

模型参数只从 pi-ai 最终发送的 payload 中提取白名单字段，输出上限与标准采样参数写入 `gen_ai.request.*`，其他 thinking 等设置写入 `home_agent.request.*`；调用方的 `onPayload` 修改先完成，因此记录的是合并及覆盖后的实际参数，不包含凭据、请求头或完整 options。首个供应商事件记录 `gen_ai.response.time_to_first_chunk`（秒），表示首个流式块的等待时间。首个非空文本、思考或工具参数增量另记 `langfuse.observation.completion_start_time` 时间属性，供 Langfuse 计算首 token 延迟（TTFT）；该时间不计入初始化事件、空增量和纯用量事件。模型输入输出仅在内容采集开启时记录。Input 保留请求体的 JSON 结构，不另发转换前的 `gen_ai.input.messages` 或当前工具列表；Output 是 Pi 响应归一化后的 `role/parts` 结构，同一份序列化结果同时写入 `gen_ai.output.messages` 和 `langfuse.observation.output`。Langfuse 的输入输出使用成对的原生字段，通用 OTel 消费者读取 GenAI 输出字段。Langfuse Raw 用于核对请求字段，Formatted 的展示取决于 Langfuse 对该 Provider 原生格式的支持；JSON 对象的字段排列不代表服务端的 token 顺序。请求体快照不采集请求头或 SDK options，也不代表 SDK 后续封装的 HTTP 字节流。

工具执行包装器只恢复追踪上下文；工具 observation 与 `evaluation_context.tools` 的结果和终态统一取自已提交事件，包括未进入工具执行函数的参数校验失败。没有 taskId 的 `tool_unavailable` 等结果也创建工具观测，以该 span 的 ID 关联评测材料，不虚构任务 ID。评测结果保留与工具 observation 一致的正文投影和错误内容；观察中断或缺少结果记为 `interrupted`，不推断执行成功。

启用追踪时必须先附着观察器；观察器缺失会在接纳提交前报错。提交适配器在 Pi 的 `Submission.wait()` 返回后，继续等待观察器处理该提交的终态事件；该事件之前的工具终态已按事件顺序处理，业务评测根随后才结束。等待使用调用方的取消上下文，不把取消等待变成取消整个会话。已有观察器初始化失败、失效、关闭、处理错误、快照重同步或历史提交未被覆盖时，解除观测等待，并在仍在记录的提交来源及其关联业务评测根标记 `pi.durable.observation_incomplete`，保留 Pi 的执行结果。重复提交历史 `requestId` 不会等待不存在的新终态事件；关闭追踪时直接使用原生提交与等待。

单次聊天通过 SSE 返回过程与最终结果，Backend 代理与 Agent HTTP 入口分别产生 CLIENT 与 SERVER span，`household-assistant.run` 记录本次任务、提交与等待。HTTP 等待取消后，pi-durable 调度执行可以继续；保存的提交来源允许有限的 `invoke_agent {Agent 名称}`、模型和工具保留原生父子关系，即使父等待 span 已结束。`pi.durable.submission` 记录提交状态，观察器保留会话、提交、任务、调用及已观察到的父工具关系。它不重建遗漏的历史执行；运行观察不完整时使用 `pi.durable.observation_incomplete=true`。

聊天取消只结束本次等待，并尝试撤回仍排队的输入；已开始的执行继续运行。应用不额外设置模型输出 token 上限、模型请求期限、工具执行期限或聊天等待期限，保留库自身的默认行为及提供方约束。workflow 将请求取消信号传给模型，并在执行结束后复核取消；空间规划在取消时中止本轮运行。工具执行响应框架传递的 Chord Context 取消信号，忽略信号的工具不能被强制中止。JSON 接口失败使用统一 HTTP JSON 错误，已经建立的有限 SSE 使用相同错误结构的 `error` 事件：Backend 调用 Agent 超时为 `agent_timeout`，请求取消为 `request_cancelled`，模型执行失败为 `agent_execution_failed`。客户端已断开时不保证收到错误响应。当前上下文 SSE 的同步与断线语义见[家庭运行时](../../docs/household-runtime.md#agent-当前数据与材料历史)。

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
