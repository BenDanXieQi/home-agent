# Agent

基于 pi-durable 的家庭助手。部署与启动方式见 [Agent Host](../agent-host/README.md)。

## 运行

根目录 `.env` 配置 `AGENT_MODEL=provider/modelId` 和对应提供商的凭据。模型必须支持工具调用，详见[模型配置](#模型配置)。

```sh
bun install
bunx turbo run dev --filter=@home-agent/agent-host
```

Agent 直接导出源码；`bunx turbo run build --filter=@home-agent/agent` 复用类型检查任务。宿主构建与 Backend RPC 声明生成共用同一个 Agent 检查任务，不重复生成和检查。

`AGENT_HOST` 默认 `127.0.0.1`，`AGENT_PORT` 默认 `1811`。`BACKEND_URL` 使用 HTTP(S) 地址，默认 `http://127.0.0.1:3000`；Backend 使用自定义监听地址时显式配置。无需数据库或 Agent Server。根目录开发命令仍会启动本项目其他服务。后台上下文接收不要求模型配置。本包的类型检查不需要 Backend RPC 声明；宿主的构建和开发通过 Turbo 先生成 Backend RPC 客户端声明。

## 接口

`POST /api/workflows` 是 Backend 调用专项任务的统一内部入口，复用当前进程、本机访问校验和错误格式。自动化生成使用 `workflow="automation-generation"`，请求为 `{ workflow, input: { text, definition?, capabilities } }`；`definition` 为可选的现有规则，`capabilities` 为调用方准备的设备能力。响应为 `{ workflow, result: { definition, behavior, clarifications } }`。存在歧义或生成内容未通过校验时，`definition` 为 null，调用方展示说明或澄清问题，不能当作已生成的有效规则。

进程复用 `@home-agent/observability` 初始化 OpenTelemetry（OTel）。聊天与 workflow 执行入口、GenAI 记录标记为 Agent 执行，Langfuse 按标记独立筛选；健康检查、接收记录读取与上下文同步保留在通用 OTel，执行中的 Backend 数据读取通过 W3C baggage 传播执行标记并延续已有追踪。HTTP 入口接续 Backend 的 W3C 追踪上下文；业务 `.run` span（一次任务的追踪记录）记录提交、等待与结果校验，Durable 运行、模型和工具显式接到对应父级。模型、Agent 运行与工具按 OTel GenAI 语义约定分别记录 `chat`、`invoke_agent`、`execute_tool`；这套约定当前处于 Development（尚未稳定）阶段。供应商实际 token 用量、费用与首 token 时间只记录在模型观测，缺失用量时不估算。Durable 已提交状态由工作区 [`@home-agent/pi-langfuse`](../../packages/pi-langfuse/README.md) 观察器采集，模型记录不重复导出。长期会话只归入 Session，不持有导出的长期根 span。默认不采集正文；`OTEL_INCLUDE_CONTENT=true` 时逻辑评测根才记录任务、结果及 `metadata.evaluation_context` 中的实际模型消息与工具轨迹。评测器须显式映射这些材料，本服务不自动生成评分或管理评测器。配置、内容边界及 Langfuse 尚未实机验证的接收与界面行为见[共享追踪说明](../../packages/observability/README.md)。

`GET /health` 返回进程存活状态（`status: "ok"`）和服务标识（`service: "home-agent"`、`runtime: "bun"`），不检查模型配置或供应商连通性。

聊天输入输出由 `@home-agent/agent/assistant/contracts` 导出，Backend 和 Web 直接复用所属协议。

`POST /api/chat` 接受 `{ "message": "你好" }`，完成后返回 `{ "answer": "…" }`。Web 通过 backend 的同名接口访问。输入只接受非空的 `message`，响应为非空回答。使用普通 JSON，不提供 SSE、thread ID 或历史接口。

所有聊天请求复用当前进程内同一个主会话和工作目录。忙碌时由 pi-durable 默认 follow-up 收件箱排队，前端仍只展示本次回答。刷新页面不清空服务端会话；重启后清空。当前主会话没有按账号、家庭或浏览器隔离。

独立接收模块自动订阅 Backend 当前家庭、空间关系、设备状态、成员和统一观察。历史读取模块提供只读查询方法，供调用方显式装配；当前进程入口未创建该模块。家庭助手的模型尚未接入这些材料或家庭业务工具，不能安排提醒或控制设备；没有改变现有聊天输入及模型行为。数据来源、保留与验证限制见[家庭运行时](../../docs/household-runtime.md#agent-当前数据与材料历史)。

Bun 保留默认连接空闲超时，仅在请求体完成校验后对本次模型请求关闭空闲计时，由执行期限控制等待。模型明确返回长度截断、内容过滤、未完成或失败状态时，不作为完整回答返回；结果未知时不自动重发。

HTTP 复用本机访问限制和统一错误契约。仅限可信本机使用，不提供账号认证。模型缺配置返回 503，超时返回 504，执行失败返回安全错误，不返回供应商原始异常。

## 运行器与工具

长期会话只拥有 Session（多轮追踪分组）关联，不导出覆盖空闲期的会话根 span。一次聊天通常形成 HTTP → `household-assistant.run` → `invoke_agent household-assistant` → 模型／工具的显式父子链；前台委派的子运行接续父工具的上下文。多个来源一起启动运行时创建新的 trace 并添加 OTel links（跨追踪来源关联）；运行开始后并入的输入保留初始父级并补充 links，提交 ID 保留在元数据中，不承诺 Langfuse 界面展示 links。`household-assistant.run` 以 `langfuse.internal.is_app_root=true` 标记本次任务的逻辑评测根，内容开关开启时记录任务、最终回答及实际模型输入和工具轨迹；完整字段与评测材料映射见[共享追踪说明](../../packages/observability/README.md#追踪链路)。

上下文自动压缩沿用框架默认策略。共享追踪模块通过公开任务定义接口观察原生摘要执行：阻塞当前生成的压缩归入对应运行，后台压缩单独创建有限 trace 并保留 Session，模型用量仍只记录在模型观测。pi-durable 1.2.0 通过 Bun 依赖补丁应用官方 [5713c950](https://github.com/earendil-works/pi/commit/5713c9507c9dceab289de3defe41f24611a7d757)：压缩和增量重建上下文时保留 SystemEntry（系统指令记录），不将其重复追加为普通历史。补丁位于根目录 `patches/`，由 `bun install` 应用。原始内存记录仍随历史增长，没有磁盘会话存储或重启恢复，长期资源占用与摘要质量尚未验证。现有家庭接收器独立运行，尚未接入模型事件唤醒或定期检查。

`AGENT_RUN_TIMEOUT_MS` 默认 120,000，分别限制单次模型请求、每次工具执行和 HTTP 等待，不限制主会话寿命或整个多回合任务。工具执行通过 Chord Context 的 AbortSignal 接收期限；官方 `bash` 即使省略命令 timeout 也受该期限约束，模型提供更短的命令 timeout 时仍生效。前台委派超时会令工具失败，由框架取消其拥有的子会话工作。注入的领域工具必须响应取消信号；忽略信号的工具不能被强制中止。单次模型输出由 `AGENT_MAX_OUTPUT_TOKENS` 限制，默认 4096；模型请求不自动重试，应用不累计限制主会话的请求次数。

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

## 专项能力

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

取得 `result.session_id` 后，携带这个 ID 和同一 `input.scope` 提交 `message`、`read` 或 `close`。浏览器调用 Backend 的 `POST /api/workflows` 时，请求使用顶层 `scope_epoch`，不传 `input.scope`；Backend 校验后补齐内部请求的 `scope`。创建会话可提供已有 `draft`；创建和读取不调用模型。字段、图片编码及草稿约束见[空间规划会话契约](#空间规划会话契约)。

每个规划拥有独立的 Harness、MemoryStorage 和原生 Conversation（会话），同一 ID 下的后续消息保留已有对话及当前草稿，不使用聊天主会话。Backend 将当前账号、家庭和运行代次作为可信 scope 传入；Agent 核对会话所属范围，并在接收器观察到家庭范围撤销或变化时关闭旧范围会话。普通 SSE 重连不撤销同一范围下的规划。每轮结果包含回答、待澄清问题、完整空间和通道草稿以及修订号；需要补充信息时也返回已有草稿。图片支持 JPEG、PNG、WebP 的原始 base64 字节；使用 `AGENT_SPATIAL_MODEL`，省略时沿用 `AGENT_MODEL`；带图片的消息要求该模型支持 image 输入，不支持时返回 `invalid_request`。不接收视频。

`ProviderDoc.sessionId` 是 Pi 为每个 Conversation 保存的稳定提供方会话标识，用于模型提供方的缓存和会话关联。当前项目将它复用为规划接口的公开 `session_id`，并作为业务、模型和 Durable 观察器记录的 `session.id`，供 Langfuse 按 Session（多轮追踪分组）关联；这是项目的关联策略，Pi 提供方会话与 Langfuse Session 并非同一个概念。创建后附着会话事件观察器，会话本身不导出长期根 span。每轮消息形成 HTTP → `spatial-planning.run` → `invoke_agent spatial-planning` → `chat {模型 ID}`／`execute_tool update_spatial_draft` 的父子链；提交来源与 Generation／Tool hook 显式恢复上下文，后续轮次继续归入同一 Session。

每轮业务根记录草稿修订号、空间／通道数量及问题数量，观察器保留 `pi.durable.*` 会话、提交、任务和工具调用标识。`OTEL_INCLUDE_CONTENT=true` 时，逻辑评测根的输入包含完整本轮请求及图片，输出包含回答、澄清问题和完整草稿；`metadata.evaluation_context` 汇集实际模型输入消息与工具调用的参数、结果及状态。图片原始 base64 随 span 导出，不单独上传媒体。已提交结果的观察器投影另过滤凭据与不透明签名，不修改模型输入。会话关闭时释放观察器，运行时刷新共享追踪处理组件，由应用关闭 NodeSDK；未核对终态的运行按观察中断记录为 `WARNING`。Langfuse 真实入库及界面展示尚未实机验证，字段与边界见[共享追踪说明](../../packages/observability/README.md)。

单轮等待使用配置的执行期限；同一规划正在运行时，新消息返回 `workflow_busy`，不同会话可以独立执行。超时或取消会中止该规划会话当前运行，已提交的草稿可通过 `read` 核对；后续仍可继续提交消息。`close` 先撤销这个会话 ID 的消息接纳，再中止当前运行、取得最终草稿并关闭该会话独有的 Harness、观察器及提供方资源，释放内存存储引用。页面取消和 SPA 离页会关闭已取得 ID 的会话；创建期间离页会等到 ID 返回再关闭。整页强关或网络故障导致创建回执完全丢失时，可能保留会话到家庭撤销或服务关闭。

与主助手一样使用 `MemoryStorage`，只在本次进程运行期间保留会话；重启后 ID、对话和草稿清空，不提供重启恢复。Spaces 页面通过 Backend 的家庭 workflow 入口使用图片与持续问答，页面展示最新草稿；尚未接入空间保存或摄像头采集，也未验证真实户型图片的识别质量。

### 语音请求判断

Backend 负责转写片段的来源资格、45 秒有效期、限流和判断状态，经现有 Agent 客户端调用此 workflow；Agent 重新校验请求时效和前文关系。执行期限取配置的预算与材料到期时间；Backend 仍以最多 12 秒及片段原期限控制等待。缺模型、Agent 不可用或判断失败由 Backend 显示为 unavailable；本地转写仍可运行。此判断不执行聊天或设备动作。

Agent 与 Backend 共用 Hono 的访问校验、输入校验和错误处理；宿主的 Backend 适配器使用 Hono RPC，服务调用通过 `tracedFetch` 传播追踪上下文。校验成功后仅对本次模型请求关闭连接空闲计时，模型执行期限仍由聊天或 workflow 管理。

## 当前数据接收与只读历史客户端

接收观察协议由 `context/contracts.ts` 定义，通过 `@home-agent/agent/context/contracts` 导出，Backend 和 Web 从该边界导入或推导类型。快照合并与设备资料解析同属 Agent；Web 通过 `@home-agent/agent/context/devices` 复用设备资料解析。

回执摘要在接纳消息时校验并冻结，索引读取复用同一份摘要；详情与摘要共享变化记录，连接或家庭资格结束时一起释放。记录正文保留校验后的 snapshot 消息与当时合并结果。`payload_bytes` 是 SSE 数据正文字节数，`context_bytes` 是完整 `{ scope, parts }` 紧凑 JSON 的 UTF-8 字节数，不代表进程内存占用；`context_delta_bytes` 是相对上一条记录的上下文字节差，初始消息以零为基准。当前连接与家庭资格存续期间完整保留记录，断线、家庭范围变化、停止或重启会清空；心跳不生成接收记录。

索引和详情的 `changes` 保存全部结构化变化，以 `kind/key/before/after` 区分变化类型、对象标识和前后值。设备名称与属性规格取自当时设备清单，删除项从接收前的清单解析。`member_sighting` 单独比较成员最后出现、身份归属及最新记录替换；摘要忽略采集累计接收计数与观察来源读取时间更新，完整消息仍保留这些字段。窗口摘要比较内容修订、输入与媒体保留／生成状态、语音段数、猫狗声分析状态及有效检测数量，不读取外部材料或推断房间、设备身份。猫狗声分析缺失、未就绪或无效时 `pet_sound_count` 为 null；有效结果中的零只表示该次结果未命中。`sampledMedia=null` 表示无媒体引用，不等同于 `not_generated`。

`GET /api/received-context` 复用 Agent 本机访问限制，返回 `{ scope, connection, parts, received_at, context_bytes }`。connection 包含连接 status、synchronized 与 last_error；全部部分收到初始状态后才标记已同步，部分为 loading、failed 或 unavailable 时仍保留各自状态。last_error 为 null 或 `{ reason, at }`，保留最近失败的安全分类和 UTC 时间，直到收到合法事件后清空。分类区分请求失败、HTTP 状态、无效事件流、超时、JSON／契约错误、流读取失败和正常结束；订阅失败日志最多每 30 秒记录一次，不包含接收正文或原始异常。后续省略部分保留旧值；设备状态增量只更新或删除指定条目，其他提供部分整体替换；ready 的空集合清空对应集合，heartbeat 不改变同步。首次连接、重连及家庭资格变化先清空接收数据；断线标记未同步。该入口用于诊断，不保存持久日志，也不代表模型输入。received_at 只记录数据消息，心跳单独计时。断线、停止及意外失败时清空当前数据。

`GET /api/context-receipts` 返回接收索引、连接、家庭资格、最近数据与心跳时间。首次不带查询参数时读取当前连接的全部摘要；后续同时提供 `journal_id` 和 `after_sequence`，只读取同一接收会话中序号更大的摘要。会话不匹配或请求序号超过当前序号时返回全部摘要。`GET /api/context-receipts/:id` 返回单条接收消息与该次合并后的完整上下文；`GET /api/context-receipts/current` 返回带接收会话标识的当前快照。所有入口复用本机访问限制。Web 通过 Backend 只读代理观察，页面用法见[Agent 接收数据观察](../web/README.md#agent-接收数据观察)。

同一读取模块的 `readHistory` 方法读取三类历史。receiver 提供当前接收资格；调用者传入 `kind=device_reports|member_sightings|perception_windows`、UTC 区间、相应对象条件、分页参数及取消信号。设备分支沿用原读取条件；成员使用可选 member_ids/sources，音视频使用可选 sources，返回完整窗口与匹配引用。用法与字段见[共享契约](../../packages/api/README.md#agent-数据交付契约)。

网络请求使用宿主注入的 RPC 适配器和 `@home-agent/api/http/request-json`，组合调用方取消与请求截止时间，有界读取并校验响应，不自动重试。Backend 返回的公共错误码及字段说明保留，传输或非法响应报告不可用；超时与取消分别报告。上下文读取模块在返回前重新核对连接代次、绑定身份、家庭运行资格及请求区间；失败、超时或资格改变拒绝结果，不用当前值或旧缓存代替历史。接收数据仅存在于内存，重启重新读取，不保存 SSE 消费进度。读取工厂供调用方显式装配，当前聊天未使用它，也未注册模型工具；启动模块不导出业务调用实例。实机与专项边界统一见[Agent 通路验证边界](../../docs/household-runtime.md#agent-通路验证边界)。

## 家庭模型视图

`context/model-view/` 拥有模型输入的能力筛选、视图转换、编码与解码，通过 `@home-agent/agent/context/model-view` 及其 `/format`、`/decoding` 子路径导出。Web 压缩上下文页复用 Agent 实现。输入使用已校验的接收快照，模块在内存中同步转换，不读取网络或文件；当前聊天入口尚未调用它。

```ts
import {
  createHouseholdModelView,
  encodeHouseholdContext,
} from "@home-agent/agent/context/model-view";

const view = createHouseholdModelView(snapshot);
const contextJson = JSON.stringify(encodeHouseholdContext(view.semantic));
```

接收器继续拥有当前快照、版本、连接状态和家庭范围；调用方负责选择快照及判断连接新鲜度。接收时间不等于属性测量时间，转换不会把旧状态升级成实时状态。输入缺少家庭范围、`household/spatial/device_state/members/observations` 中任一未 ready 或尚未收到 `operations` 时抛出错误；已收到的 `operations` 保留非 ready 状态。转换不隐式复用上一次结果。当前没有模型上下文自动注入逻辑。

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

```sh
bun --env-file=.env apps/agent/scripts/context-understanding.ts --context /path/model-context --cases /path/cases.json --output /path/new-results
```

题目文件包含 `input_sha256`（取自 CLI manifest）和 `questions` 数组，每题具有唯一 `id`、说明返回 JSON 结构的 `question` 和人工核对的 `expected`。标准答案应依据固定快照的设备、规格与事实核实，不能直接采用被测模型的回答。标准答案只用于本地判分，不发送给模型；按题比较 JSON 值、类型和结构，数组顺序也参与判分。题目及结果含家庭资料时只保存在本地数据位置。

输出目录必须不存在。结果保存模型原文、逐题得分、请求用量、输入指纹和调用条件，需逐条检查失败是否来自模型理解、题目歧义或标准答案错误。网络与服务错误中断运行，不能算作模型理解失败。小样本结果只覆盖所选问题，不代表完整 Agent 的工具调用、长期理解准确率或实时场景判断。依据失败题修改格式后的同题重跑属于修复验证，不是独立泛化评估；泛化判断需要另外冻结未参与修改的新题和快照。缓存验证另看完整请求返回的缓存 token，不能以公共前缀长度或短请求耗时替代。

## 模型配置

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

Provider 的模型资料及认证由 pi-ai 原生实现维护，当前只注册其内置清单中的 Provider。未注册 Provider 或清单外模型会令启动失败。服务不联网刷新原生模型清单，不提供 OAuth 登录或持久凭据存储入口。请求期限、重试和输出预算沿用调用方的原生请求选项。自动化与语音判断要求严格工具输出；带图片的空间规划还要求 image 输入能力。跨厂商真实请求和长期委派尚未实机验收。

费用为零的模型不作为供应商实际费用导出到 Langfuse；Langfuse 可按项目模型价格与实际用量推算费用。

### 空间规划会话契约

`@home-agent/agent/workflows/spatial-planning` 导出 `spatialPlanningInputSchema`、`spatialPlanningResultSchema`、`spatialPlanningTurnSchema`、`spatialPlanningStateSchema`；字段定义位于 [contracts.ts](src/workflows/spatial-planning/contracts.ts)。Agent 内部请求为 `{ workflow: "spatial-planning", input }`，响应为 `{ workflow: "spatial-planning", result }`。Backend 面向家庭的 `POST /api/workflows` 同时接受空间规划，浏览器请求携带当前 `scope_epoch`；Backend 校验家庭资格后转发，返回前再次核对运行范围。

| `input.action` | 输入                                | 行为                                                      |
| -------------- | ----------------------------------- | --------------------------------------------------------- |
| `start`        | 可选 `draft`                        | 创建独立会话，立即返回初始草稿和 `session_id`，不调用模型 |
| `message`      | `session_id`、`text`、可选 `images` | 结合已有会话和本轮材料回答、澄清并调整草稿                |
| `read`         | `session_id`                        | 读取当前已提交草稿及运行状态                              |
| `close`        | `session_id`                        | 中止当前运行，返回最后草稿及 closed 状态，撤销 ID 访问    |

`text` 可以为空，但文字和图片不能同时为空。`images` 中每张为 `{ type: "image", mime_type: "image/jpeg" | "image/png" | "image/webp", data }`。`data` 是原始 base64 字符串，不含 data URL 前缀。不接受视频、媒体 URL 或本机文件路径；模型必须声明支持图片输入。

`result` 包含 `session_id`、`status: idle | running | closed`、`revision`、`reply`、`questions` 和 `draft`。`revision` 从 0 开始，每次草稿工具成功提交后递增；普通问答只更新 `reply`，保留草稿、待澄清问题和修订号。`running` 的读取可能仍是上轮草稿。`questions` 表示继续问答所需的信息，草稿不因存在问题而清空；首轮只有问题、修订号仍为零时也可以继续提交文字。`idle` 仅表示当前没有运行，不表示规划已完成或获用户确认。

`draft` 使用本 workflow 定义的 `spatialDraftSchema`，字段从共享空间领域的 [spatial.ts](../../packages/api/src/contracts/spatial.ts) 推导：`spaces` 中每项为 `id/name/description`；`passages` 额外包含 `space_a_id/space_b_id`。各类 ID 不重复，通道端点必须引用草稿内两个不同的空间；没有数据库时间戳、观测绑定或保存授权。它用于继续问答和人工核对，不是空间数据库快照，也不直接调用空间写入接口。模型工具输入与正式草稿分开：新对象用 `id: null`，已有对象只接受当前草稿中的 ID；空间用本次提交内的临时 `ref`，通道用 `space_a_ref/space_b_ref` 关联。Agent 服务端生成 UUID、转换引用并校验后提交，返回的 `draft` 始终只含正式 ID，后续修改保留这些 ID。

会话 ID 来自 PiDurable 原生 `ProviderDoc.sessionId`（UUID），同时用于 Langfuse 多轮追踪分组，只在当前 Agent 进程内可用于继续规划。Backend 将当前 `account_id/home_id/scope_epoch` 作为可信 `scope` 注入 `spatialPlanningRequestSchema`；每项操作核对会话所属范围。未知或关闭后的 ID 返回 `not_found`；关闭撤销访问、中止当前运行并释放该会话独有的 Harness、存储及提供方资源。家庭范围撤销或变化时关闭旧范围会话。请求取消、超时和模型缺配置复用公共错误；等待使用服务配置的预算。
