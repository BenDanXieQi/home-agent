# Agent

基于 Deep Agents 的最简家庭助手服务，入口为 `src/assistant.ts` 的 `createDeepAgent`。Hono 定义内部 HTTP 路由，由 `Bun.serve()` 承载；backend 转发请求，Web `/agent` 提供单次问答。

## 运行

根目录 `.env` 配置 `AGENT_MODEL`、`OPENAI_API_KEY`，按需配置 `OPENAI_BASE_URL`。模型必须支持工具调用。支持 `thinking.type` 的供应商可设置 `AGENT_THINKING`。共享模型工厂位于 `packages/model`，backend 的语音判断也读取这些配置。

```sh
bun install
bun run --cwd apps/agent dev
```

`AGENT_HOST` 默认 `127.0.0.1`，`AGENT_PORT` 默认 `1811`。`BACKEND_URL` 使用 HTTP(S) 地址，默认 `http://127.0.0.1:3000`；Backend 使用自定义监听地址时显式配置。无需数据库、迁移或 Agent Server。根目录开发命令仍会启动本项目其他服务。后台上下文接收不要求模型配置。独立运行类型检查或 lint 前先执行 `bunx turbo run build --filter=@home-agent/backend-client`，生成服务端及客户端声明；Turbo 的 Agent 构建、检查和开发命令已声明该依赖，开发时同时维护两份声明。生成职责见[共享 Backend 客户端](../../packages/backend-client/README.md)。

## 接口

`POST /api/workflows` 是 Backend 调用专项任务的统一内部入口，复用当前进程、本机访问校验和错误格式。当前支持 `workflow="automation-generation"`，请求为 `{ workflow, input: { text, definition?, capabilities } }`；`definition` 为可选的现有规则，`capabilities` 为调用方准备的设备能力。响应为 `{ workflow, result: { definition, behavior, clarifications } }`。存在歧义或生成内容未通过校验时，`definition` 为 null，调用方展示说明或澄清问题，不能当作已生成的有效规则。

生成能力位于 `src/workflows/automation-generation/`，复用共享模型工厂，使用一次结构化模型调用；规则结构、设备引用、读写权限、枚举及动作参数按 `@home-agent/api/automations` 校验。输入中的能力用于约束草稿，不构成设备操作授权；保存或执行前仍需 Backend 核验当前家庭及设备能力。它不保存或启用规则、不操作设备、不使用聊天历史或 Agent 数据库。

入口请求上限 256 KiB，响应上限 128 KiB，同时执行一项 workflow，繁忙返回 `workflow_busy`；运行期限取 `AGENT_RUN_TIMEOUT_MS` 与 90 秒的较小值，取消和超时传递到模型调用，结束后释放执行名额。未配置模型返回 `model_not_configured`。公共分发位于 `src/workflows/index.ts`，接收 Hono 入口已校验的输入，负责并发名额、执行期限和结果边界；专项模块不另建 HTTP 或客户端层。Backend 已通过公共 `/api/workflows` 入口调用本服务，从当前家庭规格准备能力，返回前重新校验家庭资格与设备能力。自动化页面已通过 Backend 公共入口调用生成；生成器和共享校验拒绝交付含 AI 条件或动作选择的可用草稿，这两项能力尚未启用。真实模型生成效果尚未验证。

进程复用 `@home-agent/observability` 初始化 OpenTelemetry。HTTP 入口通过共用的 Hono 追踪中间件接续 Backend 的 W3C 追踪上下文，生成调用记录 `automation.generate` span、耗时、草稿校验结果及供应商返回的输入／输出 token 用量。默认不采集正文；`OTEL_INCLUDE_CONTENT=true` 时才记录输入资料和生成结果，导出方式沿用[共享追踪配置](../../packages/observability/README.md)。供应商没有返回用量时不估算 token 数。聊天入口具有 HTTP span；Deep Agents 内部步骤没有新增 span。关闭时停止请求并关闭 exporter。

`GET /health` 返回服务状态和 `modelConfigured`；配置存在不表示供应商调用成功。

`POST /api/chat` 接受 `{ "message": "你好" }`，完成后返回 `{ "answer": "…" }`。Web 通过 backend 的同名接口访问。输入只接受 `message`，最多 16,000 字符、请求体最多 32 KiB；响应文字最多 65,536 字符。使用普通 JSON，不提供 SSE、thread ID 或历史接口。

每次请求独立调用 Deep Agents，不传 checkpointer 或持久 Store。显式使用 `new StateBackend()`，虚拟文件工具只操作本次运行的内存状态，没有配置宿主文件系统或 shell。框架内置工具及通用委派由 Deep Agents 提供，没有注册家庭业务工具、专用子 agent、技能或跨请求记忆。

独立接收模块自动订阅 Backend 当前家庭、空间关系、设备状态、成员和统一观察，并通过只读客户端查询实际保留的历史。家庭助手的模型尚未接入这些材料或家庭业务工具，不能安排提醒或控制设备；没有改变现有聊天输入及模型行为。数据来源、保留与验证限制见[家庭运行时](../../docs/household-runtime.md#agent-当前数据与材料历史)。

`AGENT_RUN_TIMEOUT_MS` 默认 120,000；模型不自动重试，单次模型输出由 `AGENT_MAX_OUTPUT_TOKENS` 限制，默认 4096，图步数上限 30。请求取消或超时向执行传播取消信号。Bun 保留默认连接空闲超时，仅在请求体完成校验后对本次模型请求关闭空闲计时，由执行期限控制等待。模型明确返回长度截断、内容过滤、未完成或失败状态时，不作为完整回答返回；结果未知时不自动重发。

HTTP 复用本机访问限制和统一错误契约。仅限可信本机使用，不提供账号认证。模型缺配置返回 503，超时返回 504，执行失败返回安全错误，不返回供应商原始异常。

## 代码职责

- `assistant.ts`：模型与 Deep Agents 配置。
- `config.ts`：服务配置。
- `main.ts`：配置、共享 Backend RPC 客户端与应用装配，以及服务器、接收器和追踪的启动／关闭。
- `app.ts`：无启动副作用的 Hono 应用工厂，复用本机访问、JSON 校验、请求大小限制、错误处理及 HTTP 追踪中间件。
- `chat.ts`：单次模型执行、取消与期限、完整回答校验。
- `context/receiver.ts`：Backend 专用 SSE 接收、五部分内存状态、连接和家庭资格。
- `context/receipts.ts`：受接收器管理的有限内存接收记录与当时上下文；`context/receipt-changes.ts` 在接收时比较前后状态并提取诊断变化摘要。
- `context/reader.ts`：历史与引用材料读取；使用共享 Backend RPC 客户端，负责当前接收资格及响应与请求的匹配校验。
- `context/model-view/`：Agent 家庭视图筛选、语义查询键、JSON 编码与解码；`cli.ts` 提供保存快照的离线转换和查询。
- `workflows/spatial-planning/index.ts`：空间规划专项 Agent 工厂，使用同一模型配置，由调用方注入共用的 backend 能力。
- `workflows/spatial-planning/instructions.ts`：空间证据使用、记录匹配、配置写入与结果核对指令。

## 专项能力

专项能力按业务放在 `src/workflows/<业务名>/`。空间规划导出 `createSpatialPlanning(config, tools)`，模型未配置时返回 `undefined`；配置存在时返回 Deep Agents 实例，直接使用框架的 `invoke()` 或流式接口。家庭资料、已有空间关系和本次要求由调用方通过消息提供，户型图可选，图片使用模型支持的原生图像消息块。执行方负责传入取消／超时信号和图步数限制。

空间规划只配置模型、专项指令和注入的能力，不实现 backend 查询或 HTTP 客户端。其虚拟文件仅存在于单次运行状态，实际空间资料由注入的 backend 能力读写。写入后的核对目前由专项指令要求模型执行，不是独立的程序校验保证。

当前已提供空间规划模块入口，尚未接入服务请求、前端启动及可选上传、家庭数据通路或 backend 读写能力；现有 `/api/chat` 仍只调用家庭助手。因此还不能从页面启动规划或自动保存空间配置。视觉分析要求所配置模型支持图像输入。

语音请求判断由 backend 的 `conversation/interpret.ts` 负责，不调用此服务。数据库中已有的 `agent_state` 数据不被本服务读取、迁移或删除；若不再需要，可由数据库维护者另行清理。

Agent 与 Backend 共用 Hono 的访问校验、输入校验和错误处理；共享 RPC 客户端使用 `hono/client`，服务调用通过 `tracedFetch` 传播追踪上下文。Agent 在读取请求体前保存 Bun 原始 Request；校验成功后仅对本次模型请求关闭连接空闲计时，模型执行期限仍由聊天或 workflow 管理。

## 当前数据接收与只读历史客户端

回执摘要在接纳消息时校验并冻结，索引读取复用同一份摘要；详情与摘要共享变化记录，淘汰或清空时一起释放。

`src/context/receiver.ts` 导出 `createContextReceiver({ client })`，使用 `@home-agent/backend-client` 创建的 RPC 客户端。`start()` 自动订阅，`stop()` 取消连接与重连等待；`snapshot()` 提供收到的内存数据，`currentScope()` 仅在当前连接已收到全部五部分初始状态时返回可用家庭身份。SSE 解码使用共享 `@home-agent/api/http/event-stream`，复用成熟的 eventsource-parser。

`GET /api/received-context` 复用 Agent 本机访问限制，返回 `{ scope, connection, parts, received_at, context_bytes }`。connection 包含连接 status、synchronized 与 last_error；全部部分收到初始状态后才标记已同步，部分为 loading、failed 或 unavailable 时仍保留各自状态。last_error 为 null 或 `{ reason, at }`，保留最近失败的安全分类和 UTC 时间，直到收到合法事件后清空。分类区分请求失败、HTTP 状态、无效事件流、超时、JSON／契约错误、流读取失败和正常结束；订阅失败日志最多每 30 秒记录一次，不包含接收正文或原始异常。后续省略部分保留旧值；设备状态增量只更新或删除指定条目，其他提供部分整体替换；ready 的空集合清空对应集合，heartbeat 不改变同步。首次连接、重连及家庭资格变化先清空接收数据；断线标记未同步。该入口用于诊断，不保存持久日志，也不代表模型输入。received_at 只记录数据消息，心跳单独计时。断线、停止及意外失败时清空当前数据。

`GET /api/context-receipts` 返回接收索引、连接、家庭资格、最近数据与心跳时间。首次不带查询参数时读取全部保留摘要；后续同时提供 `journal_id` 和 `after_sequence`，只读取同一接收会话中序号更大的摘要。会话不匹配或请求序号超过当前序号时返回全部保留摘要。响应的 `first_retained_sequence` 标记最早保留序号，无记录时为 `total_received + 1`，客户端据此移除已淘汰记录。`GET /api/context-receipts/:id` 返回单条接收消息与该次合并后的完整上下文；`GET /api/context-receipts/current` 返回带接收会话标识的当前快照。所有入口复用本机访问限制。Web 通过 Backend 只读代理观察，页面用法见[Agent 接收数据观察](../web/README.md#agent-接收数据观察)。

`context/receipts.ts` 由接收器独占，消息在通过校验并合并后记录。设备增量正文只保留本次条目变化，context 保存增量合并后的完整状态；合并使用共享 Mutative 封装，不修改旧接收记录。记录保留接收序号、UTC 时间、初始接收／状态更新、涉及部分、原始正文 `payload_bytes`、合并上下文 `context_bytes` 字节数、校验后的消息和当时上下文；不是原始 SSE 字节归档。`context_bytes` 为完整 `{ scope, parts }` 紧凑 JSON 的 UTF-8 字节数，接收记录固定为当时大小，当前快照接口按本次读取状态计算；不含连接诊断字段，不代表进程内存占用。接收记录按不可变对象引用缓存字节数，设备增量复用未变化条目的统计；统计过程不重复序列化完整上下文或完整接收记录。最多 1000 条，同时按每条完整序列化体积计入 64 MiB 预算（共享对象仍重复计数），超限淘汰最早记录并累计数量。连接或家庭资格改变时清空记录并更换会话标识，重启丢失，不重放或保存消费进度。心跳不生成接收记录。读取已淘汰记录返回 404。响应上限覆盖整个接收记录保留预算及响应信封，计入变化摘要，保证保留的单条详情和完整索引均可读取。

统一观察保存观察索引、`member_sighting_ids/window_id` 引用、成员出现归因修订号及轻量窗口材料摘要，不保存成员记录正文或完整音视频窗口详情。`createContextReader({ client, receiver })` 提供 `readMaterial` 方法，接受 `{ kind: "member_sighting" | "perception_window", id }` 和取消信号，自动携带当前 scope 调用 Backend 的 `/api/agent/context/material`。读取前后核对接收资格、响应类型与引用 ID；源材料过期、移除或资格变化时失败，不用旧缓存替代，不写回上下文。返回的是来源当前保留版本，不是当时接收内容。

同一读取模块的 `readHistory` 方法读取三类历史。receiver 提供当前接收资格；调用者传入 `kind=device_reports|member_sightings|perception_windows`、UTC 区间、相应对象条件、分页参数及取消信号。设备分支沿用原读取条件；成员使用可选 member_ids/sources，音视频使用可选 sources，返回完整窗口与匹配引用。用法与字段见[共享契约](../../packages/api/README.md#agent-数据交付契约)。

网络请求使用共享 RPC 和 `@home-agent/api/http/request-json`，组合调用方取消与请求截止时间，有界读取并校验响应，不自动重试。Backend 返回的公共错误码及字段说明保留，传输或非法响应报告不可用；超时与取消分别报告。上下文读取模块在返回前重新核对连接代次、绑定身份、家庭运行资格及请求区间；失败、超时或资格改变拒绝结果，不用当前值或旧缓存代替历史。接收数据仅存在于内存，重启重新读取，不保存 SSE 消费进度。读取工厂供调用方显式装配，当前聊天未使用它，也未注册模型工具；启动模块不导出业务调用实例。实机与专项边界统一见[Agent 通路验证边界](../../docs/household-runtime.md#agent-通路验证边界)。

## 家庭模型视图

`context/model-view/view.ts` 的 `createHouseholdModelView(context)` 接受已校验的接收快照，生成设备清单、能力与有值状态，并提供受相同规则约束的 `spec/state` 查询。输入必须有家庭范围和五部分 ready 数据；缺少规格的设备仍在设备清单中，不编造能力。该模块属于 Agent 的输入组织，Backend 和接收器继续保存完整来源事实。当前聊天入口尚未调用此模块。

模块直接接收数据，不依赖接收器、模型框架或 CLI。`createHouseholdModelView` 与 `encodeHouseholdContext` 在内存中同步执行，没有订阅、定时器、网络／文件读写或跨调用缓存；CLI 单独负责文件读写。进程内用法如下（`snapshot` 为已校验的接收快照）：

```ts
import { createHouseholdModelView } from "./context/model-view/view";
import { encodeHouseholdContext } from "./context/model-view/encoding";

const view = createHouseholdModelView(snapshot);
const contextJson = JSON.stringify(encodeHouseholdContext(view.semantic));
```

`view.query(deviceId, keys, "spec" | "state")` 始终查询创建该视图时的同一份快照，返回的 `source` 为 `snapshot`。转换时隔离所使用的来源数据，调用方之后修改输入不会改变该视图的查询结果；查询结果也不会修改来源数据。读取更新后的状态需要向转换函数传入新快照，已有视图不会自动更新。能力规格仅在单次转换内复用。

接收器继续拥有当前快照、版本、连接状态和家庭范围；调用方负责选择快照及判断连接新鲜度。接收时间不等于属性测量时间，转换不会把旧状态升级成实时状态。输入缺少家庭范围或任一部分未 ready 时抛出错误，不隐式复用上一次结果。当前没有模型上下文自动注入逻辑。

摄像头只展示切换常看位置、巡航开关／模式／位置；人在传感器只展示可明确辨认的整体有人／无人属性，无法确认整体项时不选某个分区替代。人体移动传感器保留移动事件，不由此推断持续有人。自检、开发者模式、码库匹配、协议载荷和内部标识等细节由 `policy.ts` 排除。摄像头分析及事件归 Backend。缺值和未知规格不生成状态占位；缓存、待验证、过期等原始质量及时间保持不变。

能力不因当前缺值而消失，也没有每设备数量或 token 上限。语义键在设备内消歧，完整规格查询包含当前视图允许的属性、动作和事件；没有独立访问权限的事件参数不会伪装成可查询属性。`capabilities.ts` 处理 MIoT 名称、权限、单位和来源型号过滤；型号排除数据的固定官方来源见相邻 `miot-exclusions.json`。这不依赖 Home Assistant 运行时，不执行供应商代码，也不表示复现了所有 HA 平台组件行为。

`encoding.ts` 将相同能力与规格集合合并，按权限、类型分组，用固定位置数组和本文件内数字索引表达。`schema` 说明字段位置和权限位；原始设备 ID 和语义键可以直接查询，索引不作为设备身份。解码会校验格式说明、权限与类型、索引、设备归属、重复语义键、重复状态、关注项及连续编号，保留合法的 `false`、`0` 和 `null`。

从仓库根目录运行，输入是 `GET /api/context-receipts/current` 保存的完整 `{ journal_id, context }` JSON：

```sh
bun run --cwd apps/agent context:format --input /path/current.json overview --output /path/model-context
bun run --cwd apps/agent context:format --input /path/current.json devices
bun run --cwd apps/agent context:format --input /path/current.json spec <device-id> [semantic-key...]
bun run --cwd apps/agent context:format --input /path/current.json state <device-id> [semantic-key...]
bun run --cwd apps/agent context:format --input /path/model-context/context.json decode
```

输出 `context.json` 是紧凑模型输入，`context.pretty.json` 和 `context.formatted.json` 是同内容缩进版，`context.decoded.json` 是还原的语义视图。`capability-audit.json` 给出每项能力的排除原因，`manifest.json` 统计设备、能力、报告、Unicode 码点和 UTF-8 字节数；token 数需用目标模型分词器另算，不能用字符数固定换算。CLI 在写入前核对编码和解码内容一致，并拒绝输出或关注记录覆盖输入文件；输出文件之间以及输出与关注文件之间也不能指向同一文件。

`spec/state` 的显式键查询可附带 `--attention <file> --remember`，成功后记录关注键；`overview` 读取同一 `--attention` 文件时只突出仍有效的关注项，不删减其他能力。全量查询不记录关注。查询仅读取保存快照，不刷新设备、不执行动作，不重新带入领域规则排除的内容。原始快照和输出应放在本地数据位置，不提交设备及成员资料。
