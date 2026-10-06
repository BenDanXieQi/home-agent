# API 契约与错误处理

`@home-agent/api` 统一约定 Web、backend 与 Agent 交换数据时的字段、类型和错误格式（数据契约），并提供服务端请求校验及错误处理工具。

## 模块边界

Web 通过 `@home-agent/api/contracts`、`@home-agent/api/mijia` 和 `@home-agent/api/household` 等入口使用 `src/contracts/`。契约层包含定义数据格式并执行校验的 Zod schema、由它推导的类型，以及不涉及网络或数据库的协议数据转换，不依赖 Hono、追踪或服务端错误处理。backend 与 Agent 按需导入 `@home-agent/api/errors` 和 `@home-agent/api/errors/hono`，服务端错误处理层向契约层依赖。

`@home-agent/api/devices` 提供设备清单条目与规格能力的领域 schema；米家协议和家庭规则复用这份定义，供应商原始数据的转换属于接入适配器。

`@home-agent/api/spatial` 提供空间、通道和观测绑定的保存输入、启停命令、公开记录、绑定标识、整体读取及删除结果，见[空间资料契约](#空间资料契约)。端点不同和目标二选一由共享校验表达，设备／镜头合法性由后端核对当前设备清单。

`@home-agent/api/playback` 提供 `src/domain/playback.ts` 中的播放目标、go2rtc 连接观测以及一次性连接耗时摘要，不依赖 HTTP 或存储。播放连接响应将 SDP 与 `connection` 一同返回；客户端据此选择本地预估样本。媒体适配器独立校验外部观测，观测异常不破坏有效的媒体答案。

网络接收入口负责完整校验输入。家庭 SSE（服务端持续推送事件的 HTTP 连接）入口使用 `stateChangeSchema.parse` 一次性校验整批变化及每条数据的标识，再把已校验批次交给 `applyChanges`；后者生成新的状态，不修改原状态，并复用未变化的数据对象。快照通过 `snapshotSchema` 校验结构并复用相同的条目标识规则，不对已校验条目重复运行 schema 校验。

完整规格由后端按 URN 共享，不进入 Web 家庭公共状态；Agent 专用通路在 `household` 部分另行交付完整规格。Web 设备记录仅包含 `spec_id/spec_status/spec_error`、分类和能力标签；初始准备值由 `initialSpecification` 提供。候选家庭只由设置专用接口返回，当前协议不包含 `latest/source_health/rule_status` 空占位字段。

`src/contracts/perception.ts` 定义本地检测的健康、音轨、可选猫狗声音分类和语音转写快照，通过 `@home-agent/api/contracts` 导出。`@home-agent/api/speech-dialogue` 定义短时语音收件箱及 backend 内部语音判断输入和结果；采样区间、时间关系及判断字段的一致性由共享 schema 约束，接收边界完整校验，内部使用已校验数据。用法与期限见[语音交付](../../docs/perception.md#语音片段交付与对话判断)。这些契约不提供媒体读取或设备执行；聊天接口仍只承载文本对话。Backend 向 Agent 交付已有数据的专用协议见[Agent 数据交付契约](#agent-数据交付契约)。后续证据与判断边界见[摄像头计划](../../docs/plans/media-perception.md)，不把计划中的接口当作已有协议使用。

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

空间删除的引用冲突使用[独立业务结果](#空间资料契约)，通用异常仍使用上述错误格式。调用方按响应结构区分同为 HTTP `409` 的业务结果和错误。

## 空间资料契约

[spatial.ts](src/contracts/spatial.ts) 是空间输入、公开记录及校验的唯一字段定义；接口路径与领域含义见 [Backend 空间关系资料](../../apps/backend/README.md#空间关系资料)。整体读取返回 `scope`、`spaces`、`passages`、`observation_bindings`，消费者按稳定 ID 关联目标与通道端点，设备名称及实时状态从设备清单读取。

所有写入携带读取返回的 `scope`，即账号、家庭及绑定更新时间；尚未绑定时为 `null`。保存区分 `operation: create | update`，调用方生成 UUID：新建要求 ID 不存在，编辑要求存在且提供读取时的 `expected_updated_at`，新建不接受版本字段。删除接受 `scope`、`id`、`expected_updated_at`，启停额外接受 `enabled`。后端在同一事务中检查绑定标识和记录版本。

删除成功返回 HTTP `200 / { status: "deleted", id }`；有引用时返回 HTTP `409 / { status: "referenced", id, references: { passages, observation_bindings } }`，至少一个引用数组非空，数组元素复用公开记录 schema。空间删除只返回直接引用，通道删除的 `passages` 为空。删除对象不存在返回 `404 / not_found`。

其他错误沿用通用格式：`spatial_record_exists`、`spatial_record_changed`、`spatial_scope_changed` 返回 `409`，分别表示 ID 已存在、记录版本变化、家庭绑定变化；`spatial_reference_invalid`、`spatial_source_invalid` 返回 `400`；`spatial_storage_unavailable` 返回 `503`。客户端不自动重试写入，响应丢失时应先读取并确认实际结果。

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

## 对话与连接检查

`chatInputSchema` 只接受 `message`，`chatResponseSchema` 返回 `answer`。backend 校验 Agent 的 JSON 响应，不转发任意上游 HTML 或原始错误。取消向上游传播，超时和执行失败使用统一 HTTP 错误契约。

连接状态接口完成探测时返回 200，即使外围服务不可用。每个服务返回 `reasonCode` 与可选 `params`；页面生成可读说明。读取连接配置失败返回普通 HTTP 错误。

## 测试

`tests/contracts/household.test.ts` 对应 `src/contracts/household.ts`，验证共享增量合并的顺序、不修改输入和引用复用，以及快照、变化批次中的实体标识校验。测试数据位于本包的 `tests/support/household.ts`，不依赖 Web 或 backend 的测试辅助代码。

```sh
bun run --cwd packages/api test -- tests/contracts/household.test.ts
```

消费方只测试自己如何使用契约和处理校验失败，不重复枚举这些共享规则。

## 设备历史契约

`@home-agent/api/device-history` 从设备能力、属性地址和值 schema 派生固定说明、接纳报告、查询、两种页响应与 Web 历史 SSE。记录按 `kind=property|online` 区分，在线 `value` 为布尔值，不附带 MIoT 地址或属性说明；在线来源 `directory` 表示设备清单读取。共享 `deviceHistoryPolicy` 定义 365 天保留、页大小、请求／响应容量，`deviceHistoryStreamPolicy` 定义历史流的连接、事件与等待预算。`@home-agent/api/agent-context` 的 `kind=device_reports` 分支复用设备历史契约，其他分支见[Agent 数据交付契约](#agent-数据交付契约)。

时间区间校验 UTC、至多微秒精度及 `start < end`；属性编号 `siid/piid` 复用共享地址 schema，只接受 `1..2147483647` 的整数。查询统一返回已保存变化记录，不含表达方式参数或同值段字段；历史写入跳过连续同值，不保留每次重复报告。查询支持 device_ids、kinds 和 properties；kinds 默认两类，properties 仅匹配原生属性，筛选条件取交集。`order` 默认 `asc`，Web 使用 `desc` 按最新优先读取。Backend 对筛选去重并固定排序，校验游标、查询方向及当前家庭资格；调用方不解释游标内部内容。

Web 的 `POST /api/device-history/events` 在读取条件上增加 `delivery=live|page|export`。live 要求降序且不带游标，首批为 `page`，后续 `change` 携带变化记录、完整有序 `record_ids` 与 `removed_ids`；记录 ID 使用 observation_id。`page` 固定区间返回一页后发送 `complete`；`export` 按固定区间在单个 SQL 查询快照内生成最多 64 MiB 的临时页文件，事务结束后连续交付有界数据批次（next_cursor 为 null），期限沿用 Backend 读取配置，完成后发送 `complete`，两者随后关闭。空心跳使用 `heartbeat`，流内失败使用公共 `error` 契约。Agent 历史入口继续使用一次性 JSON 响应。来源、分页、保留与容量语义见[设备状态历史](../../docs/household-runtime.md#设备状态历史)，支持基线与验证边界见[数据库维护与验证限制](../../docs/household-runtime.md#数据库维护与验证限制)。

家庭历史 HTTP 边界使用公共 `household_scope_changed`、`household_unavailable`、`household_capacity_exceeded` 与 `household_storage_unavailable` 错误码，复用统一错误响应结构和展示映射；家庭领域异常不引入供应商协议。

## Agent 数据交付契约

[`src/contracts/agent-context.ts`](src/contracts/agent-context.ts) 从已有家庭、成员、感知与窗口 schema 派生专用推送和历史分支，统一通过 `@home-agent/api/agent-context` 导入。`agentContextPolicy` 定义整理缓存、各部分、待发送内容、单次传输及历史响应的预算；来源语义与验证限制由[家庭运行时](../../docs/household-runtime.md#agent-当前数据与材料历史)维护。

`GET /api/agent/context/stream` 使用 `snapshot` 与 `heartbeat` 事件。snapshot 固定为 `{ scope, parts }`，scope 为 null 或 `{ account_id, home_id, scope_epoch }`；运行标识只用于接收适配器核对资格。初始快照提供全部五部分，后续只提供变化部分；省略表示保留，提供表示整体替换，ready 的空集合清空旧集合。heartbeat 数据为空对象，不改变业务部分或同步状态。

| 部分               | data 来源                                                        |
| ------------------ | ---------------------------------------------------------------- |
| `household`        | 家庭、房间、设备及完整规格                                       |
| `device_state`     | 最新属性报告、设备在线值、采集与来源状态                         |
| `members`          | 人物／宠物登记资料                                               |
| `member_sightings` | 最近出现记录及其实体关联                                         |
| `perception`       | 当前综合观察及完整窗口详情，包含视觉、音频、转写、身份和媒体状态 |

每部分包含 `status/read_at/data/reason/truncated`。status 为 `loading/ready/unavailable/failed`，只有 ready 携带 data；read_at 为最近读取尝试完成的 UTC 时间，尚未完成时为 null，ready 必须有完成时间。unavailable 和 failed 给出安全原因，其他状态 reason 为 null；非 ready 的 truncated 为 false。truncated 只说明该部分快照按条数或字节预算省略了完整记录，不证明历史完整。最近出现按 `lastObservedAt/id` 降序，窗口按 `endedAt/id` 降序；设备清单、成员资料与设备当前值超限时整部分失败，单个窗口超限也失败。

历史 `POST /api/agent/context/history` 的输入和响应均按 kind 定义判别联合，各分支只接受自己的字段。公共输入为预期绑定 `account_id/home_id`、UTC 半开区间 `start/end`、`limit/cursor`，默认每页 100 条、上限 1,000 条。`member_sightings` 可选 `member_ids` 和 `sources`，`perception_windows` 可选 `sources`；sources 为 `{ device_id, channel? }` 数组，镜头值复用已有窗口 schema，省略 channel 匹配该设备全部镜头。筛选数组省略表示不筛选，显式空数组拒绝；对象去重并固定排序。

成员响应的 records 由 `memberSightingRecordSchema` 定义，保留记录 ID、原时间、原 data/evidence、当前归因及 context_entities 关联。区间条件为 `firstObservedAt < end && lastObservedAt >= start`，按 `firstObservedAt/id` 升序分页。member_ids 匹配当前已知归因，sources 匹配记录来源，两类筛选取交集。retention 明确数据库存储、当前修订、观察跨度不证明持续在场、分页不保持快照。

音视频响应的每条记录包含完整 `window` 与 `matches`。后者分别引用命中的视觉窗口 ID、音轨 run/代次和转写片段 ID；视觉、非空音频及每条转写的原观察区间任一满足相同重叠规则即返回整体窗口。按 `startedAt/id` 升序分页，媒体仅返回现有状态与引用。retention 明确内存存储、最长约 30 分钟、可能提前淘汰、重启丢失及区间完整性不保证；已不存在或已撤销的窗口不返回。

新增响应保留 `kind/account_id/home_id/start/end/records/next_cursor`。游标绑定 kind、家庭身份、绑定记录 updated_at、规范化对象条件和区间；音视频还绑定感知 instanceId，Backend 重启后拒绝旧音视频游标。同一绑定的成员历史可跨进程续页，每页仍重新核验当前资格。分页按完整记录及字节预算交付，游标指向最后实际返回记录，首条单独超预算返回容量错误，无下一页时 next_cursor 为 null。归因修订、晚到内容和淘汰可改变后续页，分页结果不作为完整消费记录。成功无匹配记录返回空数组，来源不可用或读取失败返回错误。

该契约交付已有来源材料，不包含凭据、参考照片、特征向量或媒体字节，不定义模型调查、默认模型输入、生活事件推断或语义回写。
