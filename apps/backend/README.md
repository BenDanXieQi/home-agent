# Backend

基于 Hono + Bun，负责 Web 静态托管、来源接入、家庭设备清单、成员与感知、语音请求判断和聊天转发。语音模块直接调用模型；单次聊天由独立 [Agent](../agent/README.md) 执行。基础检测不依赖 Agent 在线。

当前支持原生属性持续采集、带有效性的当前值与房间事实查询、设备状态历史保存与只读查询，以及成员资料、参考身份关联与可修订的成员出现记录。已有数据通过[Agent 专用通路](#agent-当前数据与历史)持续交付，历史支持设备报告、成员出现和整体音视频窗口；当前位置、通用活动识别与可执行要求管理尚未实现。本文仅说明当前后端实现；设备历史与 Agent 长期记忆不是同一层能力。

本地检测的接口、配置和验证范围见[感知功能说明](../../docs/perception.md)。人体外观跟踪、猫狗位置跟踪、可选的轨迹人物身份分析、音频分析、可选本地语音转写、短时语音交付和语音请求判断及窗口筛选、历史语音与人物判断、自动回看及按需媒体已接入；家庭权威身份接纳与音视频语义理解仍按[摄像头计划](../../docs/plans/media-perception.md)实施。

## 运行

先按[项目 README](../../README.md)安装依赖并配置根目录 `.env`。以下命令均在仓库根目录执行：

```sh
bun run --cwd apps/backend dev  # 单独启动 backend
bun run dev         # 等待 Docker 依赖就绪，再启动 Web、backend 和 Agent
bun run start       # 构建后启动 backend 和 Agent，提供页面与 API
```

开发模式由 nodemon 监听 `src/`、共享 API、模型与观测包源码及根目录 `.env`。修改后发送 SIGTERM 并等待旧后端退出，再启动新的 Bun 进程；音视频分析子进程随旧后端结束，文件句柄不会跨重载保留。监听范围不包括依赖、构建产物和运行时媒体文件。

默认监听 `http://127.0.0.1:3000`，通过 `BACKEND_HOST`、`BACKEND_PORT` 调整。配置、服务检查、米家和聊天接口同时验证 TCP 对端为 loopback 及 Host／Origin 为允许的本机地址；调整监听地址不会放宽访问限制。当前仅供可信本机使用，尚无用户认证。构建产物需要 workspace 与已安装的依赖。

服务关闭会等待各资源分别完成清理；任一清理失败或总期限到达时强制断开活动连接，再关闭数据库与追踪资源。活动写入在同一期限内完成收尾；超时取消等待中的写入并使未完成事务失效，随后立即启动家庭连接、采集任务和计时器清理。清理失败保留为关闭错误，不因另一个任务提前失败而取消强制断连。

## 静态文件服务

`src/web/routes.ts` 仅处理生产 Web 构建产物。浏览器声明支持对应格式时，优先返回构建生成的 Brotli 或 gzip 副本；未选择压缩格式时返回原文件。响应使用 `Vary: Accept-Encoding` 区分传输格式。

`/assets/` 下名称含构建哈希的已存在资源设置 `Cache-Control: public, max-age=31536000, immutable`，允许缓存一年；文件内容变化时构建会生成新 URL。HTML 及无哈希的公共文件使用 `Cache-Control: no-cache`，允许保存但每次使用前需重新验证。ETag 是内容标识；浏览器提交相同标识时返回无响应体的 304，避免重复下载。页面深链沿用 HTML 回退，缺失资源返回 404，不作为可长期缓存的资源。

该策略只作用于静态文件，不进入 API、SSE（服务端事件流）和视频流处理。部署时需一起更新 Web 原文件与压缩副本。

## 接口

| 接口                                                | 职责                                                                                |
| --------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `GET /api/health`                                   | backend 存活状态，不检查外围服务或数据库                                            |
| `POST /api/spatial/*`                               | 空间、通道与观测绑定的读取和维护，见[空间关系资料](#空间关系资料)                   |
| `GET /api/config`                                   | 读取连接配置及可写状态                                                              |
| `PUT /api/config`                                   | 校验并保存完整连接配置                                                              |
| `GET /api/services/status`                          | 检查 Agent 与 go2rtc 的接口是否可用                                                 |
| `POST /api/chat`                                    | 向 Agent 转发单条消息并校验 JSON 回答，不保存会话                                   |
| `GET /api/agent/context/stream`                     | 向 Agent 推送当前家庭、设备状态、成员、出现记录和整体感知数据                       |
| `POST /api/agent/context/history`                   | 按区间与对象读取设备报告、成员出现或仍保留的完整感知窗口                            |
| `GET /api/perception`                               | 本地检测、人宠跟踪、人物身份与音频的健康及最新观测                                  |
| `GET /api/perception/stream`                        | 订阅本地感知当前状态，不传输媒体片段                                                |
| `POST /api/perception/images/detect`                | 接收图片字节并返回该输入的检测结果，复用共享池                                      |
| `GET /api/perception/windows`                       | 按 `scopeEpoch`、`deviceId`、`channel` 查询轻量窗口列表及全局媒体资源用量           |
| `POST /api/perception/windows/:id/media`            | 显式申请窗口媒体表示，状态查询与读取见[窗口接口](../../docs/perception.md#本机接口) |
| `POST /api/mijia/recordings/availability`           | 按当前来源查询最多 25 个观察时刻是否有覆盖该时间的 SD 录像，不下载文件              |
| `PUT/GET/DELETE /api/mijia/recordings/playback/:id` | 申请、查询或释放经校验的 SD 卡回放资源                                              |
| `GET/HEAD /api/mijia/recordings/playback/:id/media` | 受控 MP4 读取，支持单段字节范围请求                                                 |
| `GET /api/perception/speech`                        | 有界语音片段与逐段判断状态                                                          |
| `GET /api/perception/speech/stream`                 | 订阅同一语音收件箱                                                                  |
| `POST /api/perception/retry`                        | 显式重试检测与音频计算，重新准入失败音轨                                            |

`GET /api/perception`、`/stream` 及 `/retry` 共用 `perceptionSnapshotSchema` 投影公共当前视图：`source.identity` 保留当前身份判断摘要，省略内部 `recent` 和 `tracks[].evidence`，完整当前成员归因依据统一由 `source.associations` 提供。完整 `identityObservationSchema`、内部观测存储及 `service.snapshot()` 仍保留支持证据与有界结束摘要，供匹配、撤销及人宠终态核对，不作为实时公开历史。

窗口详情的 `speech.segments` 保存关联转写，`frames[].identity` 保存采样帧当时的身份判断，`sampledMedia` 表示 backend 生成的采样产物。迟到转写只更新窗口历史与版本，不改写帧身份或重新编码媒体；声音与人物标签不构成说话人身份识别。

SD 卡回放由 `mijia/recordings/` 拥有申请规则、来源授权、录像生成与对外状态；窗口和 SD 回放各自使用 `src/media/resources.ts` 的独立实例管理队列、文件、容量预留、期限、读取和清理。两者的预算与队列不混用，SD 下载不会占用窗口编码名额。`mijia/media/recording-file.ts` 负责内部传输边界，`recordings/media.ts` 使用现有媒体库处理容器与编码，`src/media/ffmpeg.ts` 统一进程执行与退出等待；`recordings/alignment.ts` 保持帧匹配规则独立于 HTTP 和文件存储。接口、容量、取消与验证边界见 [SD 卡录像回放](../../docs/mijia.md#sd-卡录像读取与回放)。

图片上传接口只要求本机访问及模型可用，不要求家庭或媒体就绪；输入限额、临时文件、等待与共享计算行为见[图片上传分析](../../docs/perception.md#独立图片上传分析)。`perception/image-upload.ts` 负责 HTTP 字节与临时输入，感知服务按需准备、复用和恢复已有检测池，视频禁用不阻止图片计算恢复。

连接地址来自根目录 `config/config.yaml`，每次请求重新读取文件，内容未变时复用解析结果。配置生成、编辑和 `--config` 用法见[本地运行](../../docs/running.md#服务连接)。

`/api/mijia` 提供扫码、验证码提交、授权恢复与退出、家庭设备清单和状态订阅、按镜头预留观看连接及 SDP 信令；沿用本机管理限制。统一重试连接返回 HTTP 202，由 `/api/mijia/events` 的 SSE 展示后台进展；`/api/mijia/state` 提供诊断快照。这里的公共状态指供页面读取、且不含凭据的信息。`src/credentials/` 负责通用 AES-256-GCM 凭据存储，`src/mijia/service.ts` 管理当前 MiCloud 与 OAuth 完整账号会话、读取和观察范围，并按顺序协调凭据保存和资源清理。`account/login-flow.ts` 管理独立扫码尝试，`account/maintenance.ts` 管理账号恢复续期任务；`account/session.ts` 准备新会话，service 保存成功后才启用它。

家庭运行时保存已生效的设备清单与完整规格，通过 Web 公共 SSE 提供固定家庭、房间、设备与规格摘要，Agent 专用通路另交付完整规格。设备清单包括家庭、房间、设备及其归属信息。`DeviceDiscovery` 获取完整云端清单，并据此生成可访问设备索引；完整云端清单确认并更新到状态机后允许访问设备，缓存保存失败只报告降级。家庭模块按活动 model／URN 共享规格，后台最多三组并发准备；属性读取前只检查已准备的能力。规格协议请求不携带账号凭据，不包含当前属性值，也不执行设备动作。详见[家庭、房间与设备能力](../../docs/mijia.md#家庭房间与设备能力)。

米家账号以扫码为唯一用户登录入口，backend 复用扫码身份静默完成 OAuth 授权。MiCloud 与 OAuth 共同构成完整接入会话，由 `MijiaService` 统一负责保存、恢复、续期和退出。新会话必须符合持久家庭绑定，完成授权并保存成功后才采用，OAuth 失败不覆盖现有账号；活动会话续期最终认证失败则撤销整个账号的设备清单、读取、观察和媒体访问，进入重新认证状态。MQTT 连接认证拒绝先交账号维护强制刷新 token；普通网络、限流及单 topic 权限拒绝不直接等价于整账号失效。完整生命周期见[授权与配置](../../docs/mijia.md#授权与配置)。

`MijiaService.readProperties(properties, signal)` 直接使用当前中国大陆区 MiCloud 会话，由 service 核验账号、所选家庭归属及读取运行标识；该标识用于排除会话更新前的旧读取结果。`properties/read-request.ts` 按设备分组检查 readable 规格；所有调用共用 `PropertyReader` 的串行批次。返回逐项 `baseline`／`cloud_cache` 观测，保留部分成功和原始返回码语义；缓存读取不保证最新值，`Retry-After` 约束后续批次与新读取。应用层通过 `POST /api/mijia/properties/read` 提供一次性读取，不做周期属性轮询。

`MijiaService.observeDevices(deviceIds, onObservation, signal)` 使用同一账号保存的 OAuth 凭据，按所选家庭内显式指定的设备提供 MQTT 属性与在线观察。`AccountObservations` 管理活动观察和重连，`MiotMqtt` 管理单次连接、共享 topic 与逐 topic 订阅确认；断线后恢复活动订阅，设备清单变化通知与属性观察共享连接，取消全部观察（含设备清单变化通知）后停止连接与计时器。家庭采集模块消费该入口，家庭运行时提交 `latest` 与有效在线状态，历史服务保存已接纳报告。采集范围、必要补读与房间查询见[设备事实与房间快照](../../docs/contracts/device-facts.md)。独立设备事件尚未接入。读取、推送的协议契约及已验证范围见[米家来源契约](../../docs/contracts/mijia.md)。

`CameraSourceManager` 管理摄像头共享流的规格、注册、重试、离线保留与释放；实际连接摄像头、接收视频和维持常驻消费者由 go2rtc 执行。`PlaybackManager` 管理播放预留、协商结果和观看资源释放，实际 WebRTC 连接位于 go2rtc 与浏览器之间。浏览器预览视频不经过 backend；本地感知另从 go2rtc 私有分析出口读取视频，在 backend 的计算子进程内解码。官方能力列表声明为双摄的设备，其两个镜头的共享流在 go2rtc 内复用一个物理 MISS 连接，backend 根据小米官方通道能力列表生成通道列表，并通过 `channelCount` 将能力传给 Go；Go 不按具体型号选择双摄分支。backend 仍分别管理各镜头的源与播放资源；关闭一路观看不会关闭另一镜头的连接。

`AccountMaintenance` 调度完整账号会话的恢复续期，通过回调交由 `MijiaService` 保存并启用新会话。`DeviceDiscovery` 维护设备快照、合并并发刷新与周期设备发现，`MediaSession` 维护 go2rtc 地址巡检、绑定重试、媒体运行标识和相机／观看资源；`Go2RtcAdapter` 维护独立的 go2rtc 运行时会话和心跳租约。米家会话续期与 go2rtc 租约续期是两种不同操作。媒体运行标识 `revision` 在媒体失效或重新绑定时更换，用于拒绝旧播放请求；它不用于配置并发修改检测。源注册失败的重试由 `CameraSourceManager` 管理，媒体收包监测和取流恢复由 go2rtc 管理，网页出帧检测由浏览器管理。

`mijia/perception-source.ts` 将当前已提交的家庭与设备访问资格交给感知模块，同一家庭快照复用来源访问表，快照或家庭运行状态变化后重建。历史窗口查询不重复遍历设备清单或克隆米家状态；每次访问仍检查当前家庭快照。媒体连接的运行标识只在准备实时采集时核对，其失效信号结束对应采集；已保存片段的访问期限与撤权规则见[感知媒体说明](../../docs/perception.md#容量停止与访问期限)。

米家协议适配位于 `src/mijia/protocols/`：`micloud/` 负责扫码、设备清单与属性读取，`oauth/` 负责授权及 token 续期，`miot/` 负责 MQTT 连接与消息解析。下游通过 `src/mijia/media/go2rtc-adapter.ts` 调用 go2rtc 内部接口。资源定义、状态含义与释放规则见[米家与摄像头](../../docs/mijia.md#组件与资源)。

聊天请求最多 32 KiB，超时由 `BACKEND_REQUEST_TIMEOUT_MS` 控制，默认 130 秒；客户端取消会传递到 Agent。代理只提交本次消息，校验并返回 JSON 回答，不提供会话历史、检查点或 SSE。响应读取最多 512 KiB，非本项目格式的上游响应转换为安全错误。

收到 SIGINT/SIGTERM 后停止接收请求，最多等待 `BACKEND_SHUTDOWN_TIMEOUT_MS`（默认 30 秒），再关闭数据库与追踪资源。追踪配置与生命周期见[追踪接入](../../packages/observability/README.md)。

`POST /api/device-history/events` 为 Web 提供独立设备历史 SSE，支持实时首屏、固定区间分页与连续导出；Agent 历史的 `kind=device_reports` 分支以一次性 JSON 响应复用同一读取能力。两者共用 `household/history/read.ts` 的家庭资格、取消与读取期限，以及 `query.ts` 的游标和完整记录分页。数据库读取由已有 Postgres.js 共享连接池分配连接和调度等待；连接等待、取消与容量边界见[只读历史接口](../../docs/household-runtime.md#只读历史接口)。记录覆盖原生属性和设备在线值，支持时间、设备、类型与属性地址筛选，以及升序／降序分页。

`household/history/service.ts` 拥有接纳报告订阅与按设备有界顺序提交，事务保存成功后才通知历史流；`repository.ts` 负责按主键比较最近保存状态，在同一事务内更新状态并保存变化记录，以及按时间与游标读取历史；导出在一个查询快照内连续交付，不逐页重开事务。`live.ts` 在活动连接之间共享相同查询与已提交版本的读取，最后一个连接退出时释放资源；`stream.ts` 合并 250 毫秒内的匹配保存通知，重新读取当前首屏并交付变化记录、移出项与完整顺序；不定时轮询数据库，也不推送尚未保存的报告。`routes.ts` 负责本机访问、输入、流连接容量与关闭，家庭公共错误转换由 `household/http-errors.ts` 拥有。接口语义见[设备状态历史](../../docs/household-runtime.md#设备状态历史)，维护任务与部署限制见[数据库维护与验证限制](../../docs/household-runtime.md#数据库维护与验证限制)。

## Agent 当前数据与历史

`agent-context/service.ts` 常驻整理五部分数据：家庭、房间、设备与完整规格 `household`，空间、通道和观测绑定 `spatial`，属性报告、在线值及采集／来源状态 `device_state`，成员登记 `members`，统一观察 `observations`（成员出现、未关联成员的人宠目标、画面变化、语音与猫狗叫声，以及共用的音视频窗口依据）。`main.ts` 注入家庭运行时、成员、空间与出现记录仓库、感知服务，并在退出时停止整理；`app.ts` 挂载本机专用 `GET /api/agent/context/stream`。整理直接读取内部来源，多个连接共用监听和结果，不回读 Web API。

`agent-context/device-state.ts` 从已提交的家庭属性生成动态状态，按来源对象复用已校验记录；描述、单位和规格等静态信息由 `household` 交付。整理服务按不可变部分共享紧凑 JSON 与字节统计。`agent-context/delivery.ts` 对照每个连接最后成功发送的状态生成增量，并按已统计的全量大小选择发送正文；`stream.ts` 负责连接、清空屏障和发送完成后推进基线。Agent 与 Web 的增量合并规则共用 `packages/api`，不依赖后端运行时。

成员资料与出现记录实际新增或修订在数据库确认提交后通知；提交确认丢失时，在同一家庭绑定与成员锁内核实已保存内容，不直接重放写入。暂时不能确认时，仓库独立后台确认，间隔从 1 秒退避到最多 30 秒，每次只允许一个在途确认；期间拒绝新修改，家庭资格改变后在同锁确认原事务结束并隔离旧结果。成员通知先于参考文件清理，清理失败不会漏发已经提交的变化，无变化与回滚不通知；迟到确认回滚会恢复参考快照并清理，关闭仓库停止计时器并等待串行队列结束。感知通知覆盖窗口内容与媒体状态，迟到声音、转写更新原窗口，生成完成、失败、过期及撤销只触发刷新，不额外申请编码。每个来源最多一个在途读取，通知合并后续刷新；读取失败清空对应来源并有界退避，其他来源继续交付；统一观察的来源状态分别保留，窗口承载声音和变化线索，成员记录以 ID 关联，不推断说话人。未配置或未启用的来源保持明确的不可用状态。

统一观察推送包含索引、引用、成员出现归因修订号及轻量窗口材料摘要，成员正文与完整窗口详情保留在各自来源。`POST /api/agent/context/material` 按 scope、kind 和 ID 只读解析单个引用，校验家庭资格与响应大小，过期或移除返回 404；允许可信本机 Web 和 Agent 访问，不触发媒体生成。

`POST /api/agent/context/history` 按 `kind` 返回 `device_reports`、`member_sightings` 或 `perception_windows`。成员分支从身份仓库读取数据库当前归因，音视频分支读取当前仍有访问资格的完整窗口，保留视觉、音频、转写与媒体状态。两者支持时间和来源筛选，成员另可按成员 ID 筛选；它们独立于推送中的有界最近集合查询。协议、区间边界、分页与保留限制见[Agent 数据交付](../../docs/household-runtime.md#agent-当前数据与材料历史)，字段定义见[共享契约](../../packages/api/README.md#agent-数据交付契约)。

`GET /api/agent/receipts`、`/api/agent/receipts/:id` 与 `/api/agent/receipts/current` 将 Web 只读请求转发到配置的 Agent 服务，校验响应并限制大小与超时，沿用可信本机 Web 访问限制，不用 Backend 发布缓存替代接收结果。

Agent 启动后独立接收，不要求模型配置或聊天请求；本机 `GET /api/received-context` 供只读验收，使用方式见[Agent README](../agent/README.md)。推送和历史仅交付已有来源材料与引用，凭据、参考照片、特征向量及媒体字节不进入该通路；没有接入模型工具、默认模型输入或语义回写。专用通路的真实来源比对与未覆盖的故障、家庭生命周期边界见[验证边界](../../docs/household-runtime.md#agent-通路验证边界)。

## 连接配置与探测

`GET /api/config` 返回 `{ config, writable, path }`；`PUT /api/config` 接收完整配置 JSON（最多 16 KiB），保存后返回同一结构。字段、默认值、运行时校验与编辑器 schema 来自 `packages/api/src/contracts/` 的同一套 Zod 定义。配置仓库复用内容未变的解析结果，但不跳过文件访问、大小和权限检查；写入通过 `yaml` Document API 保留注释，并由 `write-file-atomic` 原子替换。

配置错误返回 503，输入错误 400，只读或不可信来源 403，非 JSON 请求 415，超大请求 413，保存失败 500；统一响应与字段错误约定见 [API 契约](../../packages/api/README.md#错误响应)。

`GET /api/services/status` 返回 `{ services: { agent, go2rtc } }`，每项包含 `url`、`status`、`checkedAt`、`reasonCode` 和可选 `params`。每次请求直接探测 Agent `/health` 与 go2rtc `/api`，不缓存；每项限时 3 秒、响应最多 16 KiB，支持客户端取消，拒绝重定向并校验 JSON。go2rtc 响应要求 `version`、`revision`、`host` 为字符串，且 `version`、`host` 非空，允许附加字段。Web 保存时取消旧查询，避免旧结果覆盖新地址；状态轮询不覆盖未保存输入。

管理接口同时校验 TCP 对端、Host 与浏览器 Origin。对端必须是 loopback（包含 IPv4 映射的 loopback），无法取得对端信息时拒绝访问。Host 与 Origin 允许 `localhost`、`127.0.0.1`、`[::1]` 的 backend 端口及内部 Vite `5173`；backend 另显式接纳 Caddy 入口 Host `localhost:8443` 和 Origin `https://localhost:8443`，不放开该端口的 HTTP Origin 或其他域名。不信任转发头，不开放 CORS。Caddy 与 Vite 保留浏览器 Host／Origin，JSON 修改请求显式校验 Origin。Agent 不接纳 Web 入口，仅接受其配置端口对应的本机 Host／Origin。

## 目录与约定

```text
src/
├── main.ts                 # 启动、资源初始化与关闭
├── app.ts                  # 中间件、子路由与错误处理的组装
├── environment.ts          # 环境变量解析
├── media/
│   ├── resources.ts         # 媒体任务、文件、读取、容量与回收的唯一所有者
│   ├── ffmpeg.ts            # 有界进程输出、取消与退出确认
│   └── clip-files.ts        # 独占缓存目录准备及中断遗留清理
├── web/
│   └── routes.ts           # Web 预压缩文件、缓存与页面回退
├── connections/
│   ├── routes.ts           # 连接配置接口
│   ├── store.ts            # YAML 路径、校验与读写
│   └── status.ts           # 服务探测与状态接口
├── chat/
│   └── routes.ts           # 绑定家庭范围、聊天转发与流取消
├── agent-context/
│   ├── service.ts          # 常驻来源整理、分部刷新与资格隔离
│   ├── history.ts          # 成员／音视频历史的请求资格、游标与完整记录分页
│   ├── stream.ts           # 当前数据的串行 SSE 交付与家庭清空
│   └── routes.ts           # 本机 HTTP 边界与所属读取服务调用
├── mijia/
│   ├── routes.ts           # 米家 HTTP 输入、响应与取消信号
│   ├── service.ts          # 账号生命周期、凭据串行提交与跨模块协调
│   ├── operation.ts        # 米家操作 span、静态错误码与取消语义
│   ├── retry-timer.ts      # 失败工作拥有的可取消退避等待
│   ├── errors.ts           # 上游错误到公共错误码的转换
│   ├── homes/store.ts     # 按稳定账号身份持久化家庭选择
│   ├── account/
│   │   ├── login-flow.ts  # 独立扫码尝试与授权材料
│   │   ├── maintenance.ts # 完整账号恢复续期任务及计时器
│   │   ├── session.ts     # MiCloud 与 OAuth 新会话的准备
│   │   └── observations.ts # 属性与设备清单变化通知、共享连接及重连退避
│   ├── devices/
│   │   ├── discovery.ts   # 设备快照、发现任务、刷新合并与定时器
│   │   ├── directory-notifications.ts # 账号级设备清单变化通知与刷新防抖
│   │   └── mapping.ts     # 设备业务映射与摄像头识别
│   ├── properties/
│   │   ├── read-request.ts # 请求复制、按设备分组与 readable 规格预检
│   │   ├── reader.ts      # 指定属性读取、共用串行批次与取消
│   │   └── source-profiles.ts # 读取通路配置、来源身份与证据范围
│   ├── media/
│   │   ├── session.ts     # 配置巡检、媒体绑定、运行标识与资源生命周期
│   │   ├── camera-source-spec.ts    # 单路摄像头共享流规格
│   │   ├── camera-source-manager.ts # 共享流注册、重试、离线保留与释放
│   │   ├── audio-stream.ts          # 米家音轨 HTTP 接入与编码流边界转换
│   │   ├── recording-file.ts        # 有界 SD 卡文件传输与元数据校验
│   │   ├── playback-manager.ts      # 播放预约、观看资源、取消与记录回收
│   │   └── go2rtc-adapter.ts        # 专用 go2rtc 协议、心跳与超时
│   ├── recordings/
│   │   ├── service.ts     # 回放资源、准备队列、缓存预算、期限与撤权
│   │   ├── routes.ts      # 回放资源 HTTP 与受控文件读取
│   │   ├── alignment.ts   # 原帧指纹与媒体时间的对齐规则
│   │   └── media.ts       # 实际容器校验、原帧指纹与浏览器 MP4 编码
│   └── protocols/
│       ├── micloud/       # 扫码、Cookie、设备清单及 RC4 属性请求
│       │   └── properties.ts # 属性地址类型、每批数量上限及请求超时
│       ├── oauth/client.ts # 静默授权、token 交换与续期
│       └── miot/          # MQTT 单次连接、订阅与消息解析
├── household/             # 家庭状态机、设备清单存储、规格、属性采集、成员与状态 SSE
│   ├── data-lifecycle.ts   # 家庭表归属与事务内统一清理
│   ├── history/            # 属性与在线报告保存、查询准入与分页、数据库读取及历史 SSE
│   └── spatial/            # 空间资料服务、三张表的事务与引用查询、本机 HTTP 接口
├── perception/            # 本地检测、来源协调、人宠跟踪、轨迹身份证据、独立音频解码与连续 VAD、窗口筛选与按需媒体、隔离计算、当前观测与接口
│   ├── sources.ts          # 感知来源输入边界与媒体访问 IPC 契约
│   ├── source-lease.ts     # 音视频共用的来源资格撤销与取消联动
│   ├── video/              # 视频采集调度与跟踪、身份模块协作
│   ├── tracking/           # 人体与猫狗轨迹、有界原帧借用
│   ├── identity/           # 轨迹人物身份证据、判断与人脸模型适配
│   ├── audio/              # 连续分块、Silero 适配、解码与音频进程监督
│   ├── window/             # 窗口聚合、历史身份快照、覆盖判定与有限期输入
│   ├── gate/               # 场景筛选和裁切区域规则
│   ├── media/              # 媒体解码、表示参数、编码与受控读取
│   └── speech/             # 单一 VAD 结果切段、语音证据、ASR 子进程与空闲释放
├── conversation/          # 短时语音片段交付、判断状态、Agent 客户端和读取接口
├── http/                  # backend 内跨业务复用的 HTTP 传输适配
│   ├── sse-transport.ts   # 共用 SSE 有界写入、心跳、超时与取消
│   └── snapshot-stream.ts  # 当前快照 SSE、通知合并与连接容量
├── credentials/
│   ├── store.ts            # 数据库授权的认证加密与读写
│   └── key.ts              # 独立密钥文件的权限与内容校验
└── db/
    ├── index.ts            # 数据库连接
    └── schema.ts           # 业务表定义
```

按功能组织代码，子路由使用 `new Hono()` 创建，由 `app.route()` 挂载。backend 与 Agent 通过 `@home-agent/api/local-access` 复用本机访问限制；前后端数据契约位于 `packages/api/src/contracts`。设备清单条目与规格能力由 `packages/api/src/domain/devices.ts` 统一定义，米家适配器转换供应商数据，家庭规则消费领域结构。

`perception/identity/analysis.ts` 拥有单次来源运行中的人宠身份证据与判断；`runtime.ts` 协调原帧采样、证据期限和资源，`process.ts` 管理 Bun 身份子进程，`model.ts` 使用 OpenCV.js、nudged 和现有 ONNX Runtime 完成人脸处理，不依赖 Python 环境。`video/runtime.ts` 统一协调跟踪和身份模块的启停，`tracking/` 通过本帧回调交付结果与像素。跟踪完成时冻结的紧凑身份快照经 `identity_frame` 交给窗口，只接纳到准确对应帧的未关闭窗口；当前身份广播继续独立合并。窗口媒体保存、字节预算及读取权限复用 `media/window-media.ts`，身份模块只增加历史元数据。人宠轨迹仍由 `tracking/` 拥有，家庭成员资料与权威身份归家庭领域。配置与判断规则见[持续成员身份分析](../../docs/perception.md#持续成员身份分析)，历史语义及独立保留期限见[窗口中的历史身份](../../docs/perception.md#窗口中的历史身份)。

普通 TypeScript 文件和目录使用小写短横线命名，类与类型使用 PascalCase，变量和方法使用 camelCase。对外错误码使用小写下划线；上游协议的原始字段和错误标识在适配边界转换。定时器句柄使用 `*Timer`，时间戳使用 `*At`，毫秒时长使用 `*Ms`。

业务错误使用 `AppError`，HTTP 错误通过 `packages/api/src/errors` 的 Hono 处理入口输出；错误码、文案与 SSE 约定见[错误处理](../../packages/api/README.md#错误响应)。

`main.ts` 是应用级依赖的装配入口：读取环境、创建配置仓库、数据库、凭据仓库、米家服务、家庭运行时和本地感知服务，并负责启动与关闭。`createApp` 接收这些实例、`shutdownSignal`、Agent 地址读取函数、静态资源位置和录像缓存／编码配置，组装 HTTP 应用及其录像回放资源管理器；缓存目录在首次准备录像时创建。应用暴露 `closeRecordings`，由 `main.ts` 在关闭时等待录像准备、读取与文件清理。路由工厂调用注入模块的业务方法，不负责应用级初始化与关闭；`createApp` 不读取环境，本地感知服务不接收 Agent 客户端或模型凭据；应用入口独立创建语音收件箱和模型解释器，感知只接收证据交付与来源失效端口。

语音片段的短时交付、期限和判断状态归 `src/conversation/`；原生音频与转写仍归 `src/perception/`，语音语义模型解释器归 `src/conversation/interpret.ts`。配置及边界见[语音片段交付与对话判断](../../docs/perception.md#语音片段交付与对话判断)。

`src/http/sse-transport.ts` 通过原生 `WritableStream`、Hono `writeSSE` 与 `p-timeout` 提供家庭状态、设备历史和当前快照共用的串行写入、事件／队列容量、心跳、超时与取消。每条连接持有独立资源，领域适配器维护各自的协议、资格、通知和连接数。`snapshot-stream.ts` 合并感知与语音的快照通知；家庭状态流维护版本及实体变化，历史流读取已保存页并计算页增量，三者不合并数据语义。

聊天路由只接收 Agent 地址读取函数、端口与超时；米家服务接收 go2rtc 地址读取函数、凭据仓库和家庭选择存储模块。地址函数由启动入口连接到配置仓库，调用时读取当前配置，业务模块不依赖 YAML 存储结构。数据库连接由存储模块使用，不放入 HTTP 请求上下文。`environment.ts` 负责读取和校验进程环境变量。

米家内部按职责分开管理状态：`MijiaService` 管理当前 MiCloud 与 OAuth 账号会话、读取和观察范围；`LoginFlow` 与 `AccountMaintenance` 管理各自的操作状态、任务、计时器及准备中的新会话。家庭运行时管理已生效的家庭设备清单、规格和作用域；作用域指当前账号和家庭这一轮运行的范围。`DeviceDiscovery` 负责向供应商获取清单，并生成可访问设备索引；`MediaSession` 管理绑定与播放状态，`PropertyReader` 管理属性批次的串行执行和大小限制，`AccountObservations` 管理活动 MQTT 观察。协调层通过回调提供当前账号、任务有效性、凭据保存和续期操作，并将设备清单交给媒体模块；子模块不引用协调服务或 Hono Context。凭据和家庭选择保存使用账号串行队列；媒体安装与清理使用媒体模块自己的串行队列，通过账号实例、媒体实例及取消信号隔离切换后的迟到结果。媒体网络等待不阻塞账号写入。会话替换、失效、退出或关闭会使旧读取结果失效；同账号续期保留仍可访问设备的 MQTT 观察，OAuth token 改变时重建连接。属性传输失败不自动更换协议。家庭 HTTP 状态查询只读取已生效的快照；播放连接响应一次返回协商耗时与源活动状态。后台任务和播放资源可以在请求结束后继续运行。

连接配置路径由 `connections/store.ts` 解析，仓库根目录由顶层入口传入，避免移动功能目录改变用户配置位置。`drizzle/` 存放迁移，`scripts/` 存放开发与构建工具，[`tests/`](tests/README.md) 保存测试用例，范围和运行方式见该目录的说明。

## 数据库

所有应用表集中导出于 `src/db/schema.ts`，使用专用数据库的 `public` schema。`household/data-lifecycle.ts` 为每张表声明家庭或安装级生命周期，新增表漏声明会导致类型检查失败。绑定记录和登录凭据属于安装级数据。家庭重绑定在排他绑定锁内核对实际表清单，并用显式 `TRUNCATE ... RESTRICT` 清空全部家庭表，不依赖手工维护删除顺序或 `CASCADE`。迁移表位于 `drizzle` schema，不参与清理。新增家庭数据写入须共用绑定锁并核对绑定身份；新增外部文件资源须接入相应领域的提交后清理。

使用 Drizzle ORM + Postgres.js 连接 PostgreSQL / TimescaleDB。数据库地址由 `DATABASE_URL` 指定，由启动入口创建连接并注入凭据存储；未配置时，米家授权操作返回存储错误。backend 进程启动不自动执行迁移；根目录 `dev` 在启动应用前自动准备数据库并执行迁移。

```sh
bun run db:migrate                       # 自动启动本机数据库、迁移并检查
bun run --cwd apps/backend db:check      # 只读检查 backend 迁移和 TimescaleDB
bun run --cwd apps/backend db:generate   # 根据 schema 生成迁移
bun run --cwd apps/backend db:studio     # 数据库管理界面
docker compose stop db                   # 只停止数据库容器，保留数据卷
```

本地账号配置见根目录 `.env.example`。`POSTGRES_PASSWORD` 与 `DATABASE_URL` 中的密码需一致，URL 中的特殊字符需编码；修改环境变量不会更改已有数据库卷中的账号密码。

backend 的 `db:check` 核对迁移时间戳、文件哈希和 TimescaleDB 扩展，不写入数据，不验证写权限或完整表结构。缺少迁移时运行 `db:migrate`；已执行的迁移文件被修改时，应恢复原文件并新增迁移。

`mijia_home_selections` 表保存按区域和米家用户身份关联的家庭选择；未选择家庭时不暴露工作设备或接入摄像头。家庭列表、选择 API 与切换语义见[家庭范围](../../docs/mijia.md#家庭房间与设备能力)。

`credentials` 表保存按名称索引的加密授权及更新时间，密钥由独立文件提供；backend 每次读写授权重新读取密钥。凭据写入与删除使用事务和提交结果确认：确认已提交后采用结果，确认回滚才报告普通存储失败；数据库暂时无法确认时暂停账号访问，待显式重试读取数据库中的保存状态后恢复，不沿用旧内存会话。业务表定义放在 `src/db/schema.ts`，TimescaleDB 专有 SQL 使用自定义迁移；迁移 SQL 与 `drizzle/meta` 一起提交，通过 `db:migrate` 应用，不使用 schema push。

### 空间关系资料

`household/spatial/` 统一维护 `spaces`、`passages`、`observation_bindings` 三张表。空间是可独立引用的位置，通道连接两个存在且不同的空间，观测绑定把设备或镜头关联到一个空间或通道。同一对空间可有多条通道，同一来源可绑定多个目标；名称允许重复，记录使用稳定 UUID，修改内容保留 ID。

这些资料由人维护，用于解释观测，不证明人员进出、当前位置或占用情况。通道端点只表示连接；画面方向和覆盖限制写在绑定的 `description` 中，例如“画面左向右对应客厅→卧室”。空间改名、端点调整、设备移动或镜头转动后，需要人工核对说明，文本不会自动改写。消费者只采用启用绑定，并另行检查来源的实际可用性；当前 Agent 聊天尚未接入空间查询工具。

新建或更换绑定来源时校验当前设备清单：摄像头必须填写设备声明的镜头，普通设备不填镜头，`device_id` 不建立设备表外键。来源暂时不可用时，保留原来源的绑定仍可修改说明、目标、启停或删除。启停只控制说明的采用，不控制设备采集。外键阻止删除仍被通道或绑定引用的目标，停用绑定仍保留引用。

`service.ts` 校验命令和来源，`repository.ts` 处理事务与引用查询，`routes.ts` 转换 HTTP，`errors.ts` 定义模块错误；`main.ts` 装配、`app.ts` 挂载。读写先取得家庭绑定共享锁，再取得空间锁；切换家庭按[统一清理规则](#数据库)清空三张表并拒绝旧绑定请求。首次绑定保留预先登记的资料，退出登录或设备断连不清理。创建时间与更新时间由后端生成，每次更新保证更新时间严格递增，作为并发编辑校验依据，不保存历史修订。

接口要求本机访问，使用 JSON，响应禁用缓存，请求体最多 16 KiB。以下路径均以 `/api/spatial` 为前缀，字段与响应见[共享契约](../../packages/api/README.md#空间资料契约)，字段校验以[spatial.ts](../../packages/api/src/contracts/spatial.ts)为准。

| 方法与路径                                                                          | 用途                                                   |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------ |
| `POST /read`                                                                        | 返回绑定标识及空间、通道、绑定的完整资料，包含停用绑定 |
| `POST /spaces/save`、`POST /passages/save`、`POST /observation-bindings/save`       | 新建或编辑，返回保存后的记录                           |
| `POST /observation-bindings/enabled`                                                | 仅修改绑定启用状态，返回更新后的记录                   |
| `POST /spaces/delete`、`POST /passages/delete`、`POST /observation-bindings/delete` | 删除记录或返回阻止删除的直接引用                       |

### 家庭上下文表

家庭上下文使用三张普通 PostgreSQL 表，属于当前实例绑定的家庭，不新增账号或家庭实体表：

| 表                   | 内容与约束                                                                                                                                                                  |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `household_subjects` | 人物或宠物的稳定 UUID、类型、名称、补充资料 `details` 和登记时间；姓名不作为唯一身份。                                                                                      |
| `context_records`    | 一次观察 `observation` 或判断 `assessment` 的主题、描述、结构化 `data`、支持程度、发生时间、保存时间、可选到期时间、证据引用 `evidence` 和运行标识 `scope_epoch`。          |
| `context_entities`   | 上下文与人物、宠物、房间、设备的多对多关联；角色为主体 `subject`、参与者 `participant`、地点 `location` 或来源 `source`。同一上下文、对象类型、对象 ID 与角色组合不能重复。 |

“爸爸妈妈一起回家”只保存一条上下文，分别添加爸爸和妈妈的参与者关联。成员关联使用 `household_subjects.id` 的字符串形式；房间与设备沿用设备清单中的来源 ID。`entity_id` 同时引用不同种类的对象，因此没有指向对象表的数据库外键，也不保证关联对象存在；只有 `context_id` 具有外键，删除上下文会自动删除它的全部关联。成员移除本身不会删除历史上下文。

`certainty` 使用 `supported`（有支持）、`tentative`（暂定）、`unknown`（未知）、`conflicting`（冲突）。`occurred_at` 是证据所描述的发生／观察时间，`created_at` 是保存时间；`expires_at` 为空不代表判断永久有效。JSONB 是 PostgreSQL 的 JSON 存储类型，`details` 和 `data` 保存对象，`evidence` 保存引用和摘要数组，不存原始媒体。数据库约束检查 JSON 外层类型，不校验证据条目的业务结构。

上下文主键由提交方生成并在重试时复用，主键约束阻止重复插入；它不执行语义去重，也不自动将重复插入转为成功。通用时间检索使用 `(occurred_at, id)` 索引，对象检索使用 `(entity_type, entity_id, context_id)` 索引。成员出现另有按首次／最后观察时间、当前成员及摄像头来源建立的部分表达式索引，仅索引 `member_sighting` 记录。切换家庭时，在更新绑定的同一事务中清空上下文、关联和成员，保留登录凭据。

成员出现索引由 `0015_member_sighting_query_indexes` 迁移建立；已有数据库需执行 `bun run --cwd apps/backend db:migrate` 后才能使用这些索引。

已提供表结构、迁移、切换家庭清理及只读浏览接口；成员出现记录已由 `household/identity/activity-repository.ts` 自动写入并更新归因关联，尚未接入通用记录生产者或定期清理。`scope_epoch` 只是保存运行标识，数据库不会自行核对当前运行或接纳判断；这些表不构成当前情景状态机或自动控制依据。

成员资料由 `household/members/` 维护，复用 `household_subjects`，不经数据库浏览接口写入。`POST /api/household-members/list` 查询成员；`/save` 使用 `operation: create | update`、稳定 UUID `id` 和 `profile` 新增或更新；`/delete` 按 `id` 删除成员资料，保留上下文及其关联。三个接口都要求当前 `scope_epoch`、已就绪家庭和本机访问资格，返回更新后的成员列表；成员操作持有共享绑定锁，并核对数据库绑定与运行范围；成员写入另持有成员排他锁，家庭切换使用排他绑定锁。

人物资料包含 `kind: person`、名称和描述，宠物使用 `kind: pet` 并要求物种；描述和物种存于 `details.description`、`details.species`，编辑时保留其他补充字段。类型登记后不可修改；名称、物种、描述分别限制为 100、50、2,000 字符，新增上限为 500 位成员，请求体限制为 16 KiB。不提供自动身份确认或行为总结。

#### 人物识别参考存储

`household/identity` 管理人宠参考照片及识别资格，直接使用现有成员 UUID，人物 128 维／猫狗 512 维特征与照片元数据保存在同一份样本记录；不增加另一份人物档案，不把图片或特征写入成员 `details`。`perception/identity` 继续负责图像处理及匹配，存储模块接受已完成质量检查的图片与派生特征，不自行解码或提取人脸。

`household/identity/appearance-evidence.ts` 定义私有的人体外观证据边界。跟踪只输出当前原帧新提取、没有明显人体框重叠的向量；感知服务核对来源、运行、媒体代次及帧龄后通过 `appearance.acceptAppearance` 交付。`household/identity/appearance.ts` 由主入口装配，拥有有界短期参照、匹配诊断、冲突阻断和终态核对，向量不进入公共结果或窗口。默认尚未注入实景校准策略，不输出正式外观归属；来源级公共关联与活动保存已接入该契约，默认仍不产生外观归属；活动纠正详情页面已接入，浏览器展示与数据库纠正联动尚未完成运行验收，当前规则与限制见[家庭短期人体外观参照](../../docs/perception.md#家庭短期人体外观参照)。

| 表                 | 内容                                                                                                                             |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| `identity_members` | 成员 UUID 与识别资格，人物及猫狗参考保存后自动启用                                                                               |
| `identity_samples` | 独立样本 UUID、成员 UUID、图片资源键、字节数与 SHA-256、图片类型、上传或摄像头登记来源、质量、登记时间及模型／处理版本与特征向量 |

内部入口 `createIdentityReferences(db, files)` 提供 `save`、`list`、`readImage`、`remove` 与 `cleanup`，并通过 `matching` 提供匹配快照读取和资格启停。资料操作必须提供当前家庭绑定和 `assertCurrent` 运行资格检查；操作持有家庭绑定共享锁及成员排他锁，拒绝已删除成员，人物及猫狗参考均带有对应模型特征，登记共用候选挑选及保存流程；人物支持上传和摄像头录像，猫狗只上传照片。图片读取必须同时指定成员与样本 UUID，返回有界字节及图片类型，不提供静态文件 URL。图片键由存储端生成，文件以私有权限保存在 `data/identity/references`，读取拒绝符号链接，并核对长度和摘要。

图片、样本与派生特征先准备后提交；一次确认中的全部选中照片在同一数据库事务中原子保存包含特征的样本，容量不足或任一样本无效时整批拒绝。每位成员最多 10 份参考，有参考的成员最多 32 位（包括停用人物），图片单份沿用 `imageLimits.maxFileBytes` 的 32 MiB 上限，总量为 256 MiB。同一成员的精确重复图片拒绝保存，姓名不参与归属或去重。成员资料本身仍允许 500 位。

单个 backend 的 `matching` 模块拥有当前模型配置和内存快照修订标记，不把全局版本状态另存到数据库。参考增删、识别启停、影响识别的成员分类变化、猫狗增删、家庭改绑及模型配置变化，在共同锁内撤销快照，提交后从数据库重建；新快照使用新的修订标记，旧在途结果不能重新生效。停用保留图片和特征，只退出评分集合。名称、描述及同分类物种写法变化只刷新资料，不清空在线支持；无变化和被拒绝的成员命令不触发参考刷新。物种唯一归因直接检查当前家庭成员资料，不依赖参考版本。删除成员、删除参考、家庭改绑先在数据库事务中撤销参考访问并删除包含特征的样本，再清理文件；普通成员删除仍保留历史上下文，改绑仍沿用清空上下文的既有行为。文件清理先枚举候选图片键，再取得同一锁确认数据库归属，最后在事务外删除已确认无引用的文件；图片键不复用，清理不在删除文件期间占用成员或家庭绑定锁。数据库归属无法确认时不删除文件；失败会记录错误，残留无法通过参考入口读取，启动、删除后和下一次保存前重试。清理失败时不接受新的参考写入，防止残留无界增长。

`createReferenceEnrollment` 协调人物及猫狗的参考登记，`createIdentityRoutes` 提供共同的本机接口，均复用成员家庭作用域检查。登记独立于成员 `/save`：上传照片与摄像头录像先提取候选，页面预览后勾选并批量保存。人物候选来自人脸模型，猫狗候选来自检测池定位的动物裁剪及宠物特征模型；不为宠物增加另一份成员资料或参考存储。摄像头必须仍属于当前家庭设备清单，不要求后台检测或已有轨迹。公开响应不包含特征或文件系统路径，图片按成员与样本 UUID 授权读取。

| 接口（前缀 `/api/household-members/references`）                             | 用途                                                                                  |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `POST /list`                                                                 | 当前成员参考、人物模型状态、识别资格及不能启用的原因                                  |
| `POST /upload?scope_epoch=…&memberId=…`                                      | 有界原始图片请求体；返回临时人脸候选                                                  |
| `POST /recording?scope_epoch=…&memberId=…&deviceId=…&channel=…&recordedAt=…` | 有界原始视频请求体；提取完成后返回临时人脸候选                                        |
| `POST /preview`、`POST /cancel`、`POST /confirm`                             | 查询候选、幂等取消、用 `candidateIds` 确认多张候选；都携带成员、作用域和登记会话 UUID |
| `GET /image/:sampleId?scope_epoch=…&memberId=…`                              | 读取已保存的参考图片                                                                  |
| `POST /delete`、`POST /toggle`                                               | 删除样本或启停；启用请求在匹配策略未就绪时拒绝                                        |

共享请求与响应位于 `packages/api/src/contracts/member-identity.ts`。浏览器录像最多 15 秒、32 MiB，后端仅解码 WebM／MP4 的视频轨道，最多分析前 15 秒，每秒一帧；FFmpeg 复用本机配置的可执行文件，限制解码像素、线程及处理期限。录像提取请求最多 90 秒；每个上传入口只接纳一个上传，本实例同时只保留一次登记。候选最多 12 张，每张最多 256 KiB、合计最多 3 MiB，按清晰度保留并移除精确重复及当前成员已保存图片。确认期限从提取完成开始为 2 分钟，服务端使用单调时钟校验，响应提供到期时间与当前剩余容量。取消、到期、成员删除、家庭改绑和服务关闭释放暂存资料；确认前和数据库事务内再次检查成员归属、摄像头资格与期限，保存事务还核对当前物种对应的模型与处理版本；物种变化使不再适用的候选失效。原始录像、抽帧和上传图片由有界上传持有，在已接纳计算结束后一起清理；保存成功只留下所选成员参考 JPEG 及其特征。摄像头名称和录制起点来自浏览器提交的来源说明，不作为持续感知的来源运行或人物轨迹证据。

登记与在线分析共用感知子进程中的同一模型所有者、CPU／内存预算和空闲卸载；登记等待已接纳的单帧计算结束，其间不再接纳新的在线身份请求，不建立无限队列。单脸上传和录像抽帧均保留整图比例并补边；单张上传必须只有一个人脸或一只对应物种宠物，录像帧可提取多个候选，由用户明确核对归属。登记与在线提取共用按人物／猫狗选择的模型适配及质量门槛，保存的模型及处理版本由感知模块生成。具体模型与输入限制见[持续成员身份分析](../../docs/perception.md#持续成员身份分析)。

家庭参考按成员 UUID 生成不可变匹配快照，由现有感知 IPC 交付在线匹配。快照修订标记变化撤销旧匹配支持，启停改变参与评分的成员，改名只刷新展示；停用参考不参与评分。成员命令先在共同成员锁内完成校验，实际影响参考或物种资格时才撤销快照，资料变更后刷新与清理。人物及猫狗参考保存后自动启用，有有效评分时选择最高分成员并保留 `inferred` 推测，合格连续支持可形成确认；猫狗参考一起评分，宠物归因可按最高分成员资料纠正检测物种。没有可用宠物特征结果且家庭只有一只对应物种宠物时，可按实测动物框直接归因，不要求参考照片；模型或参考版本不兼容时拒绝启用，始终拒绝旧结果接纳；资料保存、模型可用与识别启用仍分别表达。主进程在来源与顺序门禁后由家庭身份领域的 `association.ts` 校验直接支持证据，`associations.ts` 按有效直接确认、宠物特征推测或候选、同物种唯一宠物、人脸最高分推测或候选、人体外观推测的顺序统一选择来源级关联，发布当前成员 UUID、名称及依据状态；成员资料写入后刷新名称，识别版本变化仍撤销旧支持。接纳与实时展示边界见[当前成员关联](../../docs/perception.md#当前成员关联)。匹配参数与版本规则见[家庭参考与匹配策略](../../docs/perception.md#家庭参考与匹配策略)，素材适用范围与登记、匹配及文件故障的覆盖限制统一见[身份验证范围与限制](../../docs/perception.md#身份验证范围与限制)。

成员最近活动由 `household/identity/activity-service.ts` 消费有效当前人宠关联，按稳定来源轨迹累计首次／当前归因与纠正，再通过 `activity-repository.ts` 按 revision 更新记录并原子替换成员主体、保留摄像头来源。仓库的 `recent` 按最后观察时间与记录 ID 降序提供有界快照，`history` 独立按观察区间与当前归因读取；两者持共享成员锁，让读取相互并行并保持记录与对象引用一致，成员和身份写入仍持独占锁。成员写入口使用有界串行队列维护提交确认，提交通知用于 Agent 刷新。匹配参数、记录语义、重试及保留边界见[成员最近活动](../../docs/perception.md#成员最近活动)。

`POST /api/household-context/browse` 为 Web 的 `/data` 页面提供三张表的只读浏览。请求包含当前 `scope_epoch`、白名单表名 `table`、`cursor` 和 `search`；首屏使用 `cursor: null`，后续读取使用上一页返回的 `next_cursor`。游标是保存排序位置的数据，避免扫描被跳过的历史行；时间位置保留 PostgreSQL 微秒精度。可按 `context_id` 或 `entity: { type, id }` 查看相关上下文及关联。成员按名称搜索，上下文按描述或主题搜索，关联按对象 ID 搜索；每页最多 25 条，返回 `has_more` 和 `next_cursor`。成员数精确查询；上下文和关联数量使用 PostgreSQL 维护的全表估计，并以 `count_is_estimate` 标记，不是筛选后的匹配数。字段元数据从 Drizzle 表定义生成并在模块内复用，完整响应最多 2 MiB；按字节预算返回完整记录，较大的记录可能使当页少于 25 条，游标定位到实际返回的最后一条并支持继续读取，不截断归因或证据。单条记录连同响应元数据仍无法放入预算时返回 `capacity_exceeded`。

接口仅允许本机访问，接纳后端直连、Vite 开发入口和 `https://localhost:8443` 正式页面入口；继续校验实际回环对端、Host 与 Origin，不信任转发头。成员接口使用相同入口规则。数据浏览不提供任意 SQL、其他数据库表或写入操作。读取前后核验家庭运行资格和请求的运行标识，数据库读取持有共享绑定事务锁，家庭切换持有排他绑定事务锁，并核对账号和家庭绑定。历史记录不要求其保存的 `scope_epoch` 等于当前运行；当前请求的运行标识用于隔离旧请求。该浏览器是数据检查入口，不是 Agent 的情景检索或判断接纳接口。

配置协调由后台周期任务执行，状态查询没有维护副作用。保存新的 go2rtc 地址后自动迁移连接；`POST /api/mijia/connection/retry` 只恢复未就绪部分。纯设备识别位于 `devices/mapping.ts`，摄像头共享流规格由 `media/camera-source-spec.ts` 定义。

连接重试的执行结果通过公共快照中的 `connection` 记录提供，复用 `@home-agent/api/contracts` 的操作协议和错误结构；页面通过 SSE 接收更新，不轮询米家状态。观看资源支持重复 PUT 复用协商结果，以及 GET 查询；DELETE 与服务端期限负责终止已开始的协商。

## Hono RPC 边界

`createApp` 和各功能路由工厂返回链式注册得到的路由类型。`src/client.ts` 只通过 type import 引用应用类型，并用 `hc` 导出浏览器客户端工厂。`build:rpc` 预编译客户端声明，避免前端反复推导服务端实现。客户端仅依赖 Hono 的浏览器模块；启动、数据库与米家生命周期代码不属于客户端运行时。

JSON 输入使用 `@home-agent/api/errors/hono` 的 `validateJson(schema)` middleware，handler 通过 `c.req.valid("json")` 读取。该 middleware 复用公共 JSON 读取、Zod 校验和 `AppError`，并将输入类型暴露给 RPC。聊天输入协议由 backend 与 Agent 共同引用 `packages/api`，返回单次 JSON 回答。新增接口须接入路由链，复用公共 schema，并通过功能 API 模块调用类型化客户端。

服务探测、go2rtc 响应和 MiCloud 响应共同使用 `@home-agent/api/http/read-body` 的有界读取与 reader 清理。JSON 解码和供应商错误转换分别在对应边界处理；读取错误不吞掉传输或取消原因。
