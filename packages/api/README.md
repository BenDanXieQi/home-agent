# API 契约与错误处理

`@home-agent/api` 统一约定 Web、backend 与 Agent 交换数据时的字段、类型和错误格式（数据契约），并提供服务端请求校验及错误处理工具。

## 模块边界

Web 通过 `@home-agent/api/contracts`、`@home-agent/api/mijia` 和 `@home-agent/api/household` 等入口使用 `src/contracts/`。契约层包含定义数据格式并执行校验的 Zod schema、由它推导的类型，以及不涉及网络或数据库的协议数据转换，不依赖 Hono、追踪或服务端错误处理。backend 与 Agent 按需导入 `@home-agent/api/errors` 和 `@home-agent/api/errors/hono`，服务端错误处理层向契约层依赖。

`@home-agent/api/devices` 提供设备清单条目与规格能力的领域 schema；米家协议和家庭规则复用这份定义，供应商原始数据的转换属于接入适配器。

`@home-agent/api/playback` 提供 `src/domain/playback.ts` 中的播放目标、go2rtc 连接观测以及一次性连接耗时摘要，不依赖 HTTP 或存储。播放连接响应将 SDP 与 `connection` 一同返回；客户端据此选择本地预估样本。媒体适配器独立校验外部观测，观测异常不破坏有效的媒体答案。

网络接收入口负责完整校验输入。家庭 SSE（服务端持续推送事件的 HTTP 连接）入口使用 `stateChangeSchema.parse` 一次性校验整批变化及每条数据的标识，再把已校验批次交给 `applyChanges`；后者生成新的状态，不修改原状态，并复用未变化的数据对象。快照通过 `snapshotSchema` 校验结构并复用相同的条目标识规则，不对已校验条目重复运行 schema 校验。

完整规格由后端按 URN 共享，不进入公共状态。设备记录仅包含 `spec_id/spec_status/spec_error`、分类和能力标签；初始准备值由 `initialSpecification` 提供。候选家庭只由设置专用接口返回，当前协议不包含 `latest/source_health/rule_status` 空占位字段。

`src/contracts/perception.ts` 定义本地检测的健康、音轨和语音转写快照，通过 `@home-agent/api/contracts` 导出。`@home-agent/api/speech-dialogue` 定义短时语音收件箱及 backend／Agent 的判断请求和响应；采样区间、时间关系及判断字段的一致性由共享 schema 约束，接收边界完整校验，内部使用已校验数据。用法与期限见[语音交付](../../docs/perception.md#语音片段交付与对话判断)。这些契约不提供媒体读取或设备执行；聊天接口仍只承载文本对话。持续观察、长期任务、事件及动作提交的拟实施 API 见[第一方协作计划](../../docs/plans/household-automation.md#6-具体接口与工具)。后续证据与判断边界见[摄像头计划](../../docs/plans/media-perception.md)，不把计划中的接口当作已有协议使用。

`@home-agent/api/immutable` 集中配置 Mutative，更新时只复制变化部分、复用未变化对象，称为“结构共享”：

- `produce` 同步构造待校验数据，不冻结调用方持有的对象。
- `freeze` 原地冻结模块已持有的数据，即禁止修改结果及其内部对象；不生成经过 schema 校验的副本。
- `parseImmutable` 先经公共 schema 解析，得到与输入分离的数据，再冻结并登记，供后续缓存校验与编码结果。
- `isImmutable` 检查这份登记。只冻结最外层的对象，其内部数据仍可能变化，不能作为安全缓存输入。

这些函数用于公共数据；Promise、取消控制器、网络连接和任务仍由负责相应资源的模块管理。

`@home-agent/api/local-access` 复用 TCP 对端及 Host／Origin 的本机访问校验；`@home-agent/api/http/read-body` 限制响应读取大小，并负责释放读取器。JSON 解码和供应商错误转换由各自的协议适配器负责，读取错误保留传输与取消原因。

## 错误响应

backend 与 Agent 共用一套错误契约，Web 按错误码显示中文。HTTP 使用实际的 4xx／5xx 状态；响应结构为：

```json
{
  "code": "connection_config_input_invalid",
  "message": "Provide a complete, valid connection configuration.",
  "issues": [{ "path": "services.agent.url", "code": "invalid_service_url" }]
}
```

`code` 是稳定的小写下划线标识；`message` 是安全的默认说明，仅供阅读，客户端不解析其内容。可选 `params` 提供大小限制等字符串或数值，`issues` 提供字段路径、原因码与可选参数。启用追踪时可附带 `traceId`。原始异常、输入值、堆栈及凭据不进入响应。

## 实现约定

- `src/contracts/errors.ts`：前后端共享的错误码、字段错误及 SSE 失败事件 schema，不包含服务端处理逻辑。
- `src/contracts/mijia-errors.ts`：米家公开错误码、HTTP 状态与安全文案。backend 在 `mijia/errors.ts` 将 MiCloud 和 go2rtc 的错误转换到该契约，保留 `cloud_invalid_response` 与下游 `invalid_response` 的来源区别。
- `src/errors/definitions.ts`：服务端错误码到 HTTP 状态和安全默认文案的映射，类型检查确保覆盖全部错误码。
- `src/errors/index.ts`：与 Hono 无关的 `AppError` 和错误载荷构造。业务模块提供错误码、必要参数、字段错误及内部 `cause`，可通过 `operation` 标识失败操作；`cause` 和 `operation` 不进入 API 响应。
- `src/errors/hono.ts`：共享 `onError`、错误响应和 JSON 请求解析。404、请求体超限等直接响应也使用同一格式；未知异常返回通用 500。
- `src/errors/diagnostics.ts`：提取内部诊断信息，包括受限的错误标识、系统错误码、操作名、系统调用名和项目源码位置。最多记录四层原因链、每层五个源码位置，省略原始消息、绝对路径、函数名和完整堆栈。
- `src/errors/validation.ts`：将 Zod 校验结果转换为公开的字段错误结构。
- [`apps/web/src/messages/zh-CN.ts`](../../apps/web/src/messages/zh-CN.ts)：集中管理中文错误、字段校验、网络错误和连接状态文案。新增错误必须补齐文案，类型检查会检查遗漏；当前仅提供中文。

字段校验通过 `validationIssues()` 通用映射 Zod 错误，不包含业务路径判断。连接配置模块仅将服务地址的格式错误转换为 `invalid_service_url`，保留缺失或类型错误的 `invalid_type`、超长的 `too_big` 等原因。字段错误不直接输出库的默认文案。JSON 语法错误、Content-Type 错误、字段校验失败分别返回 `invalid_json`、`content_type_required`、`invalid_request` 或对应领域错误码。

Hono `HTTPException` 由统一入口转换为安全 JSON；保留 HTTP 状态及认证、重试等协议头。启动参数错误和进程初始化失败由启动入口处理，不伪装为 HTTP 响应。

## 流式对话与连接检查

SSE 开始后，通过 `run_failed` 发送 `{ runId, threadId, error }`；其中 `error` 与 HTTP 错误结构相同。执行超时使用 `run_timeout`，执行失败使用 `agent_execution_failed`，不尝试在流中改写 HTTP 状态。客户端断开时只取消执行；未收到终止事件的 EOF 不能视为成功。

聊天代理面向本项目 Agent，原样透传上游状态和响应体。统一错误契约由 backend 与本项目 Agent 共同保证；若连接地址指向其他服务，其 HTML 或其他格式的错误响应也会原样返回，代理不负责转换任意上游协议。

连接状态接口正常完成探测时返回 200，即使外围服务不可用。每个服务返回 `reasonCode` 与可选 `params`，例如 `timeout` 携带 `timeoutMs`、`http_error` 携带上游 `status`。页面负责生成可读说明。读取连接配置失败则返回普通 HTTP 错误。

参考：[Hono 异常处理](https://hono.dev/docs/api/exception)、[流式响应机制](https://hono.dev/docs/helpers/streaming)。

## 测试

`tests/contracts/household.test.ts` 对应 `src/contracts/household.ts`，验证共享增量合并的顺序、不修改输入和引用复用，以及快照、变化批次中的实体标识校验。测试数据位于本包的 `tests/support/household.ts`，不依赖 Web 或 backend 的测试辅助代码。

```sh
bun run --cwd packages/api test -- tests/contracts/household.test.ts
```

消费方只测试自己如何使用契约和处理校验失败，不重复枚举这些共享规则。
