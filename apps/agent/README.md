# Agent

当前为本项目自有、独立运行的第一方模型服务，提供流式对话、会话持久化、房间上下文分析和执行追踪，通过 backend 转发请求。房间分析只解释 backend 本次提交的有界设备证据；普通聊天尚无家庭查询或设备工具，长期记忆和设备控制未接入。

当前房间分析的启用、结构化结果和限制见[房间 AI 上下文](../../docs/contracts/room-analysis.md)。后续家庭能力见[家庭语义目标与领域模型](../../docs/plans/household-model.md)与 [第一方 Agent 协作计划](../../docs/plans/household-automation.md)。下述 checkpoint 保存对话与执行状态，不承担后台当前房间总结或跨任务长期记忆的职责；单次房间分析不写对话检查点。

Agent 使用官方 `@langchain/langgraph-checkpoint-postgres`，通过 `pg` 连接 PostgreSQL。默认复用根目录 `DATABASE_URL`；可用 `AGENT_DATABASE_URL` 指定独立账号或数据库。状态表位于固定的 `agent_state` schema，使用普通 PostgreSQL 表，由 checkpointer 管理，不属于 backend 的 Drizzle schema，也不转换为 TimescaleDB hypertable。

## 初始化

首次配置和日常启动统一见[项目启动说明](../../README.md#快速开始)。单独开发 Agent 使用根目录 `bun run dev:agent`，需先准备依赖和数据库。

根目录 `db:migrate` 先执行 backend 迁移，再调用 Agent 的官方 `setup()`，可重复执行；部署和升级适配器时先运行。仅初始化 Agent 可执行 `bun run --cwd apps/agent db:setup`。服务启动不自动改表。初始化账号需要 schema/表创建权限，运行账号需相应读写权限。连接池上限 5，连接等待超时 10 秒，SQL 执行超时 30 秒。SIGINT/SIGTERM 最多等待 HTTP 请求 30 秒，再强制断开；随后 drain telemetry 中的活动执行并关闭连接池。

根目录 `dev` 包含只读 `db:check`，核对 checkpoint 迁移记录及表读取；单独启动 Agent 不包含该检查。检查不验证写权限。升级适配器时需同步核对 `scripts/db-check.ts` 中的迁移版本要求。

## 对话

切换家庭时 backend 调用本机访问范围内的 `POST /api/household-reset`，先清空 `agent_state.checkpoints`、`checkpoint_blobs` 和 `checkpoint_writes`，保留迁移记录。运行账号需要这三张表的 `TRUNCATE` 权限。Agent 有进行中的聊天或房间分析时返回 409；清理到切换完成之间暂停新任务，后台异常断开时暂停最多一分钟，尚未结束的数据库清理仍阻止新任务。该保护与聊天并发约束一样限于单 Agent 进程，同一数据库不能同时由多个 Agent 实例写入。

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

仅限可信本机使用，尚无身份认证和会话归属校验，UUID 不是权限控制。存储含完整消息内容，与 OTel 是否采集内容无关。不提供长期记忆 Store、自动历史清理、会话列表、恢复任务调度或 SSE 断线续传。

依据：[LangGraph JS 持久化](https://docs.langchain.com/oss/javascript/langgraph/persistence)、[官方 PostgreSQL 适配器](https://github.com/langchain-ai/langgraphjs/tree/main/libs/checkpoint-postgres)。

## 语音请求判断

本机 `POST /api/speech-dialogue` 接收 backend 的短时转写证据，由独立、无 checkpoint 的语音图判断是否向助手提出请求、语义是否完整及其依据。它与房间分析共用现有模型配置和家庭切换互斥入口，最多一个在途请求，处理受证据原期限和 11 秒服务期限约束。请求／响应共享契约位于 `packages/api/src/contracts/speech-dialogue.ts`。

该接口只返回结构化判断，不回复用户、不执行设备工具、不将摄像头位置或画面身份当作说话人。backend 拥有逐段交付、来源撤销、去重和调用频率，见[语音片段交付与对话判断](../../docs/perception.md#语音片段交付与对话判断)。只有 backend 显式开启 `dialogue.enabled` 才自动调用；默认不因检测到人声而调用语言模型。

## 验证边界

服务健康检查、连接成功与静态检查只覆盖各自范围，不能证明真实模型多轮对话、重启后的历史恢复、同会话并发拒绝、超时、客户端取消或执行中停机已经通过端到端验证。当前使用边界为可信本机、单 Agent 进程；持久化与取消语义仍需在实际模型和数据库环境下验证。
