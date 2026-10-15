# API 契约与错误处理

`@home-agent/api/action-provenance` 提供命令、来源元数据、供应商材料、分页和诊断 schema。History 复用来源字段，自动化动作只引用命令，不含反馈匹配字段。用法与限制见[家庭运行时](../../docs/household-runtime.md#命令与供应商材料)。

`commandRecordSchema` 只定义 id/source/target/called_at/sent_at/expires_at，列表与详情共用该结构。`commandSourceSchema` 统一校验 human、automation 和 agent 三类来源：用户原文 `request_text`、规则名 `rule_name` 必须非空；触发依据 `trigger_text` 与自主原因 `reason` 可为 null，非 null 时必须非空，不使用默认值。`deviceControlResultSchema` 独立校验控制回执，不写入操作记录。`commandQuerySchema` 仅接受 scope_epoch/start/end/device_id/source/limit/cursor，source 是 executor 分类；材料继续使用原查询契约。接收变化通过 operation 按 ID 比较新增、修订及移出，移出不代表撤销。

`@home-agent/api` 统一约定 Web、backend 与 Agent 交换数据时的字段、类型和错误格式（数据契约），并提供服务端请求校验及错误处理工具。

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

家庭领域的范围变化、暂不可用、容量和存储失败分别使用 `household_scope_changed`、`household_unavailable`、`household_capacity_exceeded` 和 `household_storage_unavailable`；设备不存在使用 `not_found`。这些错误码同时用于家庭公共状态和相关 HTTP 接口。身份参考自身不可用使用 `identity_reference_unavailable`。真实米家接入失败保留对应米家错误码及安全的上游参数。

空间删除的引用冲突使用[独立业务结果](#空间资料契约)，通用异常仍使用上述错误格式。调用方按响应结构区分同为 HTTP `409` 的业务结果和错误。

## 空间资料契约

[spatial.ts](src/contracts/spatial.ts) 是空间输入、公开记录及校验的唯一字段定义；`spaceDefinitionSchema`、`passageDefinitionSchema` 定义不含数据库时间戳的空间和通道，通道端点约束由领域维护，记录通过扩展补充时间戳，Agent 规划草稿直接复用。接口路径与领域含义见 [Backend 空间关系资料](../../apps/backend/README.md#空间关系资料)。整体读取返回 `scope`、`spaces`、`passages`、`observation_bindings`，消费者按稳定 ID 关联目标与通道端点，设备名称及实时状态从设备清单读取。

所有写入携带读取返回的 `scope`，即账号、家庭及绑定更新时间；尚未绑定时为 `null`。保存区分 `operation: create | update`，调用方生成 UUID：新建要求 ID 不存在，编辑要求存在且提供读取时的 `expected_updated_at`，新建不接受版本字段。删除接受 `scope`、`id`、`expected_updated_at`，启停额外接受 `enabled`。后端在同一事务中检查绑定标识和记录版本。

删除成功返回 HTTP `200 / { status: "deleted", id }`；有引用时返回 HTTP `409 / { status: "referenced", id, references: { passages, observation_bindings } }`，至少一个引用数组非空，数组元素复用公开记录 schema。空间删除只返回直接引用，通道删除的 `passages` 为空。删除对象不存在返回 `404 / not_found`。

其他错误沿用通用格式：`spatial_record_exists`、`spatial_record_changed`、`spatial_scope_changed` 返回 `409`，分别表示 ID 已存在、记录版本变化、家庭绑定变化；`spatial_reference_invalid`、`spatial_source_invalid` 返回 `400`；`spatial_storage_unavailable` 返回 `503`。客户端不自动重试写入，响应丢失时应先读取并确认实际结果。

## 连接检查

聊天输入输出由 [Agent 聊天模块](../../apps/agent/README.md#接口)通过 `@home-agent/agent/assistant/contracts` 导出。

连接状态接口完成探测时返回 200，即使外围服务不可用。每个服务返回 `reasonCode` 与可选 `params`；页面生成可读说明。读取连接配置失败返回普通 HTTP 错误。

## 测试

```sh
bun run --cwd packages/api test -- tests/contracts/household.test.ts
```

消费方只测试自己如何使用契约和处理校验失败，不重复枚举这些共享规则。

## 设备历史契约

`@home-agent/api/device-history` 从设备能力、属性地址和值 schema 派生固定说明、接纳报告、查询、两种页响应与 Web 历史 SSE。记录按 `kind=property|online` 区分，在线 `value` 为布尔值，不附带 MIoT 地址或属性说明；在线来源 `directory` 表示设备清单读取。共享 `deviceHistoryPolicy` 定义 365 天保留、页大小、请求／响应容量，`deviceHistoryStreamPolicy` 定义历史流的连接、事件与等待预算。`@home-agent/api/agent-context` 的 `kind=device_reports` 分支复用设备历史契约，其他分支见[Agent 数据交付契约](#agent-数据交付契约)。

时间区间校验 UTC、至多微秒精度及 `start < end`；属性编号 `siid/piid` 复用共享地址 schema，只接受 `1..2147483647` 的整数。查询统一返回已保存变化记录，不含表达方式参数或同值段字段；历史写入跳过连续同值，不保留每次重复报告。查询支持 device_ids、kinds 和 properties；kinds 默认两类，properties 仅匹配原生属性，筛选条件取交集。`order` 默认 `asc`，Web 使用 `desc` 按最新优先读取。Backend 对筛选去重并固定排序，校验游标、查询方向及当前家庭资格；调用方不解释游标内部内容。

Web 的 `POST /api/device-history/events` 在读取条件上增加 `delivery=live|page|export`。live 要求降序且不带游标，首批为 `page`，后续 `change` 携带变化记录、完整有序 `record_ids` 与 `removed_ids`；记录 ID 使用 observation_id。`page` 固定区间返回一页后发送 `complete`；`export` 按固定区间在单个 SQL 查询快照内生成最多 64 MiB 的临时页文件，事务结束后连续交付有界数据批次（next_cursor 为 null），期限沿用 Backend 读取配置，完成后发送 `complete`，两者随后关闭。空心跳使用 `heartbeat`，流内失败使用公共 `error` 契约。Agent 历史入口继续使用一次性 JSON 响应。来源、分页、保留与容量语义见[设备状态历史](../../docs/household-runtime.md#设备状态历史)，支持基线与验证边界见[数据库维护与验证限制](../../docs/household-runtime.md#数据库维护与验证限制)。

## Agent 数据交付契约

`GET /api/agent/context/stream` 使用 `snapshot` 与 `heartbeat` 事件。snapshot 固定为 `{ scope, parts }`，scope 为 null 或 `{ account_id, home_id, scope_epoch }`；运行标识只用于接收适配器核对资格。初始快照提供全部六部分，后续只提供变化部分；省略表示保留。设备状态在同一连接已有 ready 基线时可发送 `status=delta`：`data.changes` 复用家庭变化契约，包含 `latest/source_health/device_coverage/collection` 的 upsert 或 remove，`data.online` 仅在线列表变化时提供。增量只替换或删除指定条目；其他部分及非增量设备状态整体替换，ready 的空集合清空旧集合。每个连接以最后成功发送的完整状态为基线计算差异；增量比全量大时发送全量。heartbeat 数据为空对象，不改变业务部分或同步状态。Agent 接收器使用 Agent 的 `context/merge.ts` 的不可变增量合并、整部分替换规则，连接重试由接收适配器维护。Web 数据页通过只读代理查看 Agent 接收记录。

| 部分           | data 来源                                                                         |
| -------------- | --------------------------------------------------------------------------------- |
| `household`    | 家庭、房间、设备及完整规格                                                        |
| `spatial`      | 空间、通道和观测绑定（包含停用记录）                                              |
| `device_state` | 最新属性报告、设备在线值、采集与来源状态                                          |
| `members`      | 人物／宠物登记资料                                                                |
| `observations` | 统一观察索引、成员记录和音视频窗口引用、来源状态                                  |
| `operations`   | 近期六字段操作记录与 complete_audit:false；最多 30 分钟／100 条／整个部分 256 KiB |

`device_state.data.latest` 只包含属性身份、值、来源证据、质量及时间，不重复家庭／房间、规格 ID、描述、类型、可读性和单位。静态信息由 `household.data.device/specs` 提供，规格中的属性键为 `prop.<siid>.<piid>`；设备的房间归属由设备清单提供。动态属性 schema 从已有属性 schema 派生。

`observations.data` 包含 `as_of/records/member_sightings/sources`；`as_of` 为整理时间。每位成员保留最后出现，同一时刻保留并列来源，不因超过 30 分钟而清空；未知身份按设备与镜头保留最新出现。窗口线索在来源仍保留的最近材料中按摄像头／镜头和类型保留最后一条，重复窗口合并，历史通过专用接口查询。`member_sightings` 每条保存材料 ID、观察起止时间、设备与镜头、主机接收时间依据及当前轻量身份归属（成员、候选／确认／推断状态和修订号），不含身份图片或特征证据；身份撤回标记 unknown。每条观察的 `source` 保存设备与镜头。每条窗口观察使用 `window_id` 引用唯一窗口，使用 `member_sighting_ids` 引用关联成员记录；统一快照不嵌入成员记录正文、检测帧、转写或完整窗口详情。`POST /api/agent/context/material` 使用 `agentMaterialQuerySchema` 的 `{ scope, kind, id }` 按需解析单个引用；`agentMaterialResponseSchema` 返回当前成员记录或窗口详情，过期／移除返回 404，读取结果不合并进统一快照；等待期间可响应取消和请求截止时间，结果返回前仍核验家庭资格。没有可关联窗口的成员记录形成 `window_id=null` 的独立出现观察。`reasons` 表示窗口选取依据，不是事件结论或说话人归因；窗口级声音和变化线索不复制到各成员的出现观察上。关联规则由[家庭运行时](../../docs/household-runtime.md#agent-当前数据与材料历史)维护。`sources.member_sightings/perception` 分别包含 `status/read_at/reason/truncated`，表示独立读取与重试状态；统一部分 ready 不表示来源全部成功。交付不调用模型或生成媒体。

合并后的每部分包含 `status/read_at/data/reason/truncated`。设备增量消息包含 `status=delta/read_at/data/truncated=false`，不作为独立上下文部分保存；缺少当前家庭的 ready 基线时拒绝增量并重新连接。status 为 `loading/ready/unavailable/failed`，只有 ready 携带 data；read_at 为最近读取尝试完成的 UTC 时间，尚未完成时为 null，ready 必须有完成时间。unavailable 和 failed 给出安全原因，其他状态 reason 为 null；非 ready 的 truncated 为 false。operations 超出条数或字节上限时交付完整记录前缀并标 truncated，其他部分不裁剪记录；时间范围和材料保留不证明历史完整。近期成员投影按 `lastObservedAt/id` 降序读取，统一观察按 `endedAt/id` 降序交付。operations 首条无法容纳或其他部分超出发布容量时报告失败。

历史 `POST /api/agent/context/history` 的输入和响应均按 kind 定义判别联合，各分支只接受自己的字段。公共输入为预期绑定 `account_id/home_id`、UTC 半开区间 `start/end`、`limit/cursor`，默认每页 100 条、上限 1,000 条。`member_sightings` 可选 `member_ids` 和 `sources`，`perception_windows` 可选 `sources`；sources 为 `{ device_id, channel? }` 数组，镜头值复用已有窗口 schema，省略 channel 匹配该设备全部镜头。筛选数组省略表示不筛选，显式空数组拒绝；对象去重并固定排序。

成员响应的 records 由 `memberSightingRecordSchema` 定义，保留记录 ID、原时间、原 data/evidence、当前归因及 context_entities 关联。区间条件为 `firstObservedAt < end && lastObservedAt >= start`，按 `firstObservedAt/id` 升序分页。member_ids 匹配当前已知归因，sources 匹配记录来源，两类筛选取交集。retention 明确数据库存储、当前修订、观察跨度不证明持续在场、分页不保持快照。

音视频响应的每条记录包含完整 `window` 与 `matches`。后者分别引用命中的视觉窗口 ID、音轨 run/代次和转写片段 ID；视觉、非空音频及每条转写的原观察区间任一满足相同重叠规则即返回整体窗口。按 `startedAt/id` 升序分页，媒体仅返回现有状态与引用。retention 明确数据库存储、365 天保留、已提交记录不随重启丢失及区间完整性不保证；媒体缓存独立过期，SD 录像可用性不保证，未提交记录可能因异常退出或写入队列满丢失。过期或当前无访问资格的窗口不返回。

新增响应保留 `kind/account_id/home_id/start/end/records/next_cursor`。游标绑定 kind、家庭身份、绑定记录 updated_at、规范化对象条件和区间；成员与音视频历史均可在同一绑定下跨进程续页，每页仍重新核验当前资格。分页按完整记录及字节预算交付，游标指向最后实际返回记录，首条单独超预算返回容量错误，无下一页时 next_cursor 为 null。归因修订、晚到内容和淘汰可改变后续页，分页结果不作为完整消费记录。成功无匹配记录返回空数组，来源不可用或读取失败返回错误。

该契约交付已有来源材料，不包含凭据、参考照片、特征向量或媒体字节，不定义模型调查、默认模型输入、生活事件推断或语义回写。

## 自动化规则契约

`@home-agent/api/automations` 提供条件树、触发与固定动作契约，以及属性、时间窗口和三值逻辑求值。设备数值与动作参数共用 `@home-agent/api/devices` 的格式、枚举、范围及步长校验，动作输入保留规格中的 `piid`。AI 条件和动作选择契约仍可表达停用定义，但当前能力校验拒绝启用或生成这些配置；它们不代表可用执行能力。公共生成入口使用 `@home-agent/agent/workflows`，详细语义见[家庭自动化](../../docs/automations.md)。

## Agent 家庭模型视图

模型输入的能力筛选、视图转换、编码与解码由 Agent 拥有，通过 `@home-agent/agent/context/model-view` 及其子路径导出；Web 直接复用 Agent 实现。输入与筛选规则、查询及编码用法见 [Agent 家庭模型视图](../../apps/agent/README.md#家庭模型视图)。
