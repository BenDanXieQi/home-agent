# Agent

基于 Deep Agents 的最简家庭助手服务，入口为 `src/assistant.ts` 的 `createDeepAgent`。原生 `Bun.serve()` 承载内部 HTTP，不使用 Hono，backend 转发请求，Web `/agent` 提供单次问答。

## 运行

根目录 `.env` 配置 `AGENT_MODEL`、`OPENAI_API_KEY`，按需配置 `OPENAI_BASE_URL`。模型必须支持工具调用。支持 `thinking.type` 的供应商可设置 `AGENT_THINKING`。共享模型工厂位于 `packages/model`，backend 的语音判断也读取这些配置。

```sh
bun install
bun run --cwd apps/agent dev
```

`AGENT_HOST` 默认 `127.0.0.1`，`AGENT_PORT` 默认 `1811`。`BACKEND_URL` 使用 HTTP(S) 地址，默认 `http://127.0.0.1:3000`；Backend 使用自定义监听地址时显式配置。无需数据库、迁移或 Agent Server。根目录开发命令仍会启动本项目其他服务。后台上下文接收不要求模型配置。

## 接口

`GET /health` 返回服务状态和 `modelConfigured`；配置存在不表示供应商调用成功。

`POST /api/chat` 接受 `{ "message": "你好" }`，完成后返回 `{ "answer": "…" }`。Web 通过 backend 的同名接口访问。输入只接受 `message`，最多 16,000 字符、请求体最多 32 KiB；响应文字最多 65,536 字符。使用普通 JSON，不提供 SSE、thread ID 或历史接口。

每次请求独立调用 Deep Agents，不传 checkpointer 或持久 Store。显式使用 `new StateBackend()`，虚拟文件工具只操作本次运行的内存状态，没有配置宿主文件系统或 shell。框架内置工具及通用委派由 Deep Agents 提供，没有注册家庭业务工具、专用子 agent、技能或跨请求记忆。

独立接收模块自动订阅 Backend 当前家庭、设备状态、成员、出现记录和感知数据，并通过只读客户端查询实际保留的历史。家庭助手的模型尚未接入这些材料或家庭业务工具，不能安排提醒或控制设备；没有改变现有聊天输入及模型行为。数据来源、保留与验证限制见[家庭运行时](../../docs/household-runtime.md#agent-当前数据与材料历史)。

`AGENT_RUN_TIMEOUT_MS` 默认 120,000；模型不自动重试，单次模型输出由 `AGENT_MAX_OUTPUT_TOKENS` 限制，默认 4096，图步数上限 30。请求取消或超时向执行传播取消信号。Bun 保留默认连接空闲超时，仅在请求体完成校验后对本次模型请求关闭空闲计时，由执行期限控制等待。模型明确返回长度截断、内容过滤、未完成或失败状态时，不作为完整回答返回；结果未知时不自动重发。

HTTP 复用本机访问限制和统一错误契约。仅限可信本机使用，不提供账号认证。模型缺配置返回 503，超时返回 504，执行失败返回安全错误，不返回供应商原始异常。

## 代码职责

- `assistant.ts`：模型与 Deep Agents 配置。
- `config.ts`：服务配置。
- `main.ts`：独立进程、HTTP 入口、请求校验、模型执行，以及接收器启动／停止与历史客户端装配。
- `context/receiver.ts`：Backend 专用 SSE 接收、五部分内存状态、连接和家庭资格。
- `context/history-client.ts`：Backend 三类历史的只读客户端，校验响应与接收资格。
- `workflows/spatial-planning/index.ts`：空间规划专项 Agent 工厂，使用同一模型配置，由调用方注入共用的 backend 能力。
- `workflows/spatial-planning/instructions.ts`：空间证据使用、记录匹配、配置写入与结果核对指令。

## 专项能力

专项能力按业务放在 `src/workflows/<业务名>/`。空间规划导出 `createSpatialPlanning(config, tools)`，模型未配置时返回 `undefined`；配置存在时返回 Deep Agents 实例，直接使用框架的 `invoke()` 或流式接口。家庭资料、已有空间关系和本次要求由调用方通过消息提供，户型图可选，图片使用模型支持的原生图像消息块。执行方负责传入取消／超时信号和图步数限制。

空间规划只配置模型、专项指令和注入的能力，不实现 backend 查询或 HTTP 客户端。其虚拟文件仅存在于单次运行状态，实际空间资料由注入的 backend 能力读写。写入后的核对目前由专项指令要求模型执行，不是独立的程序校验保证。

当前已提供空间规划模块入口，尚未接入服务请求、前端启动及可选上传、家庭数据通路或 backend 读写能力；现有 `/api/chat` 仍只调用家庭助手。因此还不能从页面启动规划或自动保存空间配置。视觉分析要求所配置模型支持图像输入。

语音请求判断由 backend 的 `conversation/interpret.ts` 负责，不调用此服务。数据库中已有的 `agent_state` 数据不被本服务读取、迁移或删除；若不再需要，可由数据库维护者另行清理。

Agent 不安装 Hono 或项目追踪中间件；backend 保留请求入口和代理调用追踪。

## 当前数据接收与只读历史客户端

`src/context/receiver.ts` 导出 `createContextReceiver({ backendUrl })`。`start()` 自动订阅，`stop()` 取消连接与重连等待；`snapshot()` 提供收到的内存数据，`currentScope()` 仅在当前连接已收到全部五部分初始状态时返回可用家庭身份。SSE 解码使用共享 `@home-agent/api/http/event-stream`，复用成熟的 eventsource-parser。

`GET /api/received-context` 复用 Agent 本机访问限制，返回 `{ scope, connection, parts, received_at }`。connection 包含连接 status、synchronized 与 last_error；全部部分收到初始状态后才标记已同步，部分为 loading、failed 或 unavailable 时仍保留各自状态。last_error 为 null 或 `{ reason, at }`，保留最近失败的安全分类和 UTC 时间，直到收到合法事件后清空。分类区分请求失败、HTTP 状态、无效事件流、超时、JSON／契约错误、流读取失败和正常结束；订阅失败日志最多每 30 秒记录一次，不包含接收正文或原始异常。后续省略部分保留旧值，提供部分整体替换；ready 的空集合清空对应集合，heartbeat 不改变同步。首次连接、重连及家庭资格变化先清空接收数据；断线标记未同步。该入口用于诊断，不新增页面、持久日志或模型输入。

`src/context/history-client.ts` 导出 `createHistoryClient({ backendUrl, receiver })`，启动入口将客户端装配为 `readHistory`。receiver 提供当前接收资格；调用者传入 `kind=device_reports|member_sightings|perception_windows`、UTC 区间、相应对象条件、分页参数及取消信号。设备分支沿用原读取条件；成员使用可选 member_ids/sources，音视频使用可选 sources，返回完整窗口与匹配引用。用法与字段见[共享契约](../../packages/api/README.md#agent-数据交付契约)。

客户端组合调用方取消与共享请求截止时间，通过共用的有界 HTTP 工具读取并校验响应。返回前重新核对连接代次、绑定身份、家庭运行资格及请求区间；失败、超时或资格改变拒绝结果，不用当前值或旧缓存代替历史。接收数据仅存在于内存，重启重新读取，不保存 SSE 消费进度。客户端未注册为模型工具。实机与专项边界统一见[Agent 通路验证边界](../../docs/household-runtime.md#agent-通路验证边界)。
