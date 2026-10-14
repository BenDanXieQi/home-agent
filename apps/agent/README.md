# Agent

基于 pi-durable 的常驻家庭助手服务，入口为 `src/assistant.ts`，Harness、工具注册、委派和本地环境均在同一文件中装配。Hono 定义内部 HTTP 路由，由 `Bun.serve()` 承载；backend 转发请求，Web `/agent` 向同一个主会话提交消息。

## 运行

根目录 `.env` 配置原生 `AGENT_PROVIDER`、`AGENT_MODEL`、`OPENAI_API_KEY`。`AGENT_PROVIDER` 默认 `openai`；MiMo 中国区套餐使用 `xiaomi-token-plan-cn`。模型必须支持工具调用；模型的容量、输入能力和协议取自 pi-ai 原生清单，清单外模型须明确提供元数据。端点覆盖和 `AGENT_THINKING` 见[模型配置](#模型配置)。Agent 在启动入口调用 `@earendil-works/pi-ai` 的 `createModels()` 和 `createProvider()`，注册模型及服务提供者；Backend 通过 workflow 请求语音判断，不直接读取模型配置。

```sh
bun install
bun run --cwd apps/agent dev
```

`AGENT_HOST` 默认 `127.0.0.1`，`AGENT_PORT` 默认 `1811`。`BACKEND_URL` 使用 HTTP(S) 地址，默认 `http://127.0.0.1:3000`；Backend 使用自定义监听地址时显式配置。无需数据库或 Agent Server。根目录开发命令仍会启动本项目其他服务。后台上下文接收不要求模型配置。独立运行类型检查或 lint 前先执行 `bunx turbo run build --filter=@home-agent/backend-client`，生成服务端及客户端声明；Turbo 的 Agent 构建、检查和开发命令已声明该依赖，开发时同时维护两份声明。生成职责见[共享 Backend 客户端](../../packages/backend-client/README.md)。

## 接口

`POST /api/workflows` 是 Backend 调用专项任务的统一内部入口，复用当前进程、本机访问校验和错误格式。自动化生成使用 `workflow="automation-generation"`，请求为 `{ workflow, input: { text, definition?, capabilities } }`；`definition` 为可选的现有规则，`capabilities` 为调用方准备的设备能力。响应为 `{ workflow, result: { definition, behavior, clarifications } }`。存在歧义或生成内容未通过校验时，`definition` 为 null，调用方展示说明或澄清问题，不能当作已生成的有效规则。

生成能力位于 `src/workflows/automation-generation.ts`，直接使用 pi-ai `Models.complete()` 执行一次严格工具输出请求；规则结构、设备引用、读写权限、枚举及动作参数按 `@home-agent/api/automations` 校验。输入中的能力用于约束草稿，不构成设备操作授权；保存或执行前仍需 Backend 核验当前家庭及设备能力。它不保存或启用规则、不操作设备、不使用聊天历史或 Agent 数据库。

入口请求上限 256 KiB，响应上限 128 KiB，同类 workflow 同时执行一项，繁忙返回 `workflow_busy`；运行期限取 `AGENT_RUN_TIMEOUT_MS` 与 90 秒的较小值，取消和超时传递到模型调用，结束后释放执行名额。未配置模型返回 `model_not_configured`。公共分发位于 `src/workflows/index.ts`，接收 Hono 入口已校验的输入，负责并发名额、执行期限和结果边界；专项模块不另建 HTTP 或客户端层。Backend 已通过公共 `/api/workflows` 入口调用本服务，从当前家庭规格准备能力，返回前重新校验家庭资格与设备能力。自动化页面已通过 Backend 公共入口调用生成；生成器和共享校验拒绝交付含 AI 条件或动作选择的可用草稿，这两项能力尚未启用。真实家庭场景的规则生成质量尚未系统验证。

进程复用 `@home-agent/observability` 初始化 OpenTelemetry。HTTP 入口通过共用的 Hono 追踪中间件接续 Backend 的 W3C 追踪上下文，生成调用记录 `automation.generate` span、耗时、草稿校验结果及供应商返回的输入／输出 token 用量。默认不采集正文；`OTEL_INCLUDE_CONTENT=true` 时才记录输入资料和生成结果，导出方式沿用[共享追踪配置](../../packages/observability/README.md)。供应商没有返回用量时不估算 token 数。聊天入口具有 HTTP 和等待 span；pi-ai 模型调用与 pi-durable 工具执行使用独立 trace，并按运行器唯一的 Langfuse Session 关联，避免排队任务继承旧请求上下文。直接导出使用 Langfuse。关闭时停止请求并关闭 exporter。

`GET /health` 返回服务状态和 `modelConfigured`；配置存在不表示供应商调用成功。

`POST /api/chat` 接受 `{ "message": "你好" }`，完成后返回 `{ "answer": "…" }`。Web 通过 backend 的同名接口访问。输入只接受 `message`，最多 16,000 字符、请求体最多 32 KiB；响应文字最多 65,536 字符。使用普通 JSON，不提供 SSE、thread ID 或历史接口。

所有聊天请求复用当前进程内同一个主会话和工作目录。忙碌时由 pi-durable 默认 follow-up 收件箱排队，前端仍只展示本次回答。刷新页面不清空服务端会话；重启后清空。当前主会话没有按账号、家庭或浏览器隔离。

独立接收模块自动订阅 Backend 当前家庭、空间关系、设备状态、成员和统一观察，并通过只读客户端查询实际保留的历史。家庭助手的模型尚未接入这些材料或家庭业务工具，不能安排提醒或控制设备；没有改变现有聊天输入及模型行为。数据来源、保留与验证限制见[家庭运行时](../../docs/household-runtime.md#agent-当前数据与材料历史)。

Bun 保留默认连接空闲超时，仅在请求体完成校验后对本次模型请求关闭空闲计时，由执行期限控制等待。模型明确返回长度截断、内容过滤、未完成或失败状态时，不作为完整回答返回；结果未知时不自动重发。

HTTP 复用本机访问限制和统一错误契约。仅限可信本机使用，不提供账号认证。模型缺配置返回 503，超时返回 504，执行失败返回安全错误，不返回供应商原始异常。

## 运行器与工具

`assistant.ts` 按官方 [26-coding-agent](https://github.com/earendil-works/pi/blob/main/packages/durable/test/examples/26-coding-agent.ts) 与 [22-subagent-foreground](https://github.com/earendil-works/pi/blob/main/packages/durable/test/examples/22-subagent-foreground.ts) 的单文件组织方式，直接定义委派扩展、注册工具、创建 `NodeExecutionEnv`，调用 `Harness.open()` 并取得 `root`。没有自定义运行器类或目录。配置解析、HTTP 路由和家庭资料接收是本项目的服务代码，不是官方示例提供的目录结构。

`createAssistant(models, model, options)` 返回原生 `root`、观测用的 `sessionId` 和资源关闭函数。`chat.ts` 直接执行 `root.submit()`、`submission.wait()` 和 `root.commit()`，从 `AssistantEntry` 读取回答。主助手与子助手共用本文件的最终文字校验，拒绝工具调用未完成、截断、错误或空白答案。

一个助手实例使用 `MemoryStorage`、一个主会话和临时工作目录。`main.ts` 在监听 HTTP 前创建实例；后续消息复用同一原生会话。退出时 `close()` 先关闭 Harness，再清理执行环境与工作目录；重复关闭复用同一 Promise，初始化失败也释放已创建资源。

上下文自动压缩沿用框架默认策略；原始内存记录仍随历史增长，没有磁盘会话存储或重启恢复，长期资源占用与摘要质量尚未验证。现有家庭接收器独立运行，尚未接入模型事件唤醒或定期检查。

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

- `assistant.ts`：单文件定义助手及子 Agent 委派，直接装配原生 Harness、工具、追踪与执行环境，负责主会话创建和资源关闭。
- `config.ts`：服务与模型环境变量的解析、校验和默认值。
- `models.ts`：根据模型 ID 查找能力、校验协议并生成 pi-ai provider 配置，不选择业务用途。
- `main.ts`：按助手、workflow 和子 Agent 用途选择模型，传入执行预算，装配共享 Backend RPC 客户端与应用，以及常驻助手、服务器、接收器和追踪的启动／关闭。
- `app.ts`：无启动副作用的 Hono 应用工厂，复用本机访问、JSON 校验、请求大小限制、错误处理及 HTTP 追踪中间件。
- `chat.ts`：向原生主会话提交消息、等待并校验 HTTP 回答，处理等待期限与错误映射。
- `context/receiver.ts`：Backend 专用 SSE 接收、六部分内存状态、连接和家庭资格。
- `context/receipts.ts`：受接收器管理的有限内存接收记录与当时上下文；`context/receipt-changes.ts` 在接收时比较前后状态并提取诊断变化摘要。
- `context/reader.ts`：历史与引用材料读取；使用共享 Backend RPC 客户端，负责当前接收资格及响应与请求的匹配校验。
- 家庭模型视图：转换、编码和解码由根目录共享包 `packages/api/` 提供，供 Agent 与 Web 使用；离线文件处理命令属于本应用的 `scripts/format-context.ts`。
- `workflows/speech-interpretation.ts`：语音请求完整性与回应需求的结构化模型判断。

## 专项能力

专项能力按业务放在 `src/workflows/<业务名>.ts`，每个文件包含其指令与实现。自动化生成和语音判断通过 pi-ai 执行一次结构化模型调用，不创建 Harness。

空间规划尚未接入 Agent 服务；当前不能从聊天或专项请求启动规划、自动保存空间配置。

语音请求判断使用同一内部 `POST /api/workflows`，指定 `workflow="speech-interpretation"`，输入复用 `speechDialogueRequestSchema`，结果复用 `speechDialogueResponseSchema`（`id/observationId/decision`）。实现位于 `workflows/speech-interpretation.ts`，直接调用一次 pi-ai 结构化模型输出，不使用聊天主会话。

Backend 负责转写片段的来源资格、45 秒有效期、限流和判断状态，经现有 Agent 客户端调用此 workflow；Agent 重新校验请求时效和前文关系。语音请求及响应预算分别为 96 KiB、24 KiB，执行期限不超过配置值、11 秒和材料到期时间；Backend 仍以最多 12 秒及片段原期限控制等待。语音与自动化生成各有一个并发名额，互不占用。缺模型、Agent 不可用或判断失败由 Backend 显示为 unavailable；本地转写仍可运行。此判断不执行聊天或设备动作。

Agent 与 Backend 共用 Hono 的访问校验、输入校验和错误处理；共享 RPC 客户端使用 `hono/client`，服务调用通过 `tracedFetch` 传播追踪上下文。Agent 在读取请求体前保存 Bun 原始 Request；校验成功后仅对本次模型请求关闭连接空闲计时，模型执行期限仍由聊天或 workflow 管理。

## 当前数据接收与只读历史客户端

回执摘要在接纳消息时校验并冻结，索引读取复用同一份摘要；详情与摘要共享变化记录，淘汰或清空时一起释放。

`src/context/receiver.ts` 导出 `createContextReceiver({ client })`，使用 `@home-agent/backend-client` 创建的 RPC 客户端。`start()` 自动订阅，`stop()` 取消连接与重连等待；`snapshot()` 提供收到的内存数据，`currentScope()` 仅在当前连接已收到全部六部分初始状态时返回可用家庭身份。SSE 解码使用共享 `@home-agent/api/http/event-stream`，复用成熟的 eventsource-parser。

`GET /api/received-context` 复用 Agent 本机访问限制，返回 `{ scope, connection, parts, received_at, context_bytes }`。connection 包含连接 status、synchronized 与 last_error；全部部分收到初始状态后才标记已同步，部分为 loading、failed 或 unavailable 时仍保留各自状态。last_error 为 null 或 `{ reason, at }`，保留最近失败的安全分类和 UTC 时间，直到收到合法事件后清空。分类区分请求失败、HTTP 状态、无效事件流、超时、JSON／契约错误、流读取失败和正常结束；订阅失败日志最多每 30 秒记录一次，不包含接收正文或原始异常。后续省略部分保留旧值；设备状态增量只更新或删除指定条目，其他提供部分整体替换；ready 的空集合清空对应集合，heartbeat 不改变同步。首次连接、重连及家庭资格变化先清空接收数据；断线标记未同步。该入口用于诊断，不保存持久日志，也不代表模型输入。received_at 只记录数据消息，心跳单独计时。断线、停止及意外失败时清空当前数据。

`GET /api/context-receipts` 返回接收索引、连接、家庭资格、最近数据与心跳时间。首次不带查询参数时读取全部保留摘要；后续同时提供 `journal_id` 和 `after_sequence`，只读取同一接收会话中序号更大的摘要。会话不匹配或请求序号超过当前序号时返回全部保留摘要。响应的 `first_retained_sequence` 标记最早保留序号，无记录时为 `total_received + 1`，客户端据此移除已淘汰记录。`GET /api/context-receipts/:id` 返回单条接收消息与该次合并后的完整上下文；`GET /api/context-receipts/current` 返回带接收会话标识的当前快照。所有入口复用本机访问限制。Web 通过 Backend 只读代理观察，页面用法见[Agent 接收数据观察](../web/README.md#agent-接收数据观察)。

`context/receipts.ts` 由接收器独占，消息在通过校验并合并后记录。设备增量正文只保留本次条目变化，context 保存增量合并后的完整状态；合并使用共享 Mutative 封装，不修改旧接收记录。记录保留接收序号、UTC 时间、初始接收／状态更新、涉及部分、原始正文 `payload_bytes`、合并上下文 `context_bytes` 字节数、校验后的消息和当时上下文；不是原始 SSE 字节归档。`context_bytes` 为完整 `{ scope, parts }` 紧凑 JSON 的 UTF-8 字节数，接收记录固定为当时大小，当前快照接口按本次读取状态计算；不含连接诊断字段，不代表进程内存占用。接收记录按不可变对象引用缓存字节数，设备增量复用未变化条目的统计；统计过程不重复序列化完整上下文或完整接收记录。最多 1000 条，同时按每条完整序列化体积计入 64 MiB 预算（共享对象仍重复计数），超限淘汰最早记录并累计数量。连接或家庭资格改变时清空记录并更换会话标识，重启丢失，不重放或保存消费进度。心跳不生成接收记录。读取已淘汰记录返回 404。响应上限覆盖整个接收记录保留预算及响应信封，计入变化摘要，保证保留的单条详情和完整索引均可读取。

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

主助手使用 `AGENT_MODEL`。以下可选配置使用同一个 `AGENT_PROVIDER`，共用凭据、端点覆盖和思考参数：

| 配置                     | 用途                                                            |
| ------------------------ | --------------------------------------------------------------- |
| `AGENT_AUTOMATION_MODEL` | `automation-generation` 使用的模型，省略时用主模型              |
| `AGENT_SPEECH_MODEL`     | `speech-interpretation` 使用的模型，省略时用主模型              |
| `AGENT_SUBAGENT_MODELS`  | JSON 字符串数组，指定子 Agent 可选的额外模型 ID；主模型始终可选 |

委派工具接受 `subagent({ task, model? })`。主助手可在每次委派时从上述可选模型中选择；省略 `model` 时子会话继承父会话模型。选择通过 pi-durable 原生 `configure(tx, child.id, { model: { provider, modelId } })` 保存到子会话，与主助手共用 Harness 和模型注册表。重复执行同一工具任务会复用原子会话和原模型选择。子 Agent 不再递归委派。

workflow 在装配时分别接收模型，直接调用 pi-ai，不创建聊天会话。额外模型须存在于该 provider 的原生模型清单中；`AGENT_MODEL_METADATA` 仅覆盖主模型，不会把主模型能力套到其他模型。当前环境配置不支持为不同模型分别设置 provider 或凭据。

参考 pi-durable 的[子 Agent 配置](https://github.com/earendil-works/pi/blob/main/packages/durable/README.md#abort-and-subagents)和[独立模型 reviewer 示例](https://github.com/earendil-works/pi/blob/main/packages/durable/test/examples/28-reviewer.ts)。

`src/config.ts` 维护 Agent 环境配置；`src/models.ts` 使用其中的模型连接字段和调用方明确提供的模型 ID 装配 provider；Backend 通过 Agent workflow 获取语音判断，不直接加载模型配置。调用方直接从 `@earendil-works/pi-ai` 导入并使用 `createModels()`、`createProvider()` 和模型请求 API。

`src/config.ts` 的 `loadConfig()` 通过 `modelEnvironment` 读取 `AGENT_PROVIDER`、`AGENT_MODEL`、`OPENAI_API_KEY`、可选 `OPENAI_BASE_URL`、`AGENT_THINKING` 和 `AGENT_MODEL_METADATA`。配置错误仅报告字段名，不输出凭据。

`main.ts` 收集各用途模型 ID，交给 `modelProviderSettings(config, ids)` 生成 pi-ai 原生的服务提供者配置；缺少模型或凭据时返回 `undefined`。`AGENT_PROVIDER` 是 pi-ai 原生 provider ID，默认 `openai`。通过 pi-ai 内置模型集合按 provider 和模型 ID 查找，保留模型的 API、输入能力、容量、成本、图像限制及思考协议参数。应用注册主模型、两个 workflow 指定的模型及子 Agent 可选模型，模型清单只在进程装配时加载，不在每次请求中查询或联网刷新。

当前支持 `openai-completions` 和 `openai-responses` 两种原生 API。OpenAI 模型使用清单中的 Responses API；MiMo 中国区套餐可配置：

```dotenv
AGENT_PROVIDER=xiaomi-token-plan-cn
AGENT_MODEL=mimo-v2.6-flash
OPENAI_API_KEY=你的项目密钥
```

未设置 `OPENAI_BASE_URL` 时使用所选模型的原生地址；覆盖地址时，调用方须确认该端点支持所选模型的协议及能力。`AGENT_THINKING` 合并进模型的原生采样参数，不改变模型是否具有思考能力。请求期限、重试和每次调用的输出预算由调用方通过 pi-ai 原生请求选项指定。

### 自定义模型与已验证的能力覆盖

模型不在所选 provider 清单中时，必须同时设置 `OPENAI_BASE_URL` 和 `AGENT_MODEL_METADATA`。后者是 JSON 对象，明确提供 `api`、`reasoning`、`input`、`contextWindow`、`maxTokens`、`cost` 和 `compat.supportsStrictMode`；不猜测图像支持、容量或严格工具支持。该对象也可覆盖清单中模型的这些字段，`compat` 按字段合并并保留未覆盖的原生协议参数。覆盖时 `api` 必须与清单一致；不同协议使用自定义 provider 和完整元数据，避免继承不适用的协议能力。

以下字段格式示例使用演示值，部署时替换为端点的已验证能力：

```dotenv
AGENT_PROVIDER=your-provider
AGENT_MODEL=your-model
OPENAI_BASE_URL=https://your-provider.example/v1
AGENT_MODEL_METADATA='{"api":"openai-completions","reasoning":false,"input":["text"],"contextWindow":32768,"maxTokens":4096,"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0},"compat":{"supportsStrictMode":true}}'
```

`cost` 的单位是每百万 token 的美元价格；未获得价格时可明确填写零，表示 Pi 本地未配置费用估算，不会作为供应商实际费用导出到 Langfuse。Langfuse 根据实际用量和其项目中的模型价格推算费用。

`compat` 还接受已验证的 `supportsDeveloperRole`、`supportsReasoningEffort`、`supportsStore`、`maxTokensField`、`requiresReasoningContentOnAssistantMessages` 和 `thinkingFormat`。其他协议差异使用 pi-ai 已支持的原生模型定义，不能仅凭“OpenAI 兼容”开启选项。自动化与语音判断要求严格工具输出；声明不支持严格工具的模型不能完成这两项能力。

模型 ID、元数据或 API 不受支持时，启动报告配置错误。配置能力不等于供应商请求已成功，`/health` 的 `modelConfigured` 只反映本地装配状态。
