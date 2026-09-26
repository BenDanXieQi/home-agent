# 米家来源契约

本文描述同一 MiCloud 扫码会话下的指定属性读取。类型化配置位于 [`source-profiles.ts`](../apps/backend/src/mijia/properties/source-profiles.ts)，读取契约为 `miot-cloud-cache-read`，版本 `1`；`miot` 表示属性模型，不表示 OAuth 鉴权。传输使用 `micloud_rc4`，凭据类型为 `mijia_qr_session`，设备与读取绑定同一 MiCloud 账号实例。

请求依据为固定 `homebridge-miot` commit `8d27204423a569e11c468830e3df324d278954ee` 的 `MiCloud.js` 中 `miotGetProps` 与 RC4 请求实现。逐项结果语义参考 MiLoCo commit `cad239dca9b7a2dd3bf0e6565a26cf9eef6581b8` 的 `state_align.py`、`result_codes.py`；入口见[共同参考](plans/household-steps/01-device-access/reference.md)。源码审查与本项目实机接入是两类证据。

同一 MiCloud 扫码会话已在 4 台代表设备的 13 项属性上取得 `code=0` 且含合法值的成功结果，覆盖灯、空气检测仪、温湿度计和人在传感器。此结论只覆盖下表型号与属性，不泛化到其他设备、网关或固件，也不证明数据新鲜度、MQTT 或长期恢复能力。

## 账号与授权

`MijiaService` 是唯一账号所有者，`DeviceDiscovery` 负责供应商目录请求与原始媒体接入信息；`household/` 状态机持有已保存、提交的家庭业务目录和规格，页面与内部属性预检读取这份资料。扫码会话同时支持目录和属性请求；媒体从同一账号取得 userId/passToken/region。凭据以 `mijia` 保存在 AES-256-GCM 凭据仓库，不进入普通配置、状态快照、日志或追踪。

复用已有米家扫码登录流程是接入前提。现有账号所有者统一管理会话保存、恢复、续期和退出；属性读取使用当前 MiCloud 实例的 userId、serviceToken、ssecurity 与 Cookie，不创建独立 OAuth、unionId→uid 映射、额外授权页面或第二套 token 仓库。需要重新登录时仍使用现有扫码入口，某项属性或媒体失败不构成新增授权流程的理由。

`account/login-flow.ts` 管理扫码尝试，`account/maintenance.ts` 管理 MiCloud 恢复续期任务，`account/session.ts` 准备候选会话；凭据保存、当前账号接纳及跨模块清理由 service 提交。扫码登录失败或取消只结束本次尝试；已经可用的当前账号不因候选失败被替换。

账号恢复与续期的自动任务、手动恢复入口均遵守供应商 `Retry-After`。最早重试时间尚未到达时不发起恢复或续期请求；超出单个 JavaScript 计时器范围的等待分段调度，不因计时器截断提前重试。

service 为当前会话维护读取取消范围及 `collection_generation`。会话替换、账号失效、退出或关闭撤销旧范围；旧请求及迟到结果不能进入新实例。同账号正常续期保留稳定 `source_id`，更换采集代次。go2rtc 故障只影响媒体，属性请求失败不自动切换其他协议。

## MQTT 授权边界

固定 MiLoCo 参考版本的 `mips_cloud.py` 使用 OAuth 应用 ID 作为 MQTT username、OAuth access token 作为 password，client ID 为 `miloco:<uuid>`；`cloud.py` 的 `MIoTOAuth2Client` 通过授权码或 refresh token 获取该 token。扫码登录在后端完成 OAuth 授权，两类凭据由同一个账号所有者和加密记录管理；正式 MQTT 接入使用 MQTT.js 5.16.0。

现有扫码会话的 userId/passToken 已实机验证可经小米 `/pass/serviceLogin`、`/sts/oauth` 建立 OAuth 登录会话。当前账号在 MiLoCo 参考应用参数下，读取 `/oauth2/authorize?_json=true` 时，`skip_confirm=false` 和 `true` 均返回授权确认数据；该响应本身不代表已完成授权。经用户明确同意，后端提交 `/oauth2/userAuthorization` 授予公开信息（昵称、头像等）和智能家庭服务权限，取得授权码，并通过 MiLoCo 的 `/app/v2/mico/oauth/get_token` 成功换得 access token 和 refresh token，返回有效期为 259200 秒。此链路不需要再次扫码或打开授权页面，但包含实际授予权限的操作，不是免授权的 passToken 直接交换。签发的 `oauth2.0_serviceToken` 仅是登录会话 Cookie，不是 MQTT 密码。

授权参数中的 `client_id` 可能以超过 JavaScript 安全整数范围的 JSON 数字返回，必须保留原始精度；普通 JSON 数字解析后再提交会导致签名不一致。正式账号记录同时保存 MiCloud 与 OAuth 凭据；refresh token 续期由账号维护流程负责。

OAuth 与 MQTT 必须使用同一个实例 UUID：OAuth 的 `device_id=mico.<uuid>`，MQTT 的 `client_id=miloco:<uuid>`。UUID 按 MiLoCo `manager.py` 的 `uuid.uuid4().hex` 生成，为不带连字符的 32 位十六进制字符串。实机对照中，两组均成功取得 OAuth token，并使用 MQTT 5、TLS、60 秒心跳及 clean start 连接 `cn-ha.mqtt.io.mi.com:8883`；32 位 UUID 在 Paho 2.1.0 与手写 CONNECT 两种客户端中均收到成功 CONNACK，带连字符的 36 位 UUID 在两种客户端中均返回 `135 / 0x87`（Not authorized）。该对照将本次连接失败定位到实例 UUID 格式，不能据此认定应用未获 MQTT 准入；服务端具体字段校验实现未知。

已验证当前账号及 MiLoCo 参考应用参数下的后端授权、token 交换与 MQTT 连接。正式内部观察入口已验证代表设备的订阅确认、属性变化与同值上报。重连恢复及 Home Agent 自有应用准入未验证；设备在线通知的实机范围见下文。

## 正式推送入口

`MijiaService.observeDevices(deviceIds, onObservation, signal)` 校验当前账号、所选家庭和目录中的明确设备集合，按需创建一个 MQTT 采集实例。多个观察者共用连接与 topic，通过引用计数对账；返回 `cancel()`、`snapshot()` 和 `retry()`。`snapshot()` 提供逐 topic 的期望、确认、在途、获准 QoS、失败原因及接收／丢弃计数；`retry()` 只重试临时失败，不反复尝试已被拒绝的订阅。该入口没有 HTTP 路由，不自动选择全家庭，不提交家庭 latest 或 availability。

`protocols/miot/mqtt.ts` 负责 MQTT 5/TLS 连接、订阅与取消，`messages.ts` 校验和规范化属性及在线消息。每设备请求 QoS 2 的 `device/{did}/up/properties_changed/#` 和 `device/{did}/state/#`；两类 topic 独立接受 QoS 0/1/2 的 SUBACK，连接成功不代替订阅确认。在途操作共用 16 个名额、确认期限 10 秒。订阅超时只令对应 topic 失败，迟到确认不能恢复其确认状态；取消时对已确认或状态不确定的订阅退订。退订失败或超时关闭连接，防止遗留订阅继续交付。

消息回调先于订阅注册。只交付当前实例内仍被观察的设备消息，不等待 SUBACK，也不把消息到达视为订阅成功。属性校验 method、did、siid/piid 和显式存在的 JSON 标量 value；params 支持对象或数组，单项属性与 topic 中地址交叉校验，不按 notify 白名单裁剪。同值上报保留。在线消息仅识别 online/offline 叶子。带 `/`、MQTT 通配符或空标识的设备报告 `unsupported_device_id`，不猜测转义规则。

观测包含稳定 `source_id`、实例 `collection_generation`、真实 `received_at`、`observed_at=null`、`source_event_id=null` 和 `source_sequence=null`。正常消息按 live 交付，MQTT retained 消息按 baseline；不承诺设备采样时间、跨消息顺序、无断线重放或端到端恰好一次。独立 `siid/eiid` 事件未启用。

账号退出、账号身份替换、家庭切换和目录归属／型号／规格变化使当前实例失效；取消移除对应回调，最后一个观察者退出某 topic 时退订。连接或订阅局部失败不会直接关闭媒体。断连只结束当前 MQTT 连接代次，`properties/observation.ts` 保留仍然活动的观察集合，用单一计时器按 1、2、4…120 秒退避重连，连接成功重置为 1 秒，重建后重新取得逐 topic SUBACK。每次连接从账号所有者读取最新 OAuth 凭据；明确认证拒绝停止普通重试并交回账号维护。最后一个观察取消或账号退出时关闭连接并清除定时器。同账号会话续期不撤销观察；OAuth token 改变时重建连接，其他账号／家庭范围撤销仍会终止观察。没有自动补读或家庭状态恢复。应用持有一份业务目录，MQTT 只保存派生的订阅集合。

## 目录变化通知

账号后台目录维护与属性观察复用同一 MQTT 连接。新增精确主题 `user/{uid}/g_op/bind`、`unbind` 和 `device/{did}/g_op/rename`、`hr_change`；目录设备主题覆盖账号可见设备，以发现跨家庭移入。它们不进入属性观测，也不绕过业务家庭限制。通知仅触发 5 秒防抖后的完整目录读取，实际归属以本次云目录校验和提交为准，不依赖未文档化载荷。

主题仍须收到成功 SUBACK。重连后重新订阅并同步目录，既有 5 分钟目录发现继续补漏。只读 `/api/mijia/directory/push` 提供脱敏的连接、订阅与通知统计；收到主题通知不等于已经保存成功，保存结果通过家庭公共状态报告。

## 正式读取入口

[`MijiaService.readProperties(properties, signal)`](../apps/backend/src/mijia/service.ts) 接收 `readonly { did, siid, piid }[]` 与 `AbortSignal`，返回逐项 `PropertyReadObservation[]`。账号由 service 取得，调用方不提供凭据。设备必须属于当前账号完整成功同步的目录，属性必须属于该设备的 readable 规格。目录的 `online` 布尔值不作为读取禁令。规格的能力定义独立于展示翻译：翻译失败或耗尽元数据网络预算时沿用已取得的规格原文，不把已确认可读的属性判为不可读；能力请求自身超时、调用方取消、账号撤销或调用方自身期限到达仍会终止查询。

请求前、规格查询后、批次执行前及异步返回前均检查当前账号、采集实例和目录归属；设备移除、家庭归属／型号／规格引用变化、会话撤销、调用取消或账号失效会拒绝旧结果。此入口只允许读取已选业务家庭的设备，不修改家庭选择，不维护 latest、availability 或属性版本，也不提交家庭状态。

[`preparePropertyRead`](../apps/backend/src/mijia/properties/read-request.ts) 复制属性请求，按设备分组，每组最多 3 台设备并发查询规格，逐设备验证其属性；保留原输入顺序，通过 service 提供的断言核验当前账号、采集实例和目录归属，再交给 [`PropertyReader`](../apps/backend/src/mijia/properties/reader.ts) 使用全局串行 HTTP 批次预算。

本阶段仅交付内部读取入口，没有属性读取 HTTP 路由或周期读取任务。现有 `/devices/refresh` 刷新设备目录；扫码授权和连接状态继续使用[现有米家业务接口](mijia.md#http-与追踪)。

## 编码、预算与逐项结果

[`MiCloud.getProperties`](../apps/backend/src/mijia/protocols/micloud/client.ts) 通过现有认证与 RC4 请求发送 POST `https://api.io.mi.com/app/miotspec/prop/get`，加密的 `data` 内容为 `{"datasource":1,"params":[{"did":"…","siid":2,"piid":1}]}`。Cookie、签名和加密材料均取自当前已接纳的扫码会话，不使用 OAuth Bearer 或另一套 HTTP 客户端。

`datasource=1` 是缓存优先：缓存缺失时可能触发设备 RPC，不能保证拿到最新值。本项目不依据一次响应猜测其是否实际触达设备，统一保守输出 `read_semantics=cloud_cache`、`delivery_kind=baseline` 和 `observed_at=null`；不能称为纯缓存请求或实时设备观测。供应商说明见 [MIoT Plugin SDK 的 getPropertiesValue](https://github.com/MiEcosystem/miot-plugin-sdk/wiki/04-miot_spec#ispecgetpropertiesvalueparams-datasource--promisejson)。

同一 service 的所有读取共用一个 `PropertyReader`，批次串行、每批最多 150 项、单次 HTTP 最长 30 秒且覆盖响应体读取。这些是 [`protocols/micloud/properties.ts`](../apps/backend/src/mijia/protocols/micloud/properties.ts) 定义的应用预算，不是已证明的小米硬上限。没有隐藏属性请求重试；调用方取消可提前终止排队和在途请求。取消中的请求实际结束前仍占用唯一在途名额。

reader 按稳定 `source_id` 保存供应商 `Retry-After` 期限；同账号会话续期不会绕过它。期限内的后续批次和新读取不发出 HTTP 请求，直接逐项返回 `unavailable/request_failed`，`read_started_at=null`，`received_at` 沿用原失败的接收时刻。reader 不 sleep 等待，也不在期限结束后自动重试；到期后须由下一次显式读取发起请求。

每条响应须有合法 did/siid/piid，并精确匹配本批请求地址。批外地址和无效标识被丢弃。只在整数负码不属于 `{0, -702000000, -702010000}` 时判该项 `failure`；正码、非整数或缺失 code 不直接判设备失败。外层 RPC 成功不代替逐项校验。

| `status`                         | 条件与结果                                                                                                                               |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `success`                        | 返回码未判失败，且包含合法 JSON scalar `value`：字符串、有限数值、布尔值或显式 `null`；不接受对象／数组，不补造值                        |
| `failure`                        | 整数普通失败负码；保留数值 `code`，不输出 `value`                                                                                        |
| `unavailable`                    | `response_missing`、`value_missing` 或 `invalid_value`；无可用值，不把缺失转换为 `null`                                                  |
| `unavailable` + `request_failed` | 批次传输／协议失败；`error.kind` 为静态 `MiCloudError.code`，可含 `http_status`、`upstream_code`、`retry_after_at`，不保留供应商自由文本 |

一项或一个批次失败不清除其他已取得的成功项，同地址重复失败行也不能覆盖成功值。认证被拒绝后，本次调用停止后续 HTTP 批次，未发出的项标记为 unavailable；此前成功项和逐项失败仍原样交付。service 触发现有账号维护流程在后台续期，不重发本次属性请求。若并发续期、退出或账号变化已经使当前采集范围失效，则拒绝该旧实例结果；会话恢复失败沿现有账号失败处理。

## 来源、时间与恢复语义

所有结果含 `contract_id`、`contract_version`、`source_id`、`collection_generation` 及属性地址。`source_id` 从供应商账号、`cn` 区域和 `micloud_rc4` 通路确定性派生，不暴露原始账号 ID，也不随同账号会话续期改变。`collection_generation` 为 service 分配的活动实例 UUID；会话替换或撤销时更新，失效实例的结果不得用于新实例。

| 字段或能力                           | 当前契约                                                                                                                             |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| `read_semantics`                     | `cloud_cache`；缓存优先通路的保守分类，不保证响应来自缓存或是最新值                                                                  |
| `delivery_kind`                      | `baseline`；只能作为读取／基线证据，不能直接构成实时物理事件或属性边沿                                                               |
| `observed_at`                        | 恒为 `null`；响应不提供可信设备观测时间                                                                                              |
| `read_started_at`                    | 传输层首次调用 `fetch` 的 UTC RFC3339 毫秒字符串；本地认证拒绝、入参拒绝或 `Retry-After` 阻止请求时为 `null`，不代表供应商已收到请求 |
| `received_at`                        | backend 接收结果或确认失败的 UTC RFC3339 毫秒字符串；本地拒绝为其确认时间，后续被阻止项沿用原失败时间；不是设备采样时间              |
| 时间依据                             | `unknown`；HTTP 刚完成不能证明属性值是新值                                                                                           |
| `source_event_id`／`source_sequence` | 没有可靠上游业务身份或序号，不宣称跨请求排序或去重保证                                                                               |
| 恢复                                 | 扫码会话可用后由调用方显式读取；没有周期属性轮询、断线重放、自动补缺或家庭状态恢复承诺                                               |

## 来源能力矩阵

规格声明、读取成功、订阅确认、实际收包和具体型号适用性分别记录；临时网络失败不能转成永久不支持。

| 契约／能力                             | 身份与适用条件                                      | 规格声明                                   | 本项目证据                                                                                        | 结论与限制                                   |
| -------------------------------------- | --------------------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| `miot-cloud-cache-read` v1：同账号读取 | 当前已接纳 MiCloud 扫码实例、`cn`、同一目录中的设备 | 实际属性必须 readable                      | 同一已保存扫码会话恢复后，正式入口 4 台／13 项全部成功                                            | 不需要独立 OAuth；目录可读不代替属性可读     |
| 代表设备类型                           | 灯、空气检测仪、温湿度计、人在传感器                | 已从实际规格选取布尔、枚举、整数及浮点属性 | 下表列出的型号与属性已实读成功；其余保持未验证                                                    | 范围及真实标识只记录于本机材料               |
| 拓扑／网关／固件条件                   | 依据实际接入条件限定                                | 正式目录／规格没有提供实际网关和固件       | BLE 类型可由设备标识与型号作为推定依据；实际网关、链路及固件未知                                  | 不从 online、型号或数字 did 推断实际直连路径 |
| 属性推送 `siid/piid`                   | 同账号统一保存的 OAuth 凭据及所选家庭目录           | notify 仅是规格声明                        | 4 种代表型号的 topic 获准 QoS 2；灯、空气检测仪、人在传感器收到属性                               | 已接入；温湿度计实际推送仍待观察             |
| 在线通知                               | 同一设备集的独立 state topic                        | 不适用                                     | 4 种代表型号获准 QoS 2；床头灯 `yeelink.light.bslamp2` 实收 offline 和 online，其余型号未验证通知 | 不从属性或目录布尔值派生 availability        |
| 独立设备事件 `siid/eiid`               | 当前无正式接入通路                                  | 规格保留事件标识，尚无事件采集通路         | 未接入                                                                                            | 不构造事件 topic 或支持结论                  |

### 已验证的代表读取范围

来源配置的 `real_device_read` 为 `scoped_verified`，范围限定为以下 4 种型号与 13 个属性地址，均使用同一已接纳 MiCloud 实例实读通过；`notify=true` 仍仅是规格声明。

| 型号                      | 已成功读取的 `siid/piid`     | 覆盖内容                     |
| ------------------------- | ---------------------------- | ---------------------------- |
| `yeelink.light.bslamp2`   | `2/1`、`2/2`、`2/3`          | 开关、亮度、色温             |
| `cgllc.airm.cgd1st`       | `3/4`、`3/8`、`3/7`、`3/1`   | PM2.5、CO₂、温度、湿度       |
| `miaomiaoce.sensor_ht.t9` | `3/1001`、`3/1002`、`2/1003` | 温度、湿度、电量             |
| `xiaomi.sensor_occupy.p1` | `2/1`、`2/5`、`2/6`          | 整体有人无人、光照、雷达开关 |

人在传感器的持续时长属性虽声明 readable，但描述标注不支持，不在已验证范围；未核实实际映射的 A/B 分区同样不在范围。BLE 类型依据设备标识和型号推定，实际网关、固件及连接链路仍未知。读取成功只证明当前条件下可取得值。

## 实机证据与使用限制

实机证据保存在 Git 忽略的 `data/verification/household-access/<run_id>/report.json`，格式见[验证与任务交接](plans/household-steps/01-device-access/reference.md#验证与任务交接)。任务 1.1 报告标记 `task_id=1.1`，记录真实选择范围、脱敏设备／能力标识、协议和客户端版本、时间、来源及采集代次、返回码、接收与丢弃数量和结论。不记录扫码材料、Cookie、serviceToken、ssecurity 或完整供应商报文。

实机读取复用正式 `MijiaService`；使用独立 Bun 执行入口验收时，先暂停常驻 backend，避免两个账号所有者同时续期，并在 `finally` 关闭服务后恢复常驻 backend。不提交专用验收脚本或临时路由。没有真实证据的读取、恢复、续期、取消、退出、摄像头播放与释放场景保持未验证，不能以实现审查或编译通过代替实机结论。
