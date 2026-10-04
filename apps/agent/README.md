# Agent

当前为本项目自有、独立运行的第一方模型服务，提供流式对话、会话持久化、房间上下文分析、语音请求判断和执行追踪，通过 backend 转发请求。房间分析只解释 backend 本次提交的有界设备证据；普通聊天通过四个只读工具查询家庭概览、设备清单、设备状态和成员资料；人宠位置、长期记忆和设备控制未接入。

当前房间分析的启用、结构化结果和限制见[房间 AI 上下文](../../docs/contracts/room-analysis.md)。后续家庭能力见[家庭语义目标与领域模型](../../docs/plans/household-model.md)与 [第一方 Agent 协作计划](../../docs/plans/household-automation.md)。下述 checkpoint 保存对话与执行状态，不承担后台当前房间总结或跨任务长期记忆的职责；房间分析和语音判断各使用单次结构化模型调用，不写对话检查点；它们与聊天共用模型配置。

Agent 使用官方 `@langchain/langgraph-checkpoint-postgres`，通过 `pg` 连接 PostgreSQL。默认复用根目录 `DATABASE_URL`；可用 `AGENT_DATABASE_URL` 指定独立账号或数据库。状态表位于固定的 `agent_state` schema，使用普通 PostgreSQL 表，由 checkpointer 管理，不属于 backend 的 Drizzle schema，也不转换为 TimescaleDB hypertable。

## 初始化

首次配置和日常启动统一见[项目启动说明](../../README.md#快速开始)。单独开发 Agent 使用根目录 `bun run dev:agent`，需先准备依赖和数据库。

根目录 `db:migrate` 先执行 backend 迁移，再调用 Agent 的官方 `setup()`，创建应用所有的 `agent_state.chat_threads` 会话摘要表，并为已有检查点补齐缺失摘要，可重复执行；部署和升级适配器时先运行。仅初始化 Agent 可执行 `bun run --cwd apps/agent db:setup`。服务启动不自动改表。初始化账号需要 schema/表创建权限，运行账号需相应读写权限。连接池上限 5，连接等待超时 10 秒，SQL 执行超时 30 秒。SIGINT/SIGTERM 最多等待 HTTP 请求 30 秒，再强制断开；随后 drain telemetry 中的活动执行并关闭连接池。

根目录 `dev` 包含只读 `db:check`，核对 checkpoint 迁移记录及检查点、会话摘要表读取；单独启动 Agent 不包含该检查。检查不验证写权限。升级适配器时需同步核对 `scripts/db-check.ts` 中的迁移版本要求。

## 对话

切换家庭时 backend 调用本机访问范围内的 `POST /api/household-reset`，先在同一事务内清空 `agent_state.chat_threads`、`checkpoints`、`checkpoint_blobs` 和 `checkpoint_writes`，保留迁移记录。运行账号需要这四张表的 `TRUNCATE` 权限。Agent 有进行中的聊天、房间分析或语音判断时返回 409；清理到切换完成之间暂停新任务，后台异常断开时暂停最多一分钟，尚未结束的数据库清理仍阻止新任务。该保护与聊天并发约束一样限于单 Agent 进程，同一数据库不能同时由多个 Agent 实例写入。

两个服务的数据库清理不是一个事务，后续绑定保存失败不会恢复已经删除的对话。清理范围、保留项与操作入口见[切换家庭与清理数据](../../docs/household-runtime.md#切换家庭与清理数据)。

向 backend 的 `POST /api/chat` 发送：

```json
{ "message": "你好" }
```

从 `X-Thread-Id` 响应头或 SSE `run_started` 获取生成的 UUID。续聊发送：

```json
{ "message": "继续刚才的话题", "threadId": "上次返回的 UUID" }
```

Agent 将其映射为 LangGraph 的 `configurable.thread_id`，只追加本次消息；`runId` 标识单次执行。`run_started` 包含 `persistent: true`，表示持久化执行模式，并非此次执行已完成。采用 `durability: "sync"`，只有图执行完成后才发送 `run_completed`。失败或取消时可能已经保存用户输入与中间状态，不代表自动回滚；重新发送同一消息会成为新输入，目前没有请求去重和自动重试接口。

未配置数据库返回 503；数据库连接或 checkpoint 表不可用时，在 SSE 开始前返回 503。同一会话的并发请求返回 409，不排队；锁覆盖存储预检查到图执行结束（包括失败与取消）。这是单进程内的保护，扩容多进程之前需增加跨进程协调。`/health` 的 `persistenceConfigured` 仅表示已注入持久化组件。

运行超时会取消模型执行，并向仍连接的客户端发送 `run_failed`，最多等待 1 秒发送与关闭，随后强制断开。客户端主动断开时直接取消，不再发送事件。客户端必须将未收到 `run_completed` 或 `run_failed` 的流结束视为异常，不能把 EOF 当成成功；失败后也不应自动重发消息。同会话锁在后台执行结束后释放，而非在 SSE 关闭时释放。

HTTP 错误使用共享 `{ code, message, params?, issues?, traceId? }` 结构；`run_failed` 返回 `{ runId, threadId, error }`，其中 `error` 使用同一结构，超时码为 `run_timeout`，执行失败码为 `agent_execution_failed`。详见[错误处理](../../packages/api/README.md#错误响应)。

聊天接口只接受 TCP loopback 对端，Host 和浏览器 Origin 必须为本机地址及 Agent 配置端口，不信任转发头；通过 `@home-agent/api/local-access` 与 backend 复用检查。`/health` 独立用于服务探测。

仅限可信本机使用，尚无身份认证和会话归属校验，UUID 不是权限控制。存储含完整消息内容，与 OTel 是否采集内容无关。不提供长期记忆 Store、自动历史清理、恢复任务调度或 SSE 断线续传。

依据：[LangGraph JS 持久化](https://docs.langchain.com/oss/javascript/langgraph/persistence)、[官方 PostgreSQL 适配器](https://github.com/langchain-ai/langgraphjs/tree/main/libs/checkpoint-postgres)。

Web 的 `/agent` 页面提供流式聊天与工具调用详情。聊天 SSE 在 `run_started`、`token`、`run_completed`、`run_failed` 之外，发送 `tool_started`（调用 ID、工具名及参数）和 `tool_completed`（同一调用 ID、返回内容预览及截短标记）。只展示四个家庭工具的事件；返回预览最多 16,000 字符，不改变提交给模型的完整结果。工具返回事件不表示查询业务成功，客户端仍需查看返回内容；未收到执行终止事件不能视为成功。共享事件 schema 位于 `packages/api/src/contracts/chat.ts`。

## 历史会话

`POST /api/chat/history/list` 接受可选 `before: { updatedAt, threadId }` 游标和 `limit`（默认 10，最多 20），按会话更新时间、会话 ID 倒序返回摘要。标题来自首条用户消息，当前进程的执行状态单独附加。列表只查应用所有的 `agent_state.chat_threads` 表，使用复合索引分页，不读取完整 checkpoint。聊天结束（含失败、取消）时根据已保存状态更新摘要，新会话的首个摘要在执行结束后出现。列表读取失败明确返回错误，不当作空列表。

`POST /api/chat/history/read` 接受 `threadId`，返回最近 10 轮已保存的消息与工具结果。`nextBefore` 非空时，携带返回的 `checkpointId` 和 `before: nextBefore` 继续读取更早消息，固定同一检查点，避免续聊时分页偏移。`limit` 最多 20，单次响应最多 4 MiB。工具返回预览沿用 16,000 字符上限。历史恢复不调用模型，不要求模型配置；数据库必须可用。

消息历史由 `chat/history.ts` 通过官方 `PostgresSaver` 读取，`chat/threads.ts` 只管理标题和更新时间，不复制消息。初始化时补齐缺失摘要，运行时列表与第三方检查点表结构无关。摘要更新与检查点写入不在同一事务，异常停机可能留下缺失或滞后的摘要；缺失项可通过 `db:setup` 补齐。详情读取包含整个消息检查点后再选择轮次，长会话的详情读取成本仍随已保存历史增长。读取的是已提交消息，不包含尚未提交的模型流片段或节点写入，也不重建未持久保存的 SSE 时间线、执行错误和每轮 runId。

读取期间参与家庭清理的任务准入保护，切换家庭仍清空原有检查点，因此也清空历史列表。backend 转发读取时核对请求前后家庭运行范围一致。历史接口沿用可信本机、单进程边界，不提供用户认证或会话归属权限。

当前进程仍在执行，或最新检查点没有无待处理写入的最终模型回答时，`canContinue=false`，历史仅供查看。聊天入口和执行完成事件同样检查已保存检查点；无法解析的工具调用使本轮失败，不标为完成。未完成会话返回 `thread_incomplete`，不存在的会话返回 404，不默默重建或自动恢复执行。执行中会话可稍后重新读取；中断会话可新建对话重新提问。完整会话继续使用原 `threadId`，模型使用预算内最近的完整轮次，历史展示不受此裁剪影响。

## 聊天资源预算

`AGENT_CONTEXT_BYTES` 默认 65,536，限定聊天模型输入消息序列化后的 UTF-8 字节数。采用官方 `trimMessages` 保留系统提示和最近完整轮次，不截断消息或拆开工具调用与结果。字节预算不等于精确 token 数，工具定义与模型输出需另外预留上下文空间，应按所用模型调整。当前轮次单独超过预算时，本轮失败，不静默丢弃本轮输入或查询结果。裁剪仅作用于模型请求，检查点仍保存完整历史。

`AGENT_MAX_OUTPUT_TOKENS` 默认 4096，限制聊天模型单次输出。每批最多执行 4 个只读工具，每轮最多调用 16 次，超过上限时失败；合规批次仍由官方 `ToolNode` 并行执行。循环步数和整轮超时独立生效。

检查点和会话摘要保留至切换家庭清理，不自动删除用户历史。模型输入预算不能限制历史数据库容量，部署时需按实际留存量规划存储。

## 家庭查询工具

聊天图通过 `bindTools` 向模型提供工具说明，使用 LangGraph 官方 `ToolNode` 执行工具，再回到模型生成回答；执行仍使用原有流式事件与 PostgreSQL 检查点。模型必须支持工具调用，不支持时报告执行失败，不更换模型或改为猜测回答。模型在一轮响应中返回多个工具调用时，`ToolNode` 并行执行这些调用。图的递归上限为 12 步；工具 HTTP 请求限时 10 秒，并随聊天取消。

| 工具                     | 查询内容                                                   |
| ------------------------ | ---------------------------------------------------------- |
| `get_household_overview` | 房间 ID、名称、每房间设备数、设备类别与人物／宠物数量      |
| `query_devices`          | 按名称、别名、型号、类别或房间 ID 查询设备清单             |
| `get_device_state`       | 单设备的最近属性报告、枚举说明、单位、质量、时间及采集覆盖 |
| `query_members`          | 按人物／宠物类别或名称、物种、描述查询登记资料             |

工具只调用 backend 的[家庭查询接口](../backend/README.md#家庭只读查询)，不直接连接家庭数据库，不触发采集、刷新或设备动作。设备属性来自当前家庭运行时；成员资料来自已有成员仓库。工具列表每页默认 20 项、最多 50 项，模型应根据 `next_offset` 继续查询。房间筛选省略表示全部房间，`null` 表示未分配房间；类别按概览返回的代码精确匹配，文字查询不承担语义分类或别名推断。

backend 转发聊天时注入内部字段 `household_scope`，Agent 将其作为运行配置传给工具，模型参数中没有家庭选择字段。公共 `POST /api/chat` 仍只接受 `message` 和可选 `threadId`。查询接口检查范围标识和当前访问资格，成员数据库读取结束后再次检查；旧范围请求失败，不自动改查新家庭。直接调用 Agent 的内部聊天接口也必须提供范围标识，正常客户端应使用 backend 入口。

Agent 默认通过 `http://127.0.0.1:${BACKEND_PORT}` 查询 backend，`BACKEND_PORT` 默认为 3000；可用 `AGENT_BACKEND_URL` 指定其他本机地址，例如 IPv6 loopback。地址只允许 HTTP(S) loopback，不接受内嵌凭据，查询拒绝重定向。单次返回最多 128 KiB，错误只向模型提供错误码和固定说明，不暴露上游原始异常。

`quality=valid` 表示有效设备事实；待确认、过期或缺失报告不能冒充当前状态。收到时间不等于采样时间，空结果和查询失败也不代表关闭。成员资料不包含已确认位置或活动，不能用来回答“小狗在哪里”。系统提示要求每轮针对实际家庭情况重新查询，不能用历史工具结果冒充当前事实；这一模型行为仍需真实模型验收。完整工具结果会随对话检查点保存，与是否启用追踪内容采集无关。

## 语音请求判断

本机 `POST /api/speech-dialogue` 接收 backend 的短时转写证据，由单次结构化模型调用判断是否向助手提出请求、语义是否完整及其依据。它与房间分析共用现有模型配置和家庭切换互斥入口，最多一个在途请求，处理受证据原期限和 11 秒服务期限约束。请求／响应共享契约位于 `packages/api/src/contracts/speech-dialogue.ts`。

模型输入仅包含助手称呼、当前与前文的转写、停顿／截断边界和相对当前片段开始的时间间隔，前文按采样顺序排列。完整观测的来源身份、期限和处理元数据由请求校验及结果对应处理使用。

该接口只返回结构化判断，不回复用户、不执行设备工具、不将摄像头位置或画面身份当作说话人。backend 拥有逐段交付、来源撤销、去重和调用频率，见[语音片段交付与对话判断](../../docs/perception.md#语音片段交付与对话判断)。只有 backend 显式开启 `dialogue.enabled` 才自动调用；默认不因检测到人声而调用语言模型。

## 验证边界

服务健康检查、连接成功与静态检查只覆盖各自范围，不能证明真实模型多轮对话、重启后的历史恢复、同会话并发拒绝、超时、客户端取消或执行中停机已经通过端到端验证。当前使用边界为可信本机、单 Agent 进程；持久化与取消语义仍需在实际模型和数据库环境下验证。
