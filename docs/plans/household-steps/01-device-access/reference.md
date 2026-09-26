# Step 1 共同参考

[返回入口](README.md)

本文记录当前设备接入的协议依据、来源契约和验证规范。已实现的家庭运行时见[家庭运行时](../../../household.md)；自动采集与状态仲裁见 Step 3 计划。

## 当前接入与 MiLoCo 参考边界

属性读取复用当前 MiCloud 扫码会话。协议依据是已固定的 `homebridge-miot` commit `8d27204423a569e11c468830e3df324d278954ee` 中 `MiCloud.js` 的 `miotGetProps`：通过同一用户的 MiCloud RC4 请求访问 `/miotspec/prop/get`，该 HTTP 传输不使用 OAuth Bearer 或 unionId→uid 映射；应用仍须接纳包含 MiCloud 与 OAuth 凭据的完整会话。

MiLoCo checkout 由 `AGENTS.local.md` 指定，源码基准为 `cad239dca9b7a2dd3bf0e6565a26cf9eef6581b8`。下表的 MiLoCo 路径均相对于该 checkout；它用于属性返回值、消息及恢复行为参考。整组任务遵守[账号接入前提](README.md#账号接入前提)，扫码后由同一账号所有者完成后端 OAuth 授权，不新增独立登录入口。OAuth、MQTT 连接、订阅及实际消息的证据范围见[来源契约](../../../mijia-source-contract.md#mqtt-授权边界)，未覆盖的型号和异常场景保留未验证。

| 能力               | 本项目采用方式及参考边界                                                                                                                                                                                                                            | 源码入口                                                                                                                                                                      |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 账号与 HTTP 鉴权   | 复用当前扫码 MiCloud 实例的 userId、serviceToken 与 ssecurity，以及现有 Cookie、签名和 RC4 传输；仅沿已支持的 cn 区域运行                                                                                                                           | 固定 `homebridge-miot` 源码 `MiCloud.js` 的 `miotGetProps` 与请求编码；本项目 `protocols/micloud/client.ts`                                                                   |
| 属性读取           | POST `https://api.io.mi.com/app/miotspec/prop/get`；`datasource=1` 缓存优先，缓存缺失可能触发设备 RPC，不保证最新值；规范化输出保守采用 cloud_cache/baseline。150 项／批、30 秒／请求是本项目应用预算，不是已证明的供应商硬上限                     | 固定 `homebridge-miot` 的 `miotGetProps`；MiLoCo `backend/miloco/src/miloco/miot/state_align.py` 的逐项处理作为参考                                                           |
| MQTT 鉴权          | 扫码登录已整合后端 OAuth 授权，任务 1.2 使用同一账号保存的 access token 和实例 UUID 及固定 MiLoCo app ID；不直接使用 Cookie，不新增独立账号生命周期                                                                                                 | MiLoCo `backend/miot/src/miot/mips_cloud.py`：`MIoTMipsCloud`、`_default_client_factory`、`init_async`                                                                        |
| MQTT 连接参考      | MiLoCo 使用 MQTT v5/TLS、`cn-ha.mqtt.io.mi.com:8883`、`client_id=miloco:{uuid}`、keepalive 60 秒及 clean start。已验证范围限定为当前账号与 MiLoCo 应用参数；实例 UUID 为 32 位无连字符十六进制值，与本账号 OAuth device_id 共用，不复用另一进程的值 | 同文件                                                                                                                                                                        |
| 属性推送参考       | 每设备 `device/{did}/up/properties_changed/#`，请求 QoS 2；校验 method、did、siid/piid 和 value 是否存在，接受 params 对象或数组；不以 notify 白名单裁掉设备子树内的合法属性                                                                        | 同文件：`sub_device_props_async`、`_make_device_props_decoder`                                                                                                                |
| 在线通知参考       | 每设备 `device/{did}/state/#`，仅识别 online/offline 叶子；不从属性变化猜在线，也不假定未经核实的精确 topic 可订阅                                                                                                                                  | 同文件：`sub_device_state_async`、`_make_device_state_decoder`                                                                                                                |
| 订阅确认与恢复参考 | SUBACK granted QoS 0/1/2 算成功；按 topic 对账，确认成功才记入订阅集合。重连重订，失败单独上报；对账与 SDK 重放各使用 16 的并发限制。凭据更新方式由实际启用通路决定                                                                                 | 同文件：`_subscribe_async`、`_on_connect`；`backend/miot/src/miot/client.py`：`_replay_subscriptions`；`backend/miloco/src/miloco/miot/client.py`：`_reconcile_subscriptions` |
| 初始与恢复读取参考 | 启动读取当前家庭在线设备的可读属性；上线补读只补缺项，防抖 20 秒。MQTT 重连先刷新目录，规则源延迟 15 秒补读引用属性，包括已有旧值；用请求开始时间保护期间到达的新推送。这些属于 Step 3                                                              | `backend/miloco/src/miloco/miot/state_align.py`；`manager.py`：`_pull_iot_props`；`miot/mips_listeners.py`：`PropTopUpListener`；`rule/iot_source.py`：`on_mips_connect`      |
| 时间与设备标识参考 | 属性及在线回调的 timestamp_ms 来自本机 `_now_ms()`，不是设备时间；解码结果没有上游业务事件 ID／序号。带 `/` 的 did 被该实现排除，不据此断言供应商永久不支持                                                                                         | `backend/miot/src/miot/mips_cloud.py`：两个 decoder；`backend/miloco/src/miloco/miot/client.py`：`is_subscribable_did`                                                        |
| 独立设备事件       | 参考实现没有 `event_occured` 的订阅、解码和消费链。文件头或类型里出现该名字和 eiid 不能当成功能已实现                                                                                                                                               | `backend/miot/src/miot/mips_cloud.py`、`client.py`；`backend/miloco/src/miloco/miot/state_push.py`                                                                            |

当前已接入同账号指定属性读取、属性推送、在线通知和最小连接／订阅恢复。已验证能力不泛化到其他应用、型号或拓扑；独立 `siid/eiid` 设备事件没有正式接入通路，不构造 topic 或支持结论。

### 属性读取返回码

沿用 MiLoCo 的 backend/miloco/src/miloco/miot/result_codes.py 中 is_failure 与 _MIOT_OK_CODES，以及 state_align.py 的 _read_values：只有整数负码且不在 {0, -702000000, -702010000} 中才判该项失败。不能采用“非零即失败”或“负数一律失败”；参考实现不将零、正码、非整数或缺失 code 判为设备失败。

返回码未判失败不代表已有可用属性值：仍须匹配本次请求的 did/siid/piid、确实包含 value，并满足属性值结构要求；缺失 value 不补 null，不以外层 RPC code=0 代替逐项判定。此分类仅用于属性读取结果，不混用于扫码认证响应或 MQTT SUBACK。

### 本项目适配边界

- MQTT 复用已有扫码登录流程，不增加独立授权入口；鉴权及应用准入限制见来源契约。MiLoCo 使用 Python `paho-mqtt>=2.1.0`。当前 Bun／TypeScript backend 使用锁定的 [MQTT.js 5.16.0](https://github.com/mqttjs/MQTT.js) 及其 MQTT 5、TLS 和订阅确认 API。语言库替换不改变小米协议，不新增 Python 常驻服务或自制 MQTT 编解码器。显式设置 protocolVersion=5、clean=true、keepalive=60、connectTimeout=15000、resubscribe=false、reconnectPeriod=0；由一个适配器负责重连和 topic 对账，避免与库默认机制重复。
- MiLoCo 账号级订阅属性后在状态写入处过滤当前家庭。本项目沿已确定的单家庭采集范围，适配器只为调用方明确提供并经同账号目录校验的设备集合建立属性／在线订阅；service 校验现有家庭选择和目录，Step 3 计划负责自动生成持续采集集合；Step 2 已按账号级范围接入目录变更通知，通知经防抖触发完整目录同步。此差异不改变每设备 topic 和解码方式。
- MiLoCo 的 `_on_message` 不等待 SUBACK 即可分发合法消息；本项目适配器沿用该行为，不新增早到包丢弃或缓冲机制。MiLoCo 的 `IotPushWriter.on_device_props` 另检查 `scope_is_aligned()`，初始对齐前仍会拒绝写入属性；传输分发不能等同于家庭状态已提交。本项目的 collection_generation、delivery_kind 与 quality 属于 Step 3 接纳规则，不是小米协议字段；消息接收与订阅确认分别处理。
- MiLoCo 将当前连接的属性推送作为实时输入，缓存读取作为对齐输入。本项目沿用这一运行语义：正常活动连接、合法 topic 上的推送为 `live`，`observed_at=null`、时间依据为接收时间；它不承诺设备即时采样、历史永不补发或端到端恰好一次。已识别的保留包／重放包单独分类；出现反证时调整受影响通路，而不因没有设备时间戳就默认停用全部推送。
- Step 3 计划实施缓存候选、在线 unknown 和规则基线限制；这些状态仲裁能力尚未由当前接入层提供。本阶段只承诺接入通路对齐，不声称两个系统的状态仲裁完全相同。`properties/source-profiles.ts` 记录一份可复用的 MIoT 通路配置与真实例外，不把同协议下的每台设备都变成待人工审批项。

## 交付位置

当前目录与模块职责以 [目录架构](architecture.md) 为准。

- `docs/mijia-source-contract.md`：当前有效的来源契约与能力矩阵，按下表记录已验证能力、适用条件、未验证项和恢复限制；维护最终参考，不累计历次验证流水。
- `apps/backend/src/mijia/protocols/micloud/`：现有扫码、会话、目录、规格与属性读取协议；`client.ts` 的 `getProperties` 复用当前 MiCloud 实例。MQTT 由 `protocols/miot/mqtt.ts` 和 `messages.ts` 实现；账号协调归 `service.ts`，不创建另一套账号管理服务。
- `apps/backend/src/mijia/properties/source-profiles.ts`：与来源契约条目对应的类型化接入配置，包含稳定 contract_id、契约版本、凭据／区域／拓扑／型号／规格适用条件、读取与交付语义及能力映射。仅写入已验证结论；普通运行配置不能把未验证项改为已验证。Step 3 计划按该配置绑定设备策略，不解析 Markdown 决定运行行为。
- `data/verification/household-access/<run_id>/report.json`：本次脱敏实机证据。`run_id` 使用 UUID；该目录位于已忽略的 `data/` 内，不提交账号、设备对应的本机验证记录。报告顶层包含 `run_id`、`started_at`、`finished_at`、`adapter_version`、实际锁定的客户端库版本、`cases`；每个 case 包含契约条目 ID、脱敏设备／能力标识、前置条件、操作、预期、实际结果、来源及采集代次、开始／结束时间、返回码／SUBACK 结果、接收与丢弃数量、成功／失败／未验证结论。账号核验只记录目录归属检查方式及结论，不记录凭据、完整供应商报文或私密登录材料。

## Step 1 的调用范围与验收入口

- 当前应用由 Step 2 的家庭运行时管理 scope_epoch，持久家庭选择约束所有设备访问；首次完整目录保存并提交后才允许读取和属性观察。实机验证从当前账号完整成功同步的家庭／设备目录中，由操作者明确选择或明确授权代理选择代表设备及属性；以真实 home_id、did、siid/piid 记录在本机报告。验收不修改现有家庭选择，也不自动选择第一个家庭。
- service 提供正式内部方法 readProperties(properties, signal) 与 observeDevices(deviceIds, onObservation, signal)。账号取自唯一账号所有者；输入设备必须属于其有效目录，属性读取须有 readable 规格。调用前及异步返回前重验账号、活动请求／连接身份和设备归属；不要求调用方提供尚未实现的家庭 latest、属性版本或 availability。
- readProperties 返回逐项观测，不提交家庭状态；observeDevices 将明确设备集合交给同一 MQTT 适配器，交付逐 topic 确认／失败、连接变化和规范化消息。传入信号结束即取消本次读取或观察。Step 3 计划直接调用这两个入口，不新增另一套协议客户端；家庭过滤、缺值选择和状态写入由采集 actor 负责。
- 读取复用现有扫码账号；仅在扫码会话本身失效时通过现有账号页面恢复登录，不增加属性读取专用授权。设备读取与消息验收可在暂停常驻 backend 后，用现有 Bun 执行工具装配 MijiaService 及家庭运行时、复用加密凭据存储，等待目录与目标规格就绪后调用上述正式方法；在 finally 中撤销观察并关闭服务，再恢复常驻 backend。避免两个账号所有者进程同时续期或使用同一 MQTT 实例 ID。操作与脱敏输出留在本机报告，不提交专用验收程序、临时 HTTP 路由或测试代码。
- 本机验收接收方只记录消息、确认结果和时间，不维护业务 latest、不推导在线状态或缺值，不参与自动化。Step 1 不把“重新读取成功”表述为“家庭状态已恢复”。Step 2 已提供家庭运行时及选中家庭的目录、规格；Step 3 计划将属性版本、availability 和自动采集接到正式入口。

## 来源能力矩阵

来源能力矩阵至少包含：

| 项目       | 必须说明的内容                                                                                                                                                     |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 身份与条件 | 按供应商账号、区域及接入通路确定稳定 `source_id`，不随凭据续期或重连改变；设备和型号、接入拓扑及网关／固件条件、凭据类型；共享参考不保存真实账号／设备 ID 或凭据值 |
| 采集实例   | `collection_generation` 为活动采集实例 UUID；首次启动、断线重建、凭据更新重建时生成新值，失效后所有关联读取、消息及确认结果均不得提交                              |
| 能力标识   | 属性 `siid/piid` 及 read/notify，事件 `siid/eiid` 及参数规格；在线状态单列                                                                                         |
| 接入证据   | 规格是否声明、读取是否成功、订阅是否确认、是否实际收到；分别记录，不合成一个支持布尔值                                                                             |
| 时间语义   | `observed_at` 的来源、精度、可信依据；缺失则 null。`received_at` 是 backend 接收时间；读取另有 `read_started_at`，不作为设备时间                                   |
| 顺序与身份 | 来源是否提供 `source_event_id/source_sequence`，唯一性或顺序保证覆盖哪些设备、能力、连接及有效期，重连／设备重启是否重置；没有则明确无法保证                       |
| 读取与恢复 | `read_semantics`、`delivery_kind` 的判定依据、是否提供初值／保留消息／断线重放、恢复触发及仍无法确认的状态；实测未覆盖的保证保持未验证                             |
| 结论       | 可用／不支持／未验证、适用范围及依据；暂时连接失败、超时或订阅待确认属于运行状态，不直接判成永久不支持                                                             |

时间、顺序、身份保证优先依据对应协议的明确约定，并以实机复核；几次顺序正确或没有重复的接收记录不能证明永不乱序、永不重复。相同值不是消息身份，MQTT 报文标识也不能未经验证就当作跨连接的业务事件 ID。

验证结论按其实际适用范围复用：协议保证属于已验证的接入通路；属性类型、单位和读／通知语义属于型号与规格；网关／固件差异仅在影响通路时成为匹配条件。相同条件的新设备可直接绑定同一来源配置，不逐台、逐次重启请求人工批准。运行时仍须取得当前实例的订阅确认并校验消息；重连不抹掉已验证的协议知识。条件不匹配或出现反证时，只停用受影响的能力保证并更新契约，不将同一来源的其他能力一并判为未知。

## 观测与恢复契约

适配器交付的恢复契约须说明：何时可以认为某能力已订阅、哪些数据仅能作为基线、哪些数据允许进入实时事件通路、哪些质量变化需要通知上层。不能用一次连接健康状态代替每项能力的订阅和数据有效性。

Step 1 输出在线通知来源、连接／订阅失效及恢复事实；每设备 availability 的派生与验证归 Step 3，包括断连或覆盖丢失后转 unknown、恢复后重新取得在线事实。目录的供应商在线布尔值只作为目录快照保存，不充当通知来源或读取禁令；运行时字段及仲裁统一见 Step 3 的 `availability` 契约。缺少该通路时在线状态为 unknown，不阻断其他已验证的属性能力。

### 交付类型

所有规范化观测携带 `delivery_kind = live | baseline | replayed | unknown`，它独立于 push／read 来源、`read_semantics` 和时间可信度。

| delivery_kind | 判定与用途                                                                                                                                    |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `live`        | 按来源的已确定接入语义处理当前连接推送，不自动提供设备时间或零延迟保证。MIoT 采用上文运行语义；设备事件仍需独立通路，属性边沿须有连续有效基线 |
| `baseline`    | 主动读取、初值快照及可识别的保留状态；仅用于状态／基线，不推导刚发生的物理事件                                                                |
| `replayed`    | 可确认的历史补发、离线积压或重放；按来源时间与质量进入历史候选，不作为即时设备事件或物理边沿                                                  |
| `unknown`     | 无法确认本次交付属于实时、基线还是重放；保留来源与限制，可按策略进入历史候选，不作为即时设备事件或物理边沿                                    |

已验证通路的活动连接中，合法属性／在线推送按上表采用 live 的运行语义，保留缺少设备时间与源排序的限制；这不构成“从不补发”的供应商保证。已识别的保留状态为 baseline、历史补发为 replayed，无法解释的异常交付为 unknown。其他尚未接入的来源不继承这项结论。历史保存不得把 received_at 写成设备事件发生时间。

### 接入参数与恢复行为

下表是当前 HTTP 读取应用预算与 MQTT 接入参数。它们不冒充小米服务端限额。供应商明确拒绝或限流时记录并遵从。协议接入不另设每秒订阅数、额外订阅重试轮次或预确认缓冲。

| 项目                        | 默认值与失败分支                                                                                                                                                                                                                      |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MQTT 连接                   | v5/TLS、keepalive 60 秒、请求 QoS 2、clean start；CONNACK 等待 15 秒，参照 `mips_cloud.py`                                                                                                                                            |
| 连接重建                    | 1—120 秒退避，参照 paho reconnect_delay_set；TS 适配器集中管理一个重连计时器，不叠加库自动重连，不另设 ±20% 抖动或稳定 60 秒才复位条件。撤销时取消，认证拒绝交还账号所有者                                                            |
| 订阅确认                    | 每次 10 秒；本项目对账／重订共用 16 个在途名额，对应 `_RECONCILE_CONCURRENCY`／`_REPLAY_CONCURRENCY`。共用限制属于 TS 单一适配器的组织方式，不声称 MiLoCo 低层重订已全局限流                                                          |
| 订阅失败                    | 临时 SUBACK 拒绝保留期望项，由重连或显式重试重新发起；ACK 超时关闭该代并按已有退避恢复，释放 SDK 未确认请求；topic 权限拒绝通知账号所有者刷新目录，不等同于 token 失效。永久拒绝跨断线保留至授权条件变化，不通过普通重连反复尝试      |
| HTTP 属性读取               | 单次 30 秒、每批最多 150 项、批次串行，作为本项目应用预算。Step 3 计划共用此预算，命令总期限可以更早取消；失败不增加隐藏重试，等待真实恢复触发或显式读取                                                                              |
| HTTP 限流等待               | 属性 reader 按稳定 source_id 保存 Retry-After；期限内后续批次及新读取不发请求，返回 read_started_at=null 的 unavailable，沿用原失败接收时刻。到期后只由下一次显式读取发起；账号自动／手动恢复续期也遵守 Retry-After，超长等待分段调度 |
| Step 3 计划的上线／重连补读 | 上线防抖 20 秒、重连延迟 15 秒，参照 `PROP_TOPUP_DEBOUNCE_SEC`、`RECONNECT_PULL_DELAY_SECONDS`；在途触发合并，退出作用域取消                                                                                                          |

## 验证规范

- 实机证据保存在上述 Git 忽略目录，报告包含对应 `task_id`、源码和依赖版本；实现审查、确定性探针、公开参考源码与本项目实机结果分别标注。
- 设备范围、时间和具体运行结果留在本机报告，共享来源契约只保存协议结论、适用条件和限制，不累计验证流水。账号／目录归属核验不保存凭据、扫码材料或完整供应商报文。
- 每项验收标明通过、未通过、未验证或不适用；没有真实证据的场景不能以模拟数据、类型检查或构建通过补齐。
- 变更后运行受影响包的类型检查、lint 和构建。新增测试须遵守仓库明确授权规则；验证代码不进入正式 HTTP 或账号接入路径。
- 剩余联合实机验收集中维护于 [恢复计划](03-recovery.md#待完成的联合生命周期验收)，不在当前来源契约中描述为已实现或已通过。
