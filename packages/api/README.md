# API 契约与错误处理

`@home-agent/api` 统一约定 Web、backend 与 Agent 交换数据时的字段、类型和错误格式（数据契约），并提供服务端请求校验及错误处理工具。

## 模块边界

`@home-agent/api/agent-workflows` 定义 Agent 公共任务入口的输入、结果及容量限制，当前支持 `automation-generation`。`householdWorkflowInputSchema` 用于 Backend 入口，包含家庭运行标识及用户要求；`agentWorkflowInputSchema` 用于 Backend 到 Agent 的调用，携带 Backend 准备的设备能力。`@home-agent/api/automations` 提供生成草稿使用的规则树、设备能力、输入输出 schema 与能力校验；Backend 的规则存储与固定动作执行使用同一契约，AI 复核与动作选择尚未启用。任务调用方式与未接入范围见 [Agent 接口](../../apps/agent/README.md#接口)。

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

`@home-agent/api/local-access` 复用 TCP 对端及 Host／Origin 的本机访问校验；`@home-agent/api/http/read-body` 通过原生 Web Streams 管线限制响应读取大小，由原生 Response 汇集字节及处理流取消，不自行拼接分块或管理 reader 锁。JSON 解码和供应商错误转换由各自的协议适配器负责，读取错误保留传输与取消原因。

`@home-agent/api/http/request-json` 执行一次服务间 JSON 请求：调用方提供发送函数、响应 schema、取消信号、期限、字节上限及不可用错误码。它复用 `readLimitedJson`，保留上游公共错误的 code、params 与 issues，区分调用取消与超时，不负责领域资格、地址发现、重连或重试。响应只要求标准 Web Response 中实际使用的字段，不要求 Bun 的扩展方法。SSE 继续使用独立的 `consumeEventStream`，不会经过 JSON 响应解析。

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

[`src/contracts/agent-context.ts`](src/contracts/agent-context.ts) 从已有家庭、空间、成员、感知与窗口 schema 派生专用推送和历史分支，统一通过 `@home-agent/api/agent-context` 导入。`agentContextPolicy` 定义整理缓存、各部分、待发送内容、单次传输及历史响应的预算；来源语义与验证限制由[家庭运行时](../../docs/household-runtime.md#agent-当前数据与材料历史)维护。

`GET /api/agent/context/stream` 使用 `snapshot` 与 `heartbeat` 事件。snapshot 固定为 `{ scope, parts }`，scope 为 null 或 `{ account_id, home_id, scope_epoch }`；运行标识只用于接收适配器核对资格。初始快照提供全部五部分，后续只提供变化部分；省略表示保留。设备状态在同一连接已有 ready 基线时可发送 `status=delta`：`data.changes` 复用家庭变化契约，包含 `latest/source_health/device_coverage/collection` 的 upsert 或 remove，`data.online` 仅在线列表变化时提供。增量只替换或删除指定条目；其他部分及非增量设备状态整体替换，ready 的空集合清空旧集合。每个连接以最后成功发送的完整状态为基线计算差异；增量比全量大时发送全量。heartbeat 数据为空对象，不改变业务部分或同步状态。Agent 接收器使用 `@home-agent/api/agent-context/merge` 的不可变增量合并、整部分替换与家庭资格隔离规则，连接重试由接收适配器维护。Web 数据页通过只读代理查看 Agent 接收记录。

| 部分           | data 来源                                        |
| -------------- | ------------------------------------------------ |
| `household`    | 家庭、房间、设备及完整规格                       |
| `spatial`      | 空间、通道和观测绑定（包含停用记录）             |
| `device_state` | 最新属性报告、设备在线值、采集与来源状态         |
| `members`      | 人物／宠物登记资料                               |
| `observations` | 统一观察索引、成员记录和音视频窗口引用、来源状态 |

`device_state.data.latest` 只包含属性身份、值、来源证据、质量及时间，不重复家庭／房间、规格 ID、描述、类型、可读性和单位。静态信息由 `household.data.device/specs` 提供，规格中的属性键为 `prop.<siid>.<piid>`；设备的房间归属由设备清单提供。动态属性 schema 从已有属性 schema 派生。

`observations.data` 包含 `as_of/records/member_sightings/sources`；`as_of` 为整理时间。每位成员保留最后出现，同一时刻保留并列来源，不因超过 30 分钟而清空；未知身份按设备与镜头保留最新出现。窗口线索在来源仍保留的最近材料中按摄像头／镜头和类型保留最后一条，重复窗口合并，历史通过专用接口查询。`member_sightings` 每条保存材料 ID、观察起止时间、设备与镜头、主机接收时间依据及当前轻量身份归属（成员、候选／确认／推断状态和修订号），不含身份图片或特征证据；身份撤回标记 unknown。每条观察的 `source` 保存设备与镜头。每条窗口观察使用 `window_id` 引用唯一窗口，使用 `member_sighting_ids` 引用关联成员记录；统一快照不嵌入成员记录正文、检测帧、转写或完整窗口详情。`POST /api/agent/context/material` 使用 `agentMaterialQuerySchema` 的 `{ scope, kind, id }` 按需解析单个引用；`agentMaterialResponseSchema` 返回当前成员记录或窗口详情，过期／移除返回 404，读取结果不合并进统一快照；等待期间可响应取消和请求截止时间，结果返回前仍核验家庭资格。没有可关联窗口的成员记录形成 `window_id=null` 的独立出现观察。`reasons` 表示窗口选取依据，不是事件结论或说话人归因；窗口级声音和变化线索不复制到各成员的出现观察上。关联规则由[家庭运行时](../../docs/household-runtime.md#agent-当前数据与材料历史)维护。`sources.member_sightings/perception` 分别包含 `status/read_at/reason/truncated`，表示独立读取与重试状态；统一部分 ready 不表示来源全部成功。交付不调用模型或生成媒体。

合并后的每部分包含 `status/read_at/data/reason/truncated`。设备增量消息包含 `status=delta/read_at/data/truncated=false`，不作为独立上下文部分保存；缺少当前家庭的 ready 基线时拒绝增量并重新连接。status 为 `loading/ready/unavailable/failed`，只有 ready 携带 data；read_at 为最近读取尝试完成的 UTC 时间，尚未完成时为 null，ready 必须有完成时间。unavailable 和 failed 给出安全原因，其他状态 reason 为 null；非 ready 的 truncated 为 false。当前交付不裁剪记录，truncated 为 false；时间范围和材料保留不证明历史完整。近期成员投影按 `lastObservedAt/id` 降序读取，统一观察按 `endedAt/id` 降序交付。任一部分超出发布容量时报告失败，不交付静默裁剪的集合。

历史 `POST /api/agent/context/history` 的输入和响应均按 kind 定义判别联合，各分支只接受自己的字段。公共输入为预期绑定 `account_id/home_id`、UTC 半开区间 `start/end`、`limit/cursor`，默认每页 100 条、上限 1,000 条。`member_sightings` 可选 `member_ids` 和 `sources`，`perception_windows` 可选 `sources`；sources 为 `{ device_id, channel? }` 数组，镜头值复用已有窗口 schema，省略 channel 匹配该设备全部镜头。筛选数组省略表示不筛选，显式空数组拒绝；对象去重并固定排序。

成员响应的 records 由 `memberSightingRecordSchema` 定义，保留记录 ID、原时间、原 data/evidence、当前归因及 context_entities 关联。区间条件为 `firstObservedAt < end && lastObservedAt >= start`，按 `firstObservedAt/id` 升序分页。member_ids 匹配当前已知归因，sources 匹配记录来源，两类筛选取交集。retention 明确数据库存储、当前修订、观察跨度不证明持续在场、分页不保持快照。

音视频响应的每条记录包含完整 `window` 与 `matches`。后者分别引用命中的视觉窗口 ID、音轨 run/代次和转写片段 ID；视觉、非空音频及每条转写的原观察区间任一满足相同重叠规则即返回整体窗口。按 `startedAt/id` 升序分页，媒体仅返回现有状态与引用。retention 明确数据库存储、365 天保留、已提交记录不随重启丢失及区间完整性不保证；媒体缓存独立过期，SD 录像可用性不保证，未提交记录可能因异常退出或写入队列满丢失。过期或当前无访问资格的窗口不返回。

新增响应保留 `kind/account_id/home_id/start/end/records/next_cursor`。游标绑定 kind、家庭身份、绑定记录 updated_at、规范化对象条件和区间；成员与音视频历史均可在同一绑定下跨进程续页，每页仍重新核验当前资格。分页按完整记录及字节预算交付，游标指向最后实际返回记录，首条单独超预算返回容量错误，无下一页时 next_cursor 为 null。归因修订、晚到内容和淘汰可改变后续页，分页结果不作为完整消费记录。成功无匹配记录返回空数组，来源不可用或读取失败返回错误。

该契约交付已有来源材料，不包含凭据、参考照片、特征向量或媒体字节，不定义模型调查、默认模型输入、生活事件推断或语义回写。

接收观察契约位于 `@home-agent/api/agent-receipts`：索引、记录详情和当前上下文均带 `journal_id`，连接或家庭资格改变后失效。记录内容包括校验后的 snapshot 消息和当时合并结果；索引中的 `payload_bytes` 是 SSE 数据正文字节数，`context_bytes` 是当时完整 `{ scope, parts }` 紧凑 JSON 的 UTF-8 字节数，当前快照同样携带 `context_bytes`。`context_delta_bytes` 是同一接收会话内相对上一条消息的字节差，初始消息以零为基准；历史记录淘汰不改变该差值。索引和详情的 `changes` 保存全部结构化变化，以 `kind/key/before/after` 区分变化类型、对象标识和前后值；设备相关变化附带当时的名称与属性规格，删除项使用接收前的设备清单解析。Web 从 `changes` 派生前三项预览和变化数量，搜索覆盖全部变化；中文文案、值类型显示和本地时间格式由 Web 生成。摘要在接收时比较前后状态，设备名称、属性定义、单位和枚举说明来自当时收到的设备清单，解析共用 `@home-agent/api/agent-context/devices`。`member_sighting` 变化单独比较成员出现投影，覆盖最后出现时间、身份归属及最新记录替换，不依赖关联窗口是否变化。摘要忽略采集的累计接收计数与观察来源的读取时间更新，完整消息仍保留这些字段；统一观察提取线索、时间、引用、成员出现归因修订号及轻量窗口材料摘要变化（内容修订号、原始输入保留状态、片段生成状态／选项／有效期／失败原因、语音启用状态与段数、猫狗声分析状态／结果有效性与检测结果数量），不读取外部材料或推断房间、设备身份。猫狗声分析缺失、未就绪或结果无效时，`pet_sound_count` 为 null；仅 ready 且 valid 的分析提供检测结果数量，零表示该有效结果未命中，不证明没有叫声。`sampledMedia=null` 表示无媒体引用，不等同于 `not_generated`。接收索引查询使用 `agentReceiptQuerySchema`：`journal_id/after_sequence` 同时提供时请求该位置后的新增摘要；返回的 `first_retained_sequence` 用于清理已淘汰记录，会话不匹配时重新读取全部保留摘要。响应预算覆盖 `agentReceiptPolicy.retainedBytes` 和响应信封，包含完整 `changes`。保留策略由 `agentReceiptPolicy` 定义。接口与生命周期见 [Agent 接收说明](../../apps/agent/README.md#当前数据接收与只读历史客户端)。

窗口材料与关联字段的轻量投影由 `@home-agent/api/perception/window-observations` 提供，供感知存储和 Web 共用；成员记录与窗口的组装由 `@home-agent/api/agent-context/observations` 负责。未知目标按逐帧、媒体代次和观察时间核对，未建立轨迹的检测目标保留未归因线索。

## 设备标识与筛选

`@home-agent/api/devices` 的 `deviceRoomKey` 根据家庭与房间 ID 生成筛选标识，房间名称只用于显示。中文值、单位和枚举说明的展示由 Web 的设备展示模块负责。

## 自动化规则契约

`@home-agent/api/automations` 提供条件树、触发与固定动作契约，以及属性、时间窗口和三值逻辑求值。设备数值与动作参数共用 `@home-agent/api/devices` 的格式、枚举、范围及步长校验，动作输入保留规格中的 `piid`。AI 条件和动作选择契约仍可表达停用定义，但当前能力校验拒绝启用或生成这些配置；它们不代表可用执行能力。公共生成入口使用 `@home-agent/api/agent-workflows`，详细语义见[家庭自动化](../../docs/automations.md)。

## 家庭模型视图

`@home-agent/api/household-model-view` 提供 `createHouseholdModelView`、`encodeHouseholdContext` 和 `attentionSchema`，由共享离线 CLI 与 Web 压缩上下文页直接共用。实现位于 `src/domain/household-model-view/`，不读取网络、文件或接收器，也不依赖模型框架。输入与筛选规则、查询及编码用法见 [Agent 家庭模型视图](../../apps/agent/README.md#家庭模型视图)。编码结构由 `@home-agent/api/household-model-view/format` 定义，`@home-agent/api/household-model-view/decoding` 的 `decodeHouseholdContext` 据此校验结构及引用。解码入口使用 Node.js 的深度相等比较，独立于浏览器使用的视图与编码入口。

离线命令入口位于 `src/cli/household-model-view.ts`，运行 `bun run --cwd packages/api context:format --help` 查看参数。Agent 的同名命令直接运行此文件。CLI 负责文件读写与命令行参数处理，领域模块负责转换、编码及解码。
