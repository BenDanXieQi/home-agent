# 米家来源契约

本文描述同一米家账号下的指定属性读取、MQTT 属性／在线推送及其恢复边界。类型化配置位于 [`source-profiles.ts`](../../apps/backend/src/mijia/properties/source-profiles.ts)，读取契约为 `miot-cloud-cache-read`，版本 `1`；`miot` 表示属性模型，不表示 OAuth 鉴权。传输使用 `micloud_rc4`，凭据类型为 `mijia_qr_session`，设备与读取绑定同一 MiCloud 账号实例。

请求依据为固定 `homebridge-miot` commit `8d27204423a569e11c468830e3df324d278954ee` 的 `MiCloud.js` 中 `miotGetProps` 与 RC4 请求实现。逐项结果语义参考 MiLoCo commit `cad239dca9b7a2dd3bf0e6565a26cf9eef6581b8` 的 `state_align.py`、`result_codes.py`；完整定位见[协议与源码依据](#协议与源码依据)。源码审查与本项目实机接入是两类证据。

同一 MiCloud 扫码会话已在 4 台代表设备的 13 项属性上取得 `code=0` 且含合法值的成功结果，覆盖灯、空气检测仪、温湿度计和人在传感器。此结论只覆盖下表型号与属性，不泛化到其他设备、网关或固件，也不证明数据新鲜度、MQTT 或长期恢复能力。

## 账号与授权

`MijiaService` 是唯一账号所有者，`DeviceDiscovery` 负责供应商目录请求与原始媒体接入信息；`household/` 状态机持有已保存、提交的家庭业务目录和规格，页面与内部属性预检读取这份资料。扫码会话同时支持目录和属性请求；媒体从同一账号取得 userId/passToken/region。凭据以 `mijia` 保存在 AES-256-GCM 凭据仓库，不进入普通配置、状态快照、日志或追踪。

MiCloud 扫码登录与后端静默 OAuth 授权共同构成一个完整接入会话，由现有账号所有者统一保存、恢复、续期和退出。两类凭据准备并保存成功后才接纳账号；不接纳仅有 MiCloud 凭据的部分会话。属性读取使用当前 MiCloud 实例的 userId、serviceToken、ssecurity 与 Cookie，MQTT 使用同一会话的 OAuth token。需要重新认证时仍使用现有扫码入口，不增加独立授权页面、账号映射或第二套凭据仓库。

`account/login-flow.ts` 管理扫码尝试，`account/maintenance.ts` 管理统一会话的恢复续期任务，`account/session.ts` 准备候选会话；凭据保存、当前账号接纳及跨模块清理由 service 提交。扫码登录失败或取消只结束本次尝试；已经可用的当前账号不因候选失败被替换。

账号恢复与续期的自动任务、手动恢复入口均遵守供应商 `Retry-After`。最早重试时间尚未到达时不发起恢复或续期请求；超出单个 JavaScript 计时器范围的等待分段调度，不因计时器截断提前重试。

service 用 `invalidatePropertyReads()` 撤销当前读取范围，用 `invalidateDeviceAccess()` 一并撤销读取与 MQTT 观察；媒体按自身生命周期清理。当前会话维护读取取消信号及 `collection_generation`。会话替换、账号失效、退出或关闭撤销旧范围；旧请求及迟到结果不能进入新实例。同账号正常续期保留稳定 `source_id`，更换采集代次。go2rtc 故障只影响媒体，属性请求失败不自动切换其他协议。

### 失败范围

统一会话的认证状态与各通路的运行状态分别处理。MiCloud 或 OAuth 的会话认证失败都可使整个账号进入 `reauth_required`；不能因另一类凭据仍有效而继续以部分会话运行。

| 场景                                               | 当前处理                                                                                                                                                                                                             |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 新扫码候选的 MiCloud、OAuth 或保存失败             | 本次登录失败，不覆盖已经接纳的当前账号。                                                                                                                                                                             |
| 启动恢复返回认证失败                               | 不接纳保存的会话，进入 `reauth_required`，通过现有扫码入口重新登录。                                                                                                                                                 |
| 活动会话续期返回 MiCloud 或 OAuth 认证失败         | 撤销整个活动会话，清空目录，终止读取和观察，撤销媒体资格并尝试清理远端资源。即使另一类凭据仍有效也执行此处理。                                                                                                       |
| MQTT 连接明确拒绝 token                            | 暂停普通重连，交账号维护强制刷新；刷新成功后重建连接。刷新返回认证失败或仍得到被拒绝 token 时，按整会话认证失败处理。                                                                                                |
| 会话续期遇到网络、超时或限流                       | 保留当前账号和目录内容，目录状态标为错误；遵守退避及 `Retry-After`。已提交且未撤销的家庭范围仍可接纳读取和新观察；首次目录未提交时仍拒绝。已有观察和媒体不因此撤销。若 MQTT 已因认证拒绝暂停，则等待凭据更新后恢复。 |
| 普通 MQTT 断线、topic 订阅拒绝、单项属性或媒体故障 | 由对应通路报告并恢复，不直接判定整个会话认证失效。topic 权限拒绝触发目录刷新；刷新确认的范围撤销仍按范围生命周期处理。                                                                                               |

认证失效撤销的是当前运行会话，不等于用户退出时删除持久凭据。供应商真实认证拒绝、限流及完整跨通路清理的实机覆盖见[实机证据与使用限制](#实机证据与使用限制)；上述规则描述当前实现。

## MQTT 授权边界

固定 MiLoCo 参考版本的 `mips_cloud.py` 使用 OAuth 应用 ID 作为 MQTT username、OAuth access token 作为 password，client ID 为 `miloco:<uuid>`；`cloud.py` 的 `MIoTOAuth2Client` 通过授权码或 refresh token 获取该 token。扫码登录在后端完成 OAuth 授权，两类凭据由同一个账号所有者和加密记录管理；正式 MQTT 接入使用 MQTT.js 5.16.0。

后端使用扫码会话的 userId/passToken，经 `/pass/serviceLogin` 和 `/sts/oauth` 建立 OAuth 登录会话，读取 `/oauth2/authorize?_json=true` 的授权确认数据，再提交 `/oauth2/userAuthorization`，取得授权码并通过 `/app/v2/mico/oauth/get_token` 交换 access token 和 refresh token。该流程包含公开信息与智能家庭服务的实际权限授予，授权确认数据本身不代表已授权；不需要再次扫码或额外授权页面。`oauth2.0_serviceToken` 是登录会话 Cookie，不能作为 MQTT 密码。token 有效期以供应商响应为准。

授权参数中的 `client_id` 可能以超过 JavaScript 安全整数范围的 JSON 数字返回，必须保留原始精度；普通 JSON 数字解析后再提交会导致签名不一致。正式账号记录同时保存 MiCloud 与 OAuth 凭据；refresh token 续期由账号维护流程负责。

OAuth 与 MQTT 使用同一个实例 UUID：OAuth 的 `device_id=mico.<uuid>`，MQTT 的 `client_id=miloco:<uuid>`。UUID 遵循 MiLoCo `manager.py` 的 `uuid.uuid4().hex` 格式，为不带连字符的 32 位十六进制字符串。当前支持该格式和已验证的 MiLoCo 应用参数，可连接 `cn-ha.mqtt.io.mi.com:8883`；服务端具体校验实现未知。

已验证当前账号及 MiLoCo 参考应用参数下的后端授权、token 交换与 MQTT 连接。正式内部观察入口已验证代表设备的订阅确认、属性变化与同值上报，以及断线后的自动重连、活动订阅恢复和 OAuth 更新后的重建。Home Agent 自有应用准入及供应商真实认证拒绝仍未验证；设备在线通知的实机范围见下文。

## 正式推送入口

`MijiaService.observeDevices(deviceIds, onObservation, signal)` 校验当前账号、所选家庭和目录中的明确设备集合，按需创建一个 MQTT 采集实例。多个观察者共用连接与 topic，通过引用计数对账；返回 `cancel()`、`snapshot()` 和 `retry()`。`snapshot()` 提供逐 topic 的期望、确认、在途、获准 QoS、失败原因及接收／丢弃计数；`retry()` 只重试临时失败，包括配额不足等临时 SUBACK 拒绝，不反复尝试权限、topic 或能力不支持等永久拒绝。新 topic 权限拒绝通知账号所有者刷新目录一次，不将 ACL 拒绝误判为 token 失效；永久拒绝跨断线保留，直到授权条件变化。临时拒绝保留原始原因码，等待显式重试或重连，不立即循环订阅。

观察入口本身不自动选择全家庭，不提交家庭 latest 或 availability。设备上报日志通过独立的限时诊断采样调用此入口，并向页面提供 MQTT 记录；诊断日志没有接入家庭实时状态，使用方式见[米家业务](../mijia.md)。

设备目录由 `DeviceDiscovery` 维护所选家庭的派生索引，目录更新、家庭选择和清除时同步更新。新观察在接纳前校验完整设备集合；消息交付检查账号仍活动、取消信号及作用域代次，不逐条扫描目录。目录刷新中的 `loading` 或临时错误不撤销已接纳观察；成功目录更新确认设备移除、归属／型号／规格变化时才撤销对应作用域。同账号续期期间排队的观察使用稳定来源身份和出队后的当前 OAuth 凭据。

`protocols/miot/mqtt.ts` 负责 MQTT 5/TLS 连接、订阅与取消，`messages.ts` 校验和规范化属性及在线消息。连接使用 clean start、60 秒 keepalive 和 15 秒 CONNACK 期限；关闭 MQTT.js 的自动重连和重订（`reconnectPeriod=0`、`resubscribe=false`），恢复由账号观察所有者统一管理。每设备请求 QoS 2 的 `device/{did}/up/properties_changed/#` 和 `device/{did}/state/#`；两类 topic 独立接受 QoS 0/1/2 的 SUBACK，连接成功不代替订阅确认。在途操作共用 16 个名额、确认期限 10 秒。订阅确认超时或退订失败／超时关闭当前连接代次，释放 MQTT.js 未确认请求，再由账号观察所有者按既有退避恢复活动订阅。迟到确认不能复活旧代次；单项 SUBACK 明确拒绝仍按其临时或永久原因处理。

消息回调先于订阅注册。只交付当前实例内仍被观察的设备消息，不等待 SUBACK，也不把消息到达视为订阅成功。属性校验 method、did、siid/piid 和显式存在的 JSON 标量 value；params 支持对象或数组，单项属性与 topic 中地址交叉校验，不按 notify 白名单裁剪。同值上报保留。在线消息仅识别 online/offline 叶子。带 `/`、MQTT 通配符、空格、NUL 或空标识的设备报告 `unsupported_device_id`，不猜测转义规则。

观测包含稳定 `source_id`、实例 `collection_generation`、真实 `received_at`、`observed_at=null`、`source_event_id=null` 和 `source_sequence=null`。正常消息按 live 交付，MQTT retained 消息按 baseline；不承诺设备采样时间、跨消息顺序、无断线重放或端到端恰好一次。独立 `siid/eiid` 事件未启用。

账号退出、账号身份替换、家庭切换和目录归属／型号／规格变化使当前实例失效；取消移除对应回调，最后一个观察者退出某 topic 时退订。普通连接或订阅局部失败不会直接关闭媒体；统一会话认证失效按[失败范围](#失败范围)撤销全部接入资源。断连只结束当前 MQTT 连接代次，`account/observations.ts` 保留仍然活动的观察集合，用单一计时器按 1、2、4…120 秒退避重连，连接成功重置为 1 秒，重建后重新取得逐 topic SUBACK。

每次连接从账号所有者读取最新 OAuth 凭据；明确认证拒绝停止普通重试并交回账号维护，强制刷新被拒绝的 OAuth token，不因其本地有效期尚未到期而复用；在途续期和 Retry-After 等待保留该拒绝状态，刷新返回认证失败或仍返回被拒绝 token 时使整个接入会话进入重新认证。连接初始化异常按取消、认证和其他故障区分，脱敏原因保留在观察快照与 tracing 中。

最后一个观察（含目录通知）取消时关闭连接并清除定时器，当前账号作用域内的永久订阅拒绝仍保留；账号退出或作用域撤销时清除这些记录。空闲时凭据更新仅清除旧拒绝和认证错误，不建立连接。同账号会话续期成功且范围未变时不撤销观察；OAuth token 改变时重建连接，其他账号／家庭范围撤销仍会终止观察。没有自动补读或家庭状态恢复。应用持有一份业务目录，MQTT 只保存派生的订阅集合。

## 目录变化通知

账号后台目录维护与属性观察复用同一 MQTT 连接。使用精确主题 `user/{uid}/g_op/bind`、`unbind` 和 `device/{did}/g_op/rename`、`hr_change`；目录设备主题覆盖账号可见设备，以发现跨家庭移入。它们不进入属性观测，也不绕过业务家庭限制。通知仅触发 5 秒防抖后的完整目录读取，实际归属以本次云目录校验和提交为准，不依赖未文档化载荷。

主题仍须收到成功 SUBACK。重连后重新订阅并同步目录，既有 5 分钟目录发现继续补漏。只读 `/api/mijia/directory/push` 提供脱敏的连接、订阅与通知统计；收到主题通知不等于已经保存成功，保存结果通过家庭公共状态报告。

## 正式读取入口

[`MijiaService.readProperties(properties, signal)`](../../apps/backend/src/mijia/service.ts) 接收 `readonly { did, siid, piid }[]` 与 `AbortSignal`，返回逐项 `PropertyReadObservation[]`。账号由 service 取得，调用方不提供凭据。设备必须属于当前账号完整成功同步的目录，属性必须属于该设备的 readable 规格。目录的 `online` 布尔值不作为读取禁令。规格由家庭模块按活动 model／URN 分组共享和准备，属性预检只读已准备能力。协议客户端内相同元数据在途请求合并，各调用者保留独立的取消信号及 30 秒预算，最后一位等待者取消才终止共享传输。规格的能力定义独立于展示翻译：翻译失败或耗尽元数据网络预算时沿用已取得的规格原文，不把已确认可读的属性判为不可读；能力请求自身超时、调用方取消、账号撤销或调用方自身期限到达仍会终止查询。

请求前、规格预检后、批次执行前及异步返回前均检查当前账号、采集实例和目录归属；设备移除、家庭归属／型号／规格引用变化、会话撤销、调用取消或账号失效会拒绝旧结果。此入口只允许读取已选业务家庭的设备，不修改家庭选择，不维护 latest、availability 或属性版本，也不提交家庭状态。

[`preparePropertyRead`](../../apps/backend/src/mijia/properties/read-request.ts) 复制属性请求，按设备分组，同步读取家庭模块已准备的规格并逐设备验证其属性；保留原输入顺序，通过 service 提供的断言核验当前账号、采集实例和目录归属，再交给 [`PropertyReader`](../../apps/backend/src/mijia/properties/reader.ts) 使用全局串行 HTTP 批次预算。

属性读取仅提供内部入口，没有属性读取 HTTP 路由或周期读取任务。现有 `/devices/refresh` 按 target 刷新设备目录、规格或两者；扫码授权和连接状态继续使用[现有米家业务接口](../mijia.md#http-与追踪)。

## 编码、预算与逐项结果

[`MiCloud.getProperties`](../../apps/backend/src/mijia/protocols/micloud/client.ts) 通过现有认证与 RC4 请求发送 POST `https://api.io.mi.com/app/miotspec/prop/get`，加密的 `data` 内容为 `{"datasource":1,"params":[{"did":"…","siid":2,"piid":1}]}`。Cookie、签名和加密材料均取自当前已接纳的扫码会话，不使用 OAuth Bearer 或另一套 HTTP 客户端。

`datasource=1` 是缓存优先：缓存缺失时可能触发设备 RPC，不能保证拿到最新值。本项目不依据一次响应猜测其是否实际触达设备，统一保守输出 `read_semantics=cloud_cache`、`delivery_kind=baseline` 和 `observed_at=null`；不能称为纯缓存请求或实时设备观测。供应商说明见 [MIoT Plugin SDK 的 getPropertiesValue](https://github.com/MiEcosystem/miot-plugin-sdk/wiki/04-miot_spec#ispecgetpropertiesvalueparams-datasource--promisejson)。

同一 service 的所有读取共用一个 `PropertyReader`，批次串行、每批最多 150 项、单次 HTTP 最长 30 秒且覆盖响应体读取；该期限不包括预检、排队或多批次总耗时。这些是 [`protocols/micloud/properties.ts`](../../apps/backend/src/mijia/protocols/micloud/properties.ts) 定义的应用预算，不是已证明的小米硬上限。没有隐藏属性请求重试；调用方取消可提前终止排队和在途请求。取消中的请求实际结束前仍占用唯一在途名额。

reader 按稳定 `source_id` 保存供应商 `Retry-After` 期限；同账号会话续期不会绕过它。期限内的后续批次和新读取不发出 HTTP 请求，直接逐项返回 `unavailable/request_failed`，`read_started_at=null`，`received_at` 沿用原失败的接收时刻。reader 不 sleep 等待，也不在期限结束后自动重试；到期后须由下一次显式读取发起请求。

每条响应须有合法 did/siid/piid，并精确匹配本批请求地址。批外地址和无效标识被丢弃。只在整数负码不属于 `{0, -702000000, -702010000}` 时判该项 `failure`；正码、非整数或缺失 code 不直接判设备失败。外层 RPC 成功不代替逐项校验。该返回码分类只用于属性读取，不能套用到扫码认证响应或 MQTT SUBACK。

| `status`                         | 条件与结果                                                                                                                               |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `success`                        | 返回码未判失败，且包含合法 JSON scalar `value`：字符串、有限数值、布尔值或显式 `null`；不接受对象／数组，不补造值                        |
| `failure`                        | 整数普通失败负码；保留数值 `code`，不输出 `value`                                                                                        |
| `unavailable`                    | `response_missing`、`value_missing` 或 `invalid_value`；无可用值，不把缺失转换为 `null`                                                  |
| `unavailable` + `request_failed` | 批次传输／协议失败；`error.kind` 为静态 `MiCloudError.code`，可含 `http_status`、`upstream_code`、`retry_after_at`，不保留供应商自由文本 |

一项或一个批次失败不清除其他已取得的成功项，同地址重复失败行也不能覆盖成功值。认证被拒绝后，本次调用停止后续 HTTP 批次，未发出的项标记为 unavailable；此前成功项和逐项失败仍原样交付。service 触发现有账号维护流程在后台续期，不重发本次属性请求。若并发续期、退出或账号变化已经使当前采集范围失效，则拒绝该旧实例结果；会话恢复失败沿现有账号失败处理。

## 来源、时间与恢复语义

属性读取结果含 `contract_id`、`contract_version`、`source_id`、`collection_generation` 及属性地址。读取的 `source_id` 从供应商账号、`cn` 区域和 `micloud_rc4` 通路确定性派生；MQTT 使用同一账号与区域、`miot_mqtt` 通路分别派生来源 ID。两者均不暴露原始账号 ID，也不随同账号会话续期改变。读取的 `collection_generation` 由 service 分配，MQTT 由每个连接实例分配；会话替换／撤销或连接重建后，失效代次的结果、消息和确认不得进入新代次。

以下字段表描述属性读取。MQTT 属性与在线观测使用 `source_id`、`collection_generation`、`received_at` 及前述交付字段，不附带读取契约 ID、版本或 `read_started_at`。

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

规格声明、读取成功、订阅确认、实际收包和具体型号适用性分别记录；临时网络失败不能转成永久不支持。来源配置按账号绑定、区域、凭据、通路、型号／规格及影响通路的网关／固件条件复用，同条件新设备不需要逐台或逐次重启重新审批；当前实例仍须取得订阅确认并校验消息。出现条件不匹配或反证时，只撤销受影响的能力保证。Markdown 保存依据和限制，运行时使用类型化配置。

| 契约／能力                             | 身份与适用条件                                      | 规格声明                                   | 本项目证据                                                                                        | 结论与限制                                   |
| -------------------------------------- | --------------------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| `miot-cloud-cache-read` v1：同账号读取 | 当前已接纳 MiCloud 扫码实例、`cn`、同一目录中的设备 | 实际属性必须 readable                      | 同一已保存扫码会话恢复后，正式入口 4 台／13 项全部成功                                            | HTTP 使用 MiCloud；完整会话仍须含 OAuth，目录可读不代替属性可读 |
| 代表设备类型                           | 灯、空气检测仪、温湿度计、人在传感器                | 已从实际规格选取布尔、枚举、整数及浮点属性 | 下表列出的型号与属性已实读成功；其余保持未验证                                                    | 范围及真实标识只记录于本机材料               |
| 拓扑／网关／固件条件                   | 依据实际接入条件限定                                | 正式目录／规格没有提供实际网关和固件       | BLE 类型可由设备标识与型号作为推定依据；实际网关、链路及固件未知                                  | 不从 online、型号或数字 did 推断实际直连路径 |
| 属性推送 `siid/piid`                   | 同账号统一保存的 OAuth 凭据及所选家庭目录           | notify 仅是规格声明                        | 4 种代表型号的 topic 获准 QoS 2；灯、空气检测仪、人在传感器收到属性                               | 已接入；温湿度计实际推送未验证               |
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

## 协议与源码依据

MiLoCo 只读 checkout 由仓库 `AGENTS.local.md` 指定，下列路径均相对于该 checkout，基准为 `cad239dca9b7a2dd3bf0e6565a26cf9eef6581b8`。本项目采用其属性与 MQTT 协议语义，账号入口、家庭目录与状态提交仍由本项目的领域所有者管理；模块职责见[设备接入代码参考](device-access-code-reference.md)。

| 依据 | 源码位置及用途 |
| --- | --- |
| MiCloud 属性请求 | `homebridge-miot` commit `8d27204423a569e11c468830e3df324d278954ee` 的 `lib/protocol/MiCloud.js`：`miotGetProps`、RC4 请求；`lib/utils/CustomCryptRC4.js`：加密实现 |
| 逐项结果语义 | MiLoCo `backend/miloco/src/miloco/miot/result_codes.py`：`is_failure`、`_MIOT_OK_CODES`；`backend/miloco/src/miloco/miot/state_align.py`：`_read_values` |
| OAuth 与实例身份 | MiLoCo `backend/miot/src/miot/cloud.py`：`MIoTOAuth2Client`；`backend/miloco/src/miloco/manager.py`：`uuid.uuid4().hex` |
| MQTT 鉴权与连接 | MiLoCo `backend/miot/src/miot/mips_cloud.py`：`MIoTMipsCloud`、`_default_client_factory`、`init_async` |
| 属性与在线解码 | 同文件的 `sub_device_props_async`、`_make_device_props_decoder`、`sub_device_state_async`、`_make_device_state_decoder`；回调时间来自本机 `_now_ms()`，不是设备时间 |
| 订阅确认与恢复 | 同文件的 `_subscribe_async`、`_on_connect`；`backend/miot/src/miot/client.py` 的 `_replay_subscriptions`；`backend/miloco/src/miloco/miot/client.py` 的 `_reconcile_subscriptions`、`is_subscribable_did` |
| 传输与状态提交边界 | `backend/miloco/src/miloco/miot/state_push.py`：`IotPushWriter.on_device_props` 在状态写入前检查 `scope_is_aligned()`；传输层早到消息分发不等于家庭状态已经接纳 |

MiLoCo 的对账与 SDK 重放各使用 16 的并发限制，本项目以单一 MQTT 适配器共用 16 个在途名额，不将此组织方式表述为 MiLoCo 的全局限流。MiLoCo 在账号级属性订阅后的写入阶段过滤家庭，本项目在接纳观察时限制明确的当前家庭设备集合；目录变化通知仍覆盖账号可见设备。`mips_cloud.py`、`client.py` 与 `state_push.py` 没有独立 `event_occured` 的订阅、解码和消费链，类型或注释中的事件标识不构成接入证据。

相同值不是消息身份，本地 `packet_id` 和 MQTT 报文标识均不提供跨连接的业务事件身份。正常推送的 `live` 分类是本项目运行语义，不是设备即时采样、零延迟或供应商从不补发的保证。当前适配器只区分正常推送 `live` 与 retained `baseline`，没有历史重放识别机制；读取始终为 `baseline`。接收时间不能写成设备事件发生时间，几次顺序正确或未重复的接收记录也不能证明永久有序或恰好一次。

## 实机证据与使用限制

下表汇总现有证据的适用范围，读取型号和属性地址以[来源能力矩阵](#来源能力矩阵)为准。协议源码审查、实现审查、确定性验证和本项目实机结果分别记录；局部能力通过不能扩大为全部通路的联合生命周期通过。

| 能力 | 已有实机证据 | 未验证限制 |
| --- | --- | --- |
| 保存账号恢复与目录 | 原账号恢复、家庭及设备目录同步 | 跨账号扫码替换及旧账号资源联合清理 |
| 逐项读取失败隔离 | 同批普通失败负码与成功项并存 | 接受类负码、非失败码缺值的真实供应商样本 |
| 同账号续期 | 正式续期后旧读取实例拒用、新实例读取成功；MiCloud 续期保留活动观察；主动刷新 OAuth 后凭据持久化、MQTT 重建并恢复订阅和消息 | 自然定时触发；供应商真实拒绝 token 后的强制刷新；MiCloud／OAuth 真实认证失败后的整会话撤销；认证恢复中的 `Retry-After` 等待 |
| MQTT 断线恢复 | 真实 TCP 中断后重新连接、确认代表设备订阅并继续收包；同值上报保留；多个观察者共享 topic；取消最后一个观察可结束待执行重连 | 自然连续故障中的退避递增上限和恢复行为；所有供应商异常及网络竞态组合 |
| 进程重启 | 新进程恢复持久化账号后重新订阅、收包并显式读取代表属性 | 媒体及完整跨通路联合恢复；断线期间设备变化的完整性 |
| 取消及关闭 | 正式读取取消，退出／关闭期间在途读取撤销；正式观察取消后订阅和观察集合清空 | 精确取消竞态、迟到确认等所有分支的实机覆盖 |
| 超时与限流 | 调用方期限终止真实云请求、go2rtc 默认超时 | 云属性请求自然耗尽默认 30 秒；供应商真实限流 |
| 摄像头播放及释放 | C700 单摄、C500 双摄出帧；C500 两镜头共享物理连接并独立释放 | 离线摄像头、其他型号取流、跨机器连接共享 |
| 退出与媒体清理 | 授权删除、目录清空、播放资源撤销；go2rtc 故障后的清理重试 | 退出、跨账号替换、设备访问撤销和旧账号清理的完整联合验收；供应商全部异常组合 |
| 局部故障与临时续期失败 | 各通路已有上述独立证据，运行行为见[失败范围](#失败范围) | 属性读取、MQTT、go2rtc 非会话认证类故障隔离的完整联合覆盖；续期临时失败下的目录和新请求限制与摄像头出帧、释放及重试的联合覆盖 |

Home Agent 自有应用准入、温湿度计实际属性推送、床头灯以外型号的实际在线／离线通知，以及实际网关、链路和固件仍未验证。早到消息、错误 payload、迟到确认、部分成功和实例隔离的确定性验证不能替代供应商真实故障样本。连接恢复、客户端取消和显式读取成功均不代表家庭 latest、availability 或状态已恢复。

## 验证规范

实机验证复用正式 `MijiaService.readProperties` 与 `observeDevices`。从当前账号完整保存并提交的家庭目录中，由操作者选择或授权代理选择代表设备与属性；等待目录及目标规格就绪，不自动选择第一个家庭或改动既有家庭选择。独立 Bun 执行入口需先暂停常驻 backend，装配相同账号所有者、家庭运行时和加密凭据存储；在 `finally` 撤销观察、关闭服务后恢复常驻 backend，避免两个进程同时续期或使用同一 MQTT 实例 ID。接收方只记录消息、确认和时间，不维护业务 latest、推导在线状态或参与自动化。不提交专用验收脚本、临时 HTTP 路由或未经明确授权的测试。

证据保存在 Git 忽略的 `data/verification/household-access/<run_id>/report.json`，`run_id` 为 UUID。报告顶层记录 `run_id`、`started_at`、`finished_at`、`adapter_version`、实际锁定的客户端版本与 `cases`，以及对应验证任务标识；每个 case 记录契约条目、选择范围、设备／能力标识、前置条件、操作、预期与实际结果、来源和采集代次、起止时间、返回码或 SUBACK、接收与丢弃数量、证据类型及通过／未通过／未验证／不适用结论。真实 `home_id`、`did`、属性地址及逐次结果只保留于本机报告，共享契约仅维护脱敏的协议结论、型号条件和限制。

报告记录目录归属核验的方法和结论，不记录扫码材料、Cookie、serviceToken、ssecurity 或完整供应商报文。没有真实证据的场景保持未验证，不能以模拟数据、实现审查、类型检查或构建通过补齐。
