# Agent

基于 pi-durable 的常驻家庭助手服务，进程入口为 `src/main.ts`，助手装配位于 `src/assistant/assistant.ts`，Harness（助手运行器）、工具注册、委派和本地环境均在同一文件中装配。backend 转发请求，Web `/agent` 向同一个主会话提交消息。

`routes/index.ts` 创建 Hono 公共中间件、错误处理与健康检查，通过生成的 `routes/registry.generated.ts` 挂载 `/api` 子路由。`routes/context-receipts/route.ts`、`routes/conversation/route.ts` 和 `routes/workflows/route.ts` 分别定义接收数据查询、聊天与专项任务路由，只接收各自使用的能力。路由通过 Hono 原生 `createFactory()` 共用 Bun 绑定类型，依赖类型从现有实现推导。

`app.ts` 的 `createApp(config, signal)` 创建助手、workflow 与上下文接收器并注入路由，返回 `fetch` 与 `[Symbol.asyncDispose]`（标准异步释放方法）。`main.ts` 接管应用，通过从 `bun` 导入的 `serve()` 启动 HTTP 服务，负责进程资源生命周期。

## 资源生命周期

各层使用 Bun 原生 `AsyncDisposableStack`（异步资源清理栈）登记自己拥有的资源：`use(实例)` 接管标准释放方法，`adopt(实例, 清理函数)` 适配遥测与 HTTP 服务的关闭方法，`defer(清理函数)` 登记提供方会话清理。工厂通过 `await using` 自动回收初始化失败时已登记的资源，成功后用 `move()` 把清理责任转交给返回实例。应用和助手使用 `memo()` 缓存释放 Promise，让重复关闭调用等待同一次清理完成。

`main()` 通过 `await using lifecycle = createProcessLifecycle(timeoutMs)` 管理进程生命周期。该函数在装配前注册 `SIGINT`／`SIGTERM` 处理器，返回进程资源栈 `processResources`、启动取消信号和退出等待方法。`main()` 登记进程资源，通过 radash `tryit` 区分应用初始化失败与正常取消，启动 HTTP 服务后等待退出信号；离开作用域时自动释放进程资源。应用工厂用 `appResources` 登记应用内部资源，成功后把释放责任转交给返回实例。

启动取消通过 `signal.throwIfAborted()` 传播，应用创建成功时始终返回实例。取消信号传入模型认证及 Harness／主会话初始化；临时文件创建和观察器附着等未提供取消接口的操作，在完成后复核信号。调用方在接管异步创建的实例后再次检查信号，避免取消发生在工厂完成与调用方恢复执行之间。清理使用不受启动取消影响的上下文；正常取消结束启动，初始化或清理错误仍向外传播。

退出时按登记的逆序逐个等待：HTTP 服务、上下文接收、workflow、助手、提供方会话资源、遥测。HTTP 服务的 `stop()` 停止接纳新连接并等待在途请求完成；接收器停止后才关闭它调用的 workflow。助手先关闭 Harness，再释放观察器，最后清理执行环境与工作目录。单个清理失败仍继续释放其余资源；多项失败或初始化与清理同时失败时，原生清理栈以 `SuppressedError`（保留多个失败原因的错误链）记录错误。清理结束后移除信号处理器。

收到退出信号时启动 `AGENT_SHUTDOWN_TIMEOUT_MS` 计时，初始化取消、HTTP 排空和资源清理共用这段预算，默认 10,000 毫秒；重复信号不重置计时。应用装配返回失败时，后续进程资源清理也受该预算约束。没有退出信号时，工厂内部因初始化失败而触发的回收发生在装配返回之前，不受这段计时约束。

预算耗尽后记录错误并强制以退出码 1 结束进程，未完成的请求、清理与追踪刷新可能被中断；正常完成会清除计时器。执行预算默认 120,000 毫秒，因此退出不保证长请求完成。阻塞事件循环的同步代码会延迟计时器执行。

## 运行

根目录 `.env` 配置 `AGENT_MODEL=provider/modelId` 和对应提供商的凭据。主助手、各类 workflow 和子 Agent 可以使用不同的提供商。模型的容量、输入能力、端点和协议取自 pi-ai 原生清单。模型必须支持工具调用，配置方法见[模型配置](#模型配置)。Agent 使用 pi-ai 原生 Provider（封装模型清单、认证和请求协议的服务提供者）。`createModels()` 创建 Models collection（提供方集合，负责模型查询、认证解析和请求路由），通过 `setProvider()` 注册 Provider；Backend 通过 workflow 请求语音判断，不直接读取模型配置。

```sh
bun install
bun run --cwd apps/agent dev
```

`AGENT_HOST` 默认 `127.0.0.1`，`AGENT_PORT` 默认 `1811`。`BACKEND_URL` 使用 HTTP(S) 地址，默认 `http://127.0.0.1:3000`；Backend 使用自定义监听地址时显式配置。无需数据库或 Agent Server。根目录开发命令仍会启动本项目其他服务。后台上下文接收不要求模型配置。独立运行类型检查或 lint 前先执行 `bunx turbo run build --filter=@home-agent/backend-client`，生成服务端及客户端声明；Turbo 的 Agent 构建、检查和开发命令已声明该依赖，开发时同时维护两份声明。生成职责见[共享 Backend 客户端](../../packages/backend-client/README.md)。

## 接口

`POST /api/workflows` 是 Backend 调用专项任务的统一内部入口，复用当前进程、本机访问校验和错误格式。自动化生成使用 `workflow="automation-generation"`，请求为 `{ workflow, input: { text, definition?, capabilities } }`；`definition` 为可选的现有规则，`capabilities` 为调用方准备的设备能力。响应为 `{ workflow, result: { definition, behavior, clarifications } }`。存在歧义或生成内容未通过校验时，`definition` 为 null，调用方展示说明或澄清问题，不能当作已生成的有效规则。

生成能力位于 `src/workflows/automation-generation.ts`，直接使用 pi-ai `Models.complete()` 执行一次严格工具输出请求；规则结构、设备引用、读写权限、枚举及动作参数按 `@home-agent/api/automations` 校验。输入中的能力用于约束草稿，不构成设备操作授权；保存或执行前仍需 Backend 核验当前家庭及设备能力。它不保存或启用规则、不操作设备、不使用聊天历史或 Agent 数据库。

自动化调用使用配置的执行期限与输出预算，取消和超时传递到模型调用。未配置模型返回 `model_not_configured`。公共分发位于 `src/workflows/index.ts`，接收 Hono 入口已校验的输入，负责执行期限和结果校验；专项模块不另建 HTTP 或客户端层。workflow 模块通过 `workflows/*.ts` 声明创建入口，注册与分发由构建前生成，见下方注册约定。Backend 已通过公共 `/api/workflows` 入口调用本服务，从当前家庭规格准备能力，返回前重新校验家庭资格与设备能力。自动化页面已通过 Backend 公共入口调用生成；生成器和共享校验拒绝交付含 AI 条件或动作选择的可用草稿，这两项能力尚未启用。真实家庭场景的规则生成质量尚未系统验证。

进程复用 `@home-agent/observability` 初始化 OpenTelemetry（OTel）。聊天与 workflow 执行入口、GenAI 记录标记为 Agent 执行，Langfuse 按标记独立筛选；健康检查、接收记录读取与上下文同步保留在通用 OTel，执行中的 Backend 数据读取通过 W3C baggage 传播执行标记并延续已有追踪。HTTP 入口接续 Backend 的 W3C 追踪上下文；业务 `.run` span（一次任务的追踪记录）记录提交、等待与结果校验，Durable 运行、模型和工具显式接到对应父级。模型、Agent 运行与工具按 OTel GenAI 语义约定分别记录 `chat`、`invoke_agent`、`execute_tool`；这套约定当前处于 Development（尚未稳定）阶段。供应商实际 token 用量、费用与首 token 时间只记录在模型观测，缺失用量时不估算。Durable 已提交状态由工作区 [`@home-agent/pi-langfuse`](../../packages/pi-langfuse/README.md) 观察器采集，模型记录不重复导出。长期会话只归入 Session，不持有导出的长期根 span。默认不采集正文；`OTEL_INCLUDE_CONTENT=true` 时逻辑评测根才记录任务、结果及 `metadata.evaluation_context` 中的实际模型消息与工具轨迹。评测器须显式映射这些材料，本服务不自动生成评分或管理评测器。配置、内容边界及 Langfuse 尚未实机验证的接收与界面行为见[共享追踪说明](../../packages/observability/README.md)。

`GET /health` 返回进程存活状态（`status: "ok"`）和服务标识（`service: "home-agent"`、`runtime: "bun"`），不检查模型配置或供应商连通性。

`POST /api/chat` 接受 `{ "message": "你好" }`，完成后返回 `{ "answer": "…" }`。Web 通过 backend 的同名接口访问。输入只接受非空的 `message`，响应为非空回答。使用普通 JSON，不提供 SSE、thread ID 或历史接口。

所有聊天请求复用当前进程内同一个主会话和工作目录。忙碌时由 pi-durable 默认 follow-up 收件箱排队，前端仍只展示本次回答。刷新页面不清空服务端会话；重启后清空。当前主会话没有按账号、家庭或浏览器隔离。

独立接收模块自动订阅 Backend 当前家庭、空间关系、设备状态、成员和统一观察。历史读取模块提供只读查询方法，供调用方显式装配；当前进程入口未创建该模块。家庭助手的模型尚未接入这些材料或家庭业务工具，不能安排提醒或控制设备；没有改变现有聊天输入及模型行为。数据来源、保留与验证限制见[家庭运行时](../../docs/household-runtime.md#agent-当前数据与材料历史)。

Bun 保留默认连接空闲超时，仅在请求体完成校验后对本次模型请求关闭空闲计时，由执行期限控制等待。模型明确返回长度截断、内容过滤、未完成或失败状态时，不作为完整回答返回；结果未知时不自动重发。

HTTP 复用本机访问限制和统一错误契约。仅限可信本机使用，不提供账号认证。模型缺配置返回 503，超时返回 504，执行失败返回安全错误，不返回供应商原始异常。

## 模块组织与自动注册

`workflows/` 按业务划分 `automation-generation.ts`、`speech-interpretation.ts` 和 `spatial-planning.ts`。每个业务文件直接包含模型配置、模型解析、指令与执行实现，导出 `modelConfiguration` 声明专项模型的环境变量键和校验 Schema（配置校验规则），并导出 `createWorkflow(context)`；工厂接收模型清单、本 workflow 的模型引用 `modelRef` 和执行预算，同步返回带 `run` 的实例。`run` 接收该 workflow 的输入与取消信号，未配置模型时为 `undefined`；需要资源清理的实例还可提供 `retainScope(scope)` 和 `close()`。`definition.ts` 定义装配边界及从共享 Schema 推导的注册契约，`structured-output.ts` 供专项任务共用，`index.ts` 负责执行期限、结果校验及错误映射。

`scripts/codegen/workflows.ts` 扫描 `workflows/*.ts`，排除 `index.ts`、`definition.ts`、`structured-output.ts` 和 `registry.generated.ts` 等基础设施文件，用小写字母、数字和连字符组成的文件名（不含 `.ts`）作为 workflow 名称，生成静态导入、实例注册和穷尽分发。`WorkflowRegistry` 从 `@home-agent/api/agent-workflows` 的输入输出 Schema 推导：缺少实现、多出未声明名称、创建入口缺失、输入或结果类型不匹配都会令类型检查失败。运行入口仍用共享 Schema 校验实际输出。

新增 workflow 时，在共享 API 声明输入输出契约，并添加同名 `.ts` 文件，导出 `createWorkflow` 与 `modelConfiguration`；无需修改中央配置、导入或分发列表。生成器从发现的模块装配 `workflowConfigurationSchema`，由 `config.ts` 与通用配置一起校验环境变量。`configureWorkflows(config)` 统一解析专项模型引用，省略时使用主模型引用，返回供 `initializeModels()` 使用的引用数组和 `create(context)` 工厂；两者共用本次解析的模型选择。业务工厂只接收所选的 `modelRef`、模型清单与预算，不读取环境配置。配置解析及实例装配同步完成，工厂创建阶段不分配 Harness 或提供方会话资源；模型调用与会话执行仍异步进行。空间规划在 `run` 处理 `action="start"` 时创建独立会话，该次创建失败时释放已分配资源。关闭服务和家庭范围变化时，等待所有已注册的清理钩子完成，并汇总清理错误。

`scripts/codegen/routes.ts` 扫描 `routes/*/route.ts`，校验业务子目录名称并按目录名稳定排序，生成静态导入和链式 `.route()` 挂载，保留 Hono 的客户端类型推断。`routes/` 按业务划分 `chat/`、`context/` 和 `workflows/` 子目录，名称使用小写字母、数字和连字符；每个子目录的 `route.ts` 导出 `createRoutes(context)`，只接收 `RouteContext` 中自己使用的依赖，并定义相对于 `/api` 的路径。路由模块不得依赖跨模块注册顺序；必须依赖顺序的路由和中间件留在同一模块中，通过链式定义显式组织。新增路由模块无需修改中央导入或挂载列表；全局中间件、健康检查、访问限制及执行追踪标记由 `routes/index.ts` 显式维护，新增模型执行入口时需同步追踪标记的路径规则。自动发现不校验模块内部的重复 HTTP 路径，路径冲突仍须在路由定义中核对。

两个生成器共用 `scripts/codegen/modules.ts` 的原生文件扫描、名称校验、稳定排序、格式化、仅在内容变化时写入及开发监听。生成器只读取文件名，不执行路由或 workflow，不调用模型。两份 `registry.generated.ts` 提交到仓库，但不手工修改。`bun run generate` 刷新全部注册文件；`check-types`、`lint`、`lint:fix` 自动生成，`build` 先执行生成及类型检查再打包。`dev` 启动前生成，递归监听 workflow 和路由目录的新增、删除与修改；生成文件更新后由 Bun watch 重启服务，进程内会话随重启清空。

`context/receiver.ts` 统一拥有订阅连接、家庭范围和当前快照，`context/reader.ts` 负责受家庭资格约束的只读历史查询，`context/journal/` 保存当前连接的接收记录并提取变化摘要。数据部分名称从共享 Schema 获取。接收器、读取器与接收记录是协作职责，不采用可独立注册的模块机制。

## 运行器与工具

`assistant/assistant.ts` 按官方 [26-coding-agent](https://github.com/earendil-works/pi/blob/main/packages/durable/test/examples/26-coding-agent.ts) 与 [22-subagent-foreground](https://github.com/earendil-works/pi/blob/main/packages/durable/test/examples/22-subagent-foreground.ts) 的单文件组织方式，直接定义委派扩展、注册工具、创建 `NodeExecutionEnv`，调用 `Harness.open()` 并取得 `root`。主助手相关实现归入 `assistant/`，与 `context/`、`workflows/` 并列。配置解析、HTTP 路由和家庭资料接收是本项目的服务代码，不是官方示例提供的目录结构。

`createAssistant({ modelCatalog, modelRef, subagentModelRefs, budget, signal })` 返回原生 `root`、观测用的 `sessionId`、`tracing` 和资源关闭函数。`createConversationInteraction(conversation, options)` 接收原生会话、追踪适配与等待预算，返回 `submitAndWait(message, signal)`。`assistant/conversation.ts` 通过 `tracing.submit()` 保存来源上下文并执行原生提交，等待提交的 `wait()` 后通过会话的 `commit()` 从 `AssistantEntry` 读取最终回答文字；`routes/conversation/route.ts` 将文字校验并包装为 HTTP 响应；响应校验失败返回 `agent_execution_failed`。`createApp()` 注入助手的主会话、观测会话标识、追踪适配与等待预算；`routes/conversation/route.ts` 创建会话交互适配，一组聊天路由复用同一个适配实例。主助手、子助手与空间规划共用 `utils/final-answer.ts` 的最终文字校验，拒绝工具调用未完成、截断、错误或空白答案。

一个助手实例使用 `MemoryStorage`、一个主会话和临时工作目录。`createApp()` 在监听 HTTP 前创建实例；后续消息复用同一原生会话。主会话及委派子会话创建后附着 Durable 事件观察器。助手工厂通过 `await using` 管理初始化期间的资源，观察器附着成功后用 `move()` 把清理栈的所有权转移给返回实例；包括观察器附着在内的任一步骤失败，都会释放已登记资源。退出时 `close()` 先关闭 Harness，再释放观察器并刷新共享追踪处理组件，最后清理执行环境与工作目录；重复关闭复用同一 Promise。NodeSDK 由进程装配层关闭。`main()` 等待已创建资源关闭后调用 Pi 原生 `cleanupSessionResources()` 释放提供方连接并关闭 telemetry；重复退出信号只请求同一次退出。

长期会话只拥有 Session（多轮追踪分组）关联，不导出覆盖空闲期的会话根 span。一次聊天通常形成 HTTP → `household-assistant.run` → `invoke_agent household-assistant` → 模型／工具的显式父子链；前台委派的子运行接续父工具的上下文。多个来源一起启动运行时创建新的 trace 并添加 OTel links（跨追踪来源关联）；运行开始后并入的输入保留初始父级并补充 links，提交 ID 保留在元数据中，不承诺 Langfuse 界面展示 links。`household-assistant.run` 以 `langfuse.internal.is_app_root=true` 标记本次任务的逻辑评测根，内容开关开启时记录任务、最终回答及实际模型输入和工具轨迹；完整字段与评测材料映射见[共享追踪说明](../../packages/observability/README.md#追踪链路)。

上下文自动压缩沿用框架默认策略。共享追踪模块通过公开任务定义接口观察原生摘要执行：阻塞当前生成的压缩归入对应运行，后台压缩单独创建有限 trace 并保留 Session，模型用量仍只记录在模型观测。pi-durable 1.2.0 通过 Bun 依赖补丁应用官方 [5713c950](https://github.com/earendil-works/pi/commit/5713c9507c9dceab289de3defe41f24611a7d757)：压缩和增量重建上下文时保留 SystemEntry（系统指令记录），不将其重复追加为普通历史。补丁位于根目录 `patches/`，由 `bun install` 应用。原始内存记录仍随历史增长，没有磁盘会话存储或重启恢复，长期资源占用与摘要质量尚未验证。现有家庭接收器独立运行，尚未接入模型事件唤醒或定期检查。

`AGENT_RUN_TIMEOUT_MS` 默认 120,000，分别限制单次模型请求、每次工具执行和 HTTP 等待，不限制主会话寿命或整个多回合任务。工具执行通过 Chord Context 的 AbortSignal 接收期限；官方 `bash` 即使省略命令 timeout 也受该期限约束，模型提供更短的命令 timeout 时仍生效。前台委派超时会令工具失败，由框架取消其拥有的子会话工作。注入的领域工具必须响应取消信号；忽略信号的工具不能被强制中止。单次模型输出由 `AGENT_MAX_OUTPUT_TOKENS` 限制，默认 4096；模型请求不自动重试，应用不累计限制主会话的请求次数。

按[官方会话与取消语义](https://github.com/earendil-works/pi/tree/main/packages/durable#busy-conversations)，取消或超时结束本次等待，并尝试用 `submission.abort()` 撤回仍排队的输入。已开始处理的输入继续运行，不调用整个主会话的 `abort()`；结果保留在会话中，当前没有历史接口供网页补取。`close()` 由实例所有者在退出时调用。

家庭助手在 registry 中注册以下工具；子会话继承父会话启用的工具并移除委派扩展。当前聊天没有注册家庭业务工具、专用子 agent 或技能。

| 工具       | 行为                                                                                                                       |
| ---------- | -------------------------------------------------------------------------------------------------------------------------- |
| `read`     | 官方文件读取，支持文字和图像。`offset` 从 1 开始；文字输出最多 2000 行或 50 KiB，大文件按 `offset/limit` 继续读取。        |
| `write`    | 官方文件写入，自动创建父目录；目标文件存在时覆盖。                                                                         |
| `edit`     | 官方精确编辑；`edits` 中的每组 `oldText/newText` 基于原文件匹配，旧文字须唯一且各编辑互不重叠。                            |
| `bash`     | 官方命令执行；列出、查找、搜索或删除文件使用标准命令。输出保留末尾最多 2000 行或 50 KiB，超限时另存完整输出。              |
| `subagent` | 按官方前台委派示例实现；`task` 提供完整任务资料，返回完整文字回答。子会话归工具任务所有，继承父 agent 配置并移除委派扩展。 |

`read/write/edit/bash` 直接来自官方 `CodingTools`，参数、文件并发处理和输出截断均使用 SDK 实现。前台委派使用任务所有权索引复用子会话，并用 `requestId` 保证同一工具任务的提交幂等。相关接口见[官方工具与环境](https://github.com/earendil-works/pi/blob/v1.2.0/packages/durable/README.md#tools)和[前台 subagent 示例](https://github.com/earendil-works/pi/blob/main/packages/durable/test/examples/22-subagent-foreground.ts)。

`NodeExecutionEnv` 访问宿主文件系统并执行宿主命令，临时工作目录不是沙箱，不限制绝对路径或 `../`。本服务只用于可信本机请求；需要隔离时应使用独立的执行环境。官方 `bash` 超限时生成的完整输出文件位于系统临时目录，不随实例工作目录删除，运行期间没有磁盘字节配额。

## 代码职责

`assistant/` 拥有常驻主助手、子 Agent 委派和聊天交互；`context/` 拥有家庭资料接收；`workflows/` 拥有专项任务。`routes/` 提供 HTTP 接口，模型和 `utils/` 中的最终回答校验由各分支共用。

- `assistant/assistant.ts`：单文件定义助手及子 Agent 委派，直接装配原生 Harness、工具、追踪与执行环境，负责主会话创建和资源关闭。
- `utils/final-answer.ts`：主助手、子助手与空间规划共用的最终文字读取及完整性校验，不拥有会话。
- `config.ts`：服务与模型环境变量的校验和默认值，复用 `models.ts` 的模型引用解析规则。
- `app.ts`：收集模型引用并初始化模型，创建助手、workflow、共享 Backend RPC 客户端与上下文接收器，向路由注入能力，管理应用内部资源。
- `main.ts`：`main()` 读取配置、接管应用、启动 HTTP 并登记追踪资源；同文件中的 `withProcessShutdown()` 接管信号、资源作用域和退出预算。
- `models.ts`：定义共用的模型引用解析规则，按引用注册 Provider、校验模型清单并检查认证，返回 `modelCatalog`，包含共享 Models collection、可用模型查询 `resolve(modelRef)` 和候选集合选择 `select(modelRefs)`；不定义助手、workflow 或子 Agent 用途。
- `routes/index.ts`：无启动副作用的 Hono 应用工厂，复用本机访问、JSON 校验、错误处理及 HTTP 追踪中间件。
- `assistant/conversation.ts`：向主助手会话提交用户文字、等待并校验最终回答，处理等待期限、取消与错误映射；不创建或关闭会话。
- `context/receiver.ts`：Backend 专用 SSE 接收、六部分内存状态、连接和家庭资格；家庭范围变更时通知会话所有者撤销旧范围会话。
- `context/journal/index.ts`：受接收器管理的当前连接接收记录与当时上下文；`context/journal/changes.ts` 在接收时比较前后状态并提取诊断变化摘要。
- `context/reader.ts`：历史与引用材料读取；使用共享 Backend RPC 客户端，负责当前接收资格及响应与请求的匹配校验。
- 家庭模型视图：转换、编码和解码由根目录共享包 `packages/api/` 提供，供 Agent 与 Web 使用；离线文件处理命令属于本应用的 `scripts/format-context.ts`。
- `workflows/automation-generation.ts`：自动化生成的模型选择、指令、结构化调用与草稿校验。
- `workflows/speech-interpretation.ts`：语音请求完整性与回应需求的结构化模型判断。
- `workflows/spatial-planning.ts`：独立空间规划会话、图片输入、反复问答和空间通道草稿；会话关闭、家庭撤销或服务关闭时释放各自的 Harness、存储及提供方会话资源。
- `workflows/structured-output.ts`：按 Pi 的当前协议构造原生工具选择选项，供一次性结构化调用共用。

## 专项能力

专项能力按业务放在 `src/workflows/<业务名>.ts`，与 `routes/<业务名>/route.ts` 一样，由单个业务文件同时定义创建入口与实现。自动化生成和语音判断通过 pi-ai 执行一次结构化模型调用，不创建 Harness。共享 `structured-output.ts` 按当前十种 Pi 协议提交原生工具选择选项；两个业务模块校验结果恰好包含一次目标工具调用，再校验参数。Provider 是否真正强制工具调用取决于其服务实现：[MiMo 文档](https://mimo.mi.com/docs/zh-CN/api/chat/openai-api)说明非 `auto` 的 `tool_choice` 会被服务端移除；未调用或多次调用目标工具时，本项目返回执行失败。

### 空间规划会话

`workflow="spatial-planning"` 通过同一内部 `POST /api/workflows` 提供持续规划。Agent 内部接口的创建请求必须包含 `input.scope`，由 Backend 核验当前家庭后填入。下面的账号、家庭与运行代次仅为示例，调用时须使用当前家庭范围的实际值：

```json
{
  "workflow": "spatial-planning",
  "input": {
    "action": "start",
    "scope": {
      "account_id": "example-account",
      "home_id": "example-home",
      "scope_epoch": "aaaaaaaa-0000-4000-8000-000000000001"
    }
  }
}
```

取得 `result.session_id` 后，携带这个 ID 和同一 `input.scope` 提交 `message`、`read` 或 `close`。浏览器调用 Backend 的 `POST /api/workflows` 时，请求使用顶层 `scope_epoch`，不传 `input.scope`；Backend 校验后补齐内部请求的 `scope`。创建会话可提供已有 `draft`；创建和读取不调用模型。字段、图片编码及草稿约束见[共享会话契约](../../packages/api/README.md#空间规划会话契约)。

每个规划拥有独立的 Harness、MemoryStorage 和原生 Conversation（会话），同一 ID 下的后续消息保留已有对话及当前草稿，不使用聊天主会话。Backend 将当前账号、家庭和运行代次作为可信 scope 传入；Agent 核对会话所属范围，并在接收器观察到家庭范围撤销或变化时关闭旧范围会话。普通 SSE 重连不撤销同一范围下的规划。每轮结果包含回答、待澄清问题、完整空间和通道草稿以及修订号；需要补充信息时也返回已有草稿。图片支持 JPEG、PNG、WebP 的原始 base64 字节；使用 `AGENT_SPATIAL_MODEL`，省略时沿用 `AGENT_MODEL`；带图片的消息要求该模型支持 image 输入，不支持时返回 `invalid_request`。不接收视频。

实现直接使用 pi-durable 的 `Harness`、`createConversation()`、`submit()/wait()`、`defineDoc()`、`defineExtension()`、`defineTool()` 和 `section()`，对应官方 [11-extension-state](https://github.com/earendil-works/pi/blob/main/packages/durable/test/examples/11-extension-state.ts) 与 [27-plan-mode](https://github.com/earendil-works/pi/blob/main/packages/durable/test/examples/27-plan-mode.ts) 的会话状态及规划工具方式。`update_spatial_draft` 校验完整草稿后，在同一 commit（原子提交）中更新会话文档并增加修订号，返回 `control: { terminate: true }`。同一轮所有工具结果都请求终止时，结束当前 run（一条输入到最终结果的完整运行），不再发起下一次模型请求，Conversation 仍保留。普通问答按官方 [Quick Start](https://github.com/earendil-works/pi/blob/main/packages/durable/README.md#quick-start) 从原生 `AssistantEntry` 读取完整回答，仅更新 `reply`，保留草稿、待澄清问题和修订号。当前草稿在每次模型请求前通过 section 注入；指令要求修改已有对象时保留 ID，重复执行同一工具任务不会重复增加修订号。

`ProviderDoc.sessionId` 是 Pi 为每个 Conversation 保存的稳定提供方会话标识，用于模型提供方的缓存和会话关联。当前项目将它复用为规划接口的公开 `session_id`，并作为业务、模型和 Durable 观察器记录的 `session.id`，供 Langfuse 按 Session（多轮追踪分组）关联；这是项目的关联策略，Pi 提供方会话与 Langfuse Session 并非同一个概念。创建后附着会话事件观察器，会话本身不导出长期根 span。每轮消息形成 HTTP → `spatial-planning.run` → `invoke_agent spatial-planning` → `chat {模型 ID}`／`execute_tool update_spatial_draft` 的父子链；提交来源与 Generation／Tool hook 显式恢复上下文，后续轮次继续归入同一 Session。

每轮业务根记录草稿修订号、空间／通道数量及问题数量，观察器保留 `pi.durable.*` 会话、提交、任务和工具调用标识。`OTEL_INCLUDE_CONTENT=true` 时，逻辑评测根的输入包含完整本轮请求及图片，输出包含回答、澄清问题和完整草稿；`metadata.evaluation_context` 汇集实际模型输入消息与工具调用的参数、结果及状态。图片原始 base64 随 span 导出，不单独上传媒体。已提交结果的观察器投影另过滤凭据与不透明签名，不修改模型输入。会话关闭时释放观察器，运行时刷新共享追踪处理组件，由应用关闭 NodeSDK；未核对终态的运行按观察中断记录为 `WARNING`。Langfuse 真实入库及界面展示尚未实机验证，字段与边界见[共享追踪说明](../../packages/observability/README.md)。

单轮等待使用配置的执行期限；同一规划正在运行时，新消息返回 `workflow_busy`，不同会话可以独立执行。超时或取消会中止该规划会话当前运行，已提交的草稿可通过 `read` 核对；后续仍可继续提交消息。`close` 先撤销这个会话 ID 的消息接纳，再中止当前运行、取得最终草稿并关闭该会话独有的 Harness、观察器及提供方资源，释放内存存储引用。页面取消和 SPA 离页会关闭已取得 ID 的会话；创建期间离页会等到 ID 返回再关闭。整页强关或网络故障导致创建回执完全丢失时，可能保留会话到家庭撤销或服务关闭。

与主助手一样使用 `MemoryStorage`，只在本次进程运行期间保留会话；重启后 ID、对话和草稿清空，不提供重启恢复。Spaces 页面通过 Backend 的家庭 workflow 入口使用图片与持续问答，页面展示最新草稿；尚未接入空间保存或摄像头采集，也未验证真实户型图片的识别质量。

### 语音请求判断

语音请求判断使用同一内部 `POST /api/workflows`，指定 `workflow="speech-interpretation"`，输入复用 `speechDialogueRequestSchema`，结果复用 `speechDialogueResponseSchema`（`id/observationId/decision`）。实现位于 `workflows/speech-interpretation.ts`，直接调用一次 pi-ai 结构化模型输出，不使用聊天主会话。

Backend 负责转写片段的来源资格、45 秒有效期、限流和判断状态，经现有 Agent 客户端调用此 workflow；Agent 重新校验请求时效和前文关系。执行期限取配置的预算与材料到期时间；Backend 仍以最多 12 秒及片段原期限控制等待。缺模型、Agent 不可用或判断失败由 Backend 显示为 unavailable；本地转写仍可运行。此判断不执行聊天或设备动作。

Agent 与 Backend 共用 Hono 的访问校验、输入校验和错误处理；共享 RPC 客户端使用 `hono/client`，服务调用通过 `tracedFetch` 传播追踪上下文。校验成功后仅对本次模型请求关闭连接空闲计时，模型执行期限仍由聊天或 workflow 管理。

## 当前数据接收与只读历史客户端

回执摘要在接纳消息时校验并冻结，索引读取复用同一份摘要；详情与摘要共享变化记录，连接或家庭资格结束时一起释放。

`src/context/receiver.ts` 导出 `createContextReceiver({ client })`，使用 `@home-agent/backend-client` 创建的 RPC 客户端。`start()` 自动订阅，`stop()` 取消连接与重连等待；`snapshot()` 提供收到的内存数据，`currentScope()` 仅在当前连接已收到全部六部分初始状态时返回可用家庭身份。SSE 解码使用共享 `@home-agent/api/http/event-stream`，复用成熟的 eventsource-parser。

`GET /api/received-context` 复用 Agent 本机访问限制，返回 `{ scope, connection, parts, received_at, context_bytes }`。connection 包含连接 status、synchronized 与 last_error；全部部分收到初始状态后才标记已同步，部分为 loading、failed 或 unavailable 时仍保留各自状态。last_error 为 null 或 `{ reason, at }`，保留最近失败的安全分类和 UTC 时间，直到收到合法事件后清空。分类区分请求失败、HTTP 状态、无效事件流、超时、JSON／契约错误、流读取失败和正常结束；订阅失败日志最多每 30 秒记录一次，不包含接收正文或原始异常。后续省略部分保留旧值；设备状态增量只更新或删除指定条目，其他提供部分整体替换；ready 的空集合清空对应集合，heartbeat 不改变同步。首次连接、重连及家庭资格变化先清空接收数据；断线标记未同步。该入口用于诊断，不保存持久日志，也不代表模型输入。received_at 只记录数据消息，心跳单独计时。断线、停止及意外失败时清空当前数据。

`GET /api/context-receipts` 返回接收索引、连接、家庭资格、最近数据与心跳时间。首次不带查询参数时读取当前连接的全部摘要；后续同时提供 `journal_id` 和 `after_sequence`，只读取同一接收会话中序号更大的摘要。会话不匹配或请求序号超过当前序号时返回全部摘要。`GET /api/context-receipts/:id` 返回单条接收消息与该次合并后的完整上下文；`GET /api/context-receipts/current` 返回带接收会话标识的当前快照。所有入口复用本机访问限制。Web 通过 Backend 只读代理观察，页面用法见[Agent 接收数据观察](../web/README.md#agent-接收数据观察)。

`context/journal/index.ts` 由接收器独占，消息在通过校验并合并后记录。设备增量正文只保留本次条目变化，context 保存增量合并后的完整状态；合并使用共享 Mutative 封装，不修改旧接收记录。记录保留接收序号、UTC 时间、初始接收／状态更新、涉及部分、原始正文 `payload_bytes`、合并上下文 `context_bytes` 字节数、校验后的消息和当时上下文；不是原始 SSE 字节归档。`context_bytes` 用原生 JSON 序列化计算完整 `{ scope, parts }` 紧凑 JSON 的 UTF-8 字节数，接收记录固定为当时大小，当前快照接口按本次读取状态计算；不含连接诊断字段，不代表进程内存占用。记录在当前连接与家庭资格存续期间完整保留，连接或家庭资格改变时清空并更换会话标识，重启丢失，不重放或保存消费进度。心跳不生成接收记录。读取失效接收会话的记录返回 404。

统一观察保存观察索引、`member_sighting_ids/window_id` 引用、成员出现的轻量身份投影及归因修订号、轻量窗口材料摘要，不保存成员记录正文或完整音视频窗口详情。`createContextReader({ client, receiver })` 提供 `readMaterial` 方法，接受 `{ kind: "member_sighting" | "perception_window", id }` 和取消信号，自动携带当前 scope 调用 Backend 的 `/api/agent/context/material`。读取前后核对接收资格、响应类型与引用 ID；源材料过期、移除或资格变化时失败，不用旧缓存替代，不写回上下文。返回的是来源当前保留版本，不是当时接收内容。

同一读取模块的 `readHistory` 方法读取三类历史。receiver 提供当前接收资格；调用者传入 `kind=device_reports|member_sightings|perception_windows`、UTC 区间、相应对象条件、分页参数及取消信号。设备分支沿用原读取条件；成员使用可选 member_ids/sources，音视频使用可选 sources，返回完整窗口与匹配引用。用法与字段见[共享契约](../../packages/api/README.md#agent-数据交付契约)。

网络请求使用共享 RPC 和 `@home-agent/api/http/request-json`，组合调用方取消与请求截止时间，有界读取并校验响应，不自动重试。Backend 返回的公共错误码及字段说明保留，传输或非法响应报告不可用；超时与取消分别报告。上下文读取模块在返回前重新核对连接代次、绑定身份、家庭运行资格及请求区间；失败、超时或资格改变拒绝结果，不用当前值或旧缓存代替历史。接收数据仅存在于内存，重启重新读取，不保存 SSE 消费进度。读取工厂供调用方显式装配，当前聊天未使用它，也未注册模型工具；启动模块不导出业务调用实例。实机与专项边界统一见[Agent 通路验证边界](../../docs/household-runtime.md#agent-通路验证边界)。

## 家庭模型视图

共享包 `@home-agent/api/household-model-view` 的 `createHouseholdModelView(context)` 接受已校验的接收快照，生成设备清单、能力、有值状态、完整空间关系、最新观察摘要与近期操作，并提供受相同规则约束的 `spec/state` 查询。输入必须有家庭范围、`household/spatial/device_state/members/observations` 五部分 ready 数据以及已收到的 `operations` 部分；`operations` 即使 loading/unavailable/failed 也保留其状态，不阻止原有数据展示；缺少规格的设备仍在设备清单中，不编造能力。该模块由 Agent 和 Web 压缩上下文页共用，Backend 和接收器继续保存完整来源事实。当前聊天入口尚未调用此模块。

模块直接接收数据，不依赖接收器、模型框架或 CLI。`createHouseholdModelView` 与 `encodeHouseholdContext` 在内存中同步执行，没有订阅、定时器、网络／文件读写或跨调用缓存；Agent 的 `scripts/format-context.ts` 命令单独负责文件读写与审计产物输出。进程内用法如下（`snapshot` 为已校验的接收快照）：

```ts
import {
  createHouseholdModelView,
  encodeHouseholdContext,
} from "@home-agent/api/household-model-view";

const view = createHouseholdModelView(snapshot);
const contextJson = JSON.stringify(encodeHouseholdContext(view.semantic));
```

`view.query(deviceId, keys, "spec" | "state")` 始终查询创建该视图时的同一份快照，返回的 `source` 为 `snapshot`。转换时隔离所使用的来源数据，调用方之后修改输入不会改变该视图的查询结果；查询结果也不会修改来源数据。读取更新后的状态需要向转换函数传入新快照，已有视图不会自动更新。能力规格仅在单次转换内复用。

接收器继续拥有当前快照、版本、连接状态和家庭范围；调用方负责选择快照及判断连接新鲜度。接收时间不等于属性测量时间，转换不会把旧状态升级成实时状态。输入缺少家庭范围、上述五部分中任一未 ready 或尚未收到 `operations` 时抛出错误；已收到的 `operations` 保留非 ready 状态。转换不隐式复用上一次结果。当前没有模型上下文自动注入逻辑。

摄像头只展示切换常看位置、巡航开关／模式／位置；人在传感器只展示可明确辨认的整体有人／无人属性，无法确认整体项时不选某个分区替代。人体移动传感器保留移动事件，不由此推断持续有人。自检、开发者模式、码库匹配、协议载荷和内部标识等细节由 `policy.ts` 排除。摄像头分析及事件归 Backend。缺值和未知规格不生成状态占位；缓存、待验证、过期等原始质量及时间保持不变。

能力不因当前缺值而消失，也没有每设备数量或 token 上限。领域规则先决定哪些能力可见，`spec/state` 仅接受设备已列出的能力键，不能重新查询被规则排除的内容。在允许的能力中，默认上电状态、检测灵敏度、提示音和具有独立开关的指示灯配置值不进入概览，但对应能力及 `state` 查询保留。摄像头及存在传感器服务中的检测灵敏度仍受前述能力规则排除，不承诺可查询。这属于概览筛选；编码和解码对筛选后的语义视图无损。语义键在设备内消歧，完整规格查询包含当前视图允许的属性、动作和事件；没有独立访问权限的事件参数不会伪装成可查询属性。`capabilities.ts` 处理 MIoT 名称、权限、单位和来源型号过滤；型号排除数据的固定官方来源见相邻 `miot-exclusions.json`。这不依赖 Home Assistant 运行时，不执行供应商代码，也不表示复现了所有 HA 平台组件行为。

`encoding.ts` 共享相同的能力定义和能力集合：`C` 按权限与直接可读的类型分组，每条定义显式保存全局编号、查询键和名称；`S` 保存能力编号集合；`D` 保存设备 ID、名称、房间名称、类别及能力集合索引。只有能力集合与定义使用索引，房间、类别和类型无需查字典。能力缺少状态报告不表示设备不支持它。

`states` 按设备合并在线状态与属性报告，每条直接带设备 ID 和名称，通过 ID 与设备清单对应，不依赖数组位置；没有属性报告的设备仍保留在线状态和空报告数组。报告组共享质量与时间，值行直接保存查询键、原始值、单位、枚举标签及可信变化时间。省略的尾部字段表示未知；合法的 `false`、`0` 和 `null` 原样保留。报告接收时间不是测量时间，顶层 `received_at` 只表示快照接收时间。解码校验格式、能力索引与权限、设备身份和名称、每台设备唯一状态、属性归属、重复查询键及关注项。

序列化顺序为 `schema / instructions / C / S / D / meta / attention（可选）/ received_at / states / observations / operations`。格式说明、共享能力、设备清单和家庭资料位于稳定前部，动态状态、观察和近期操作放在后部；成员资料与最近出现合并，不再单独放入 `meta`。调用方应保留该顺序，以便支持前缀缓存的模型服务复用稳定内容。实际缓存命中取决于服务端支持、缓存保留和完整请求布局；当前格式在实际聊天入口的命中率、费用及延迟收益尚未验证。

`meta.空间关系` 完整保留同一快照的 `spaces/passages/observation_bindings`，包括所有空间、通道两端的空间 ID、设备／镜头到空间或通道的观测绑定，以及各记录的 ID、说明、创建／更新时间和绑定启用状态；不按是否出现成员或是否绑定设备筛选。解码后还原为语义视图的 `空间关系`。这些是配置关系，不代表成员当前位置、通道实时通行状态或过去的观测覆盖；停用绑定不用于定位，设备清单中的房间名称也不能替代空间 ID。

`observations.members` 每位成员只出现一次，包含 ID、名字、类型、物种、简介和 `last_seen`；成员资料取自同一快照，ID 用于区分同名成员。最近出现保留时间、观测区域或摄像头来源及已确认／待确认／推断状态。`observations.clues` 按摄像头汇总未识别目标、画面变化、语音和猫狗声，直接包含设备 ID、别名或名称和镜头编号。同类线索只保留最后时间，详细依据、材料引用和修订信息不进入摘要；需要细节时读取原始观察或历史。时间使用 ISO 字符串。

摘要直接格式化 Backend 已选取的最新状态集合，不再次按时间筛选或裁剪，也不跨调用保存位置；成员最后出现由 Backend 从数据库选取，可早于 30 分钟，`as_of` 仅表示整理时间。成员没有保留的出现记录时 `last_seen` 为空，来源状态区分无记录与读取不可用，均不表示离家。最后出现不等于当前位置，同一时刻的多个来源一并保留。观测区域先要求当前设备／镜头的启用绑定唯一，再检查该绑定最后更新时间不晚于首次观察；否则标明摄像头来源和位置未确认，不把摄像头所在房间当作成员位置。摄像头来源优先显示设备别名，无别名时显示名称，并保留设备 ID 和镜头编号以区分同名设备；设备已不在设备清单中时仍显示 ID 和镜头编号。窗口声音不归因给同窗成员。

从仓库根目录运行，输入是 `GET /api/context-receipts/current` 保存的完整 `{ journal_id, context }` JSON：

```sh
bun run --cwd apps/agent context:format --input /path/current.json overview --output /path/model-context
bun run --cwd apps/agent context:format --input /path/current.json devices
bun run --cwd apps/agent context:format --input /path/current.json spec <device-id> [semantic-key...]
bun run --cwd apps/agent context:format --input /path/current.json state <device-id> [semantic-key...]
bun run --cwd apps/agent context:format --input /path/model-context/context.json decode
```

输出 `context.json` 是紧凑模型输入，`context.pretty.json` 和 `context.formatted.json` 是同内容缩进版，`context.decoded.json` 是还原的语义视图。`capability-audit.json` 给出每项能力的排除原因，`manifest.json` 记录输入文件和紧凑输出的 SHA-256 指纹，统计设备、能力、属性值条数（`reports`）、Unicode 码点和 UTF-8 字节数。`semantic_bytes` 是筛选后语义视图的紧凑 JSON 字节数，`bytes` 是编码后紧凑 JSON 字节数，两者比较仅衡量编码效果。原始快照到语义视图还包含领域筛选，不能将其缩减全部计为无损编码收益。token 数需用目标模型分词器另算，不能用字符数固定换算。CLI 在写入前核对编码和解码内容一致，并拒绝输出或关注记录覆盖输入文件；输出文件之间以及输出与关注文件之间也不能指向同一文件。

`spec/state` 的显式键查询可附带 `--attention <file> --remember`，成功后记录关注键；`overview` 读取同一 `--attention` 文件时只突出仍有效的关注项，不删减其他能力。全量查询不记录关注。查询仅读取保存快照，不刷新设备、不执行动作，不重新带入领域规则排除的内容。原始快照和输出应放在本地数据位置，不提交设备及成员资料。

### 格式比较与模型理解检查

近期操作保持原部分的状态、读取时间、原因、截断及六字段记录；压缩编码的 `operations` 完整保留 source 文本、target 地址、参数顺序与 false/0/null，解码还原为 `近期操作`。不二次筛选、不补写名称或指令。范围为最近 30 分钟、最多 100 条，非完整审计；发送时间只表示发送开始。设备清单和能力可辅助解析目标，接收上下文不表示已注入聊天模型。

压缩方案比较须固定同一输入指纹，并分别记录筛选后的属性值数量与目标分词器的 token 数。单项编码候选先比较 token 收益，再组合；字符或字节减少不保证 token 减少。CLI 的还原校验只证明筛选后视图的编解码一致性，不证明模型理解准确率。

`scripts/context-understanding.ts` 对同一份 CLI 产出的语义 JSON 和编码 JSON 执行小范围理解对照。它核对输入指纹、输出指纹和两种格式语义一致性，以相反顺序各运行两次，共四次独立模型请求。使用 `.env` 中的 MiMo 中国区 Token Plan 配置，关闭思考，每次最多输出 2,048 token；请求会发送这份家庭视图并产生模型费用，运行前须获得授权。

```sh
bun --env-file=.env apps/agent/scripts/context-understanding.ts --context /path/model-context --cases /path/cases.json --output /path/new-results
```

题目文件包含 `input_sha256`（取自 CLI manifest）和 `questions` 数组，每题具有唯一 `id`、说明返回 JSON 结构的 `question` 和人工核对的 `expected`。标准答案应依据固定快照的设备、规格与事实核实，不能直接采用被测模型的回答。标准答案只用于本地判分，不发送给模型；按题比较 JSON 值、类型和结构，数组顺序也参与判分。题目及结果含家庭资料时只保存在本地数据位置。

输出目录必须不存在。结果保存模型原文、逐题得分、请求用量、输入指纹和调用条件，需逐条检查失败是否来自模型理解、题目歧义或标准答案错误。网络与服务错误中断运行，不能算作模型理解失败。小样本结果只覆盖所选问题，不代表完整 Agent 的工具调用、长期理解准确率或实时场景判断。依据失败题修改格式后的同题重跑属于修复验证，不是独立泛化评估；泛化判断需要另外冻结未参与修改的新题和快照。缓存验证另看完整请求返回的缓存 token，不能以公共前缀长度或短请求耗时替代。

## 模型配置

模型选择统一写成 `provider/modelId`，例如 `openai/gpt-4o-mini` 或 `xiaomi-token-plan-cn/mimo-v2.6-flash`。第一条斜杠分隔 Provider ID 和模型 ID，模型 ID 自身可以包含斜杠；不能包含空白。`config.ts` 与各 workflow 的配置复用 `models.ts` 中的解析规则，将它转换为 pi-durable 使用的 `{ provider, modelId }`。Provider（服务提供者）负责模型清单、认证、端点和请求协议；同一模型通过不同服务接入时，使用不同的 Provider ID 区分。

| 配置                     | 用途                                                                   |
| ------------------------ | ---------------------------------------------------------------------- |
| `AGENT_MODEL`            | 主助手的模型，空值时不启用聊天                                         |
| `AGENT_AUTOMATION_MODEL` | 自动化生成模型，省略时用主模型                                         |
| `AGENT_SPEECH_MODEL`     | 语音判断模型，省略时用主模型                                           |
| `AGENT_SPATIAL_MODEL`    | 空间规划模型，省略时用主模型                                           |
| `AGENT_SUBAGENT_MODELS`  | JSON 字符串数组，子 Agent 可选的额外模型引用；可用的主模型也会加入列表 |

不同用途独立选择 Provider，内置 Provider 各自读取原生凭据。例如 OpenAI 使用 `OPENAI_API_KEY`，Anthropic 使用 `ANTHROPIC_API_KEY`，DeepSeek 使用 `DEEPSEEK_API_KEY`。MiMo 中国区套餐使用 `xiaomi-token-plan-cn` 和 `XIAOMI_TOKEN_PLAN_CN_API_KEY`。其他提供商的 ID、模型清单与认证变量见 [pi-ai 文档](https://github.com/earendil-works/pi/blob/v1.2.0/packages/ai/README.md#supported-providers)。模型示例必须在当前安装版本的原生清单中存在；配置值不保证远端服务可用。

```dotenv
AGENT_MODEL=xiaomi-token-plan-cn/mimo-v2.6-flash
AGENT_AUTOMATION_MODEL=deepseek/deepseek-chat
AGENT_SPEECH_MODEL=openai/gpt-4o-mini
AGENT_SPATIAL_MODEL=anthropic/claude-sonnet-4-5
AGENT_SUBAGENT_MODELS='["openai/gpt-4o-mini","anthropic/claude-sonnet-4-5"]'
XIAOMI_TOKEN_PLAN_CN_API_KEY=你的项目密钥
DEEPSEEK_API_KEY=你的项目密钥
OPENAI_API_KEY=你的项目密钥
ANTHROPIC_API_KEY=你的项目密钥
```

`models.ts` 的 `initializeModels({ modelRefs, timeoutMs, signal })` 只注册引用集合涉及的 Provider，包装共享模型追踪后校验每个模型引用。已认证模型与助手的委派候选分别使用以 `provider/modelId` 为键的原生 `Map` 保存，查询及候选枚举共用对应索引。返回的 `resolve(modelRef)` 从本次已认证的模型索引查找模型，未配置或不可用时返回 undefined，不再次进行认证或网络请求。`select(modelRefs)` 复用该查询，过滤不可用模型并按相同键去重，返回所选模型的 `Map`；助手通过它建立委派候选集合。模型引用使用 pi-durable 原生 `ModelRef`（`provider` 与 `modelId`），助手工厂以 `modelRef` 和 `subagentModelRefs` 区分模型引用与实际模型对象，生成注册器根据各工作流的配置声明选择专项模型引用，并将对应的 `modelRef` 传给各业务的 `createWorkflow(context)`；调用 Pi 会话配置时仍使用原生 `model` 字段。`createAssistant()` 选择主模型，并把可用主模型与配置的额外模型合并、去重为委派候选；`createApp()` 通过 `configureWorkflows(config)` 收集模型引用并创建专项实例；各 workflow 从模型清单解析收到的引用。通过 pi-ai 原生 `getAvailable()` 按 Provider 检查认证及模型过滤规则；启动认证同时响应退出信号与 `AGENT_RUN_TIMEOUT_MS` 期限。缺少凭据时，仅该 Provider 的模型不可用；对应任务返回 `model_not_configured`，其他已配置任务及家庭资料接收继续可用。认证解析异常仍令启动失败。可以只设置专项模型而不设置主模型；没有可用的主模型就不创建聊天助手或委派工具。

委派工具接受 `subagent({ task, model? })`。`model` 的可选值是完整 `provider/modelId`，因此不同 Provider 的同名模型不会混淆。主助手在每次委派时选择，省略时子会话继承父会话模型；不可用模型不会进入可选列表。选择通过 pi-durable 原生 `configure(tx, child.id, { model: { provider, modelId } })` 保存到子会话，与主助手共用 Harness 和Models collection。同一工具任务重放时复用原子会话和模型选择。子 Agent 不递归委派，见[官方独立模型会话示例](https://github.com/earendil-works/pi/blob/v1.2.0/packages/durable/test/examples/28-reviewer.ts)。

Provider 的模型资料及认证由 pi-ai 原生实现维护，当前只注册其内置清单中的 Provider。未注册 Provider 或清单外模型会令启动失败。服务不联网刷新原生模型清单，不提供 OAuth 登录或持久凭据存储入口。请求期限、重试和输出预算沿用调用方的原生请求选项。自动化与语音判断要求严格工具输出；带图片的空间规划还要求 image 输入能力。跨厂商真实请求和长期委派尚未实机验收。

费用为零的模型不作为供应商实际费用导出到 Langfuse；Langfuse 可按项目模型价格与实际用量推算费用。
