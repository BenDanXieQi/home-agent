# Backend

基于 Hono + Bun，负责 Web 静态托管、服务连接配置、米家授权持久化、家庭设备清单与状态订阅、属性读取与 MQTT 观察、受控摄像头播放、本地图片/摄像头持续检测、音频能量、人声分析、本地语音转写和聊天转发。聊天模型执行与对话会话持久化由项目自有的第一方 [Agent](../agent/README.md) 负责。backend 当前没有语义 LLM 调用，检测不依赖 Agent 在线。

当前已实现原生属性持续采集、带有效性的当前值与房间事实查询，尚未实现人物／宠物状态、空间覆盖、活动判断或生效要求管理。相关领域边界见[家庭语义目标与领域模型](../../docs/plans/household-model.md)，设备基础与场景依赖见[实施计划](../../docs/plans/README.md)。本文仅说明当前后端实现；设备历史与 Agent 长期记忆不是同一层能力。

本地检测的接口、配置和验证范围见[感知功能说明](../../docs/perception.md)。人体外观跟踪、猫狗位置跟踪、可选的轨迹人物身份分析、音频分析、可选本地语音转写、短时语音交付和独立 Agent 请求判断及窗口筛选、历史语音与人物判断、自动回看及按需媒体已接入；家庭权威身份接纳与音视频语义理解仍按[摄像头计划](../../docs/plans/media-perception.md)实施。房间观测分析通过独立 Agent 执行，当前行为见[房间 AI 上下文](../../docs/contracts/room-analysis.md)。

## 运行

先按[项目 README](../../README.md)安装依赖并配置根目录 `.env`。以下命令均在仓库根目录执行：

```sh
bun run dev:backend  # 单独启动 backend
bun run dev         # 等待 Docker 依赖就绪，再启动 Web、backend 和 Agent
bun run start       # 构建后启动 backend 和 Agent，提供页面与 API
```

默认监听 `http://127.0.0.1:3000`，通过 `BACKEND_HOST`、`BACKEND_PORT` 调整。配置、服务检查、米家和聊天接口同时验证 TCP 对端为 loopback 及 Host／Origin 为允许的本机地址；调整监听地址不会放宽访问限制。当前仅供可信本机使用，尚无用户认证。构建产物需要 workspace 与已安装的依赖。

## 静态文件服务

`src/web/routes.ts` 仅处理生产 Web 构建产物。浏览器声明支持对应格式时，优先返回构建生成的 Brotli 或 gzip 副本；未选择压缩格式时返回原文件。响应使用 `Vary: Accept-Encoding` 区分传输格式。

`/assets/` 下名称含构建哈希的已存在资源设置 `Cache-Control: public, max-age=31536000, immutable`，允许缓存一年；文件内容变化时构建会生成新 URL。HTML 及无哈希的公共文件使用 `Cache-Control: no-cache`，允许保存但每次使用前需重新验证。ETag 是内容标识；浏览器提交相同标识时返回无响应体的 304，避免重复下载。页面深链沿用 HTML 回退，缺失资源返回 404，不作为可长期缓存的资源。

该策略只作用于静态文件，不进入 API、SSE（服务端事件流）和视频流处理。部署时需一起更新 Web 原文件与压缩副本。

## 接口

| 接口                                                | 职责                                                                                |
| --------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `GET /api/health`                                   | backend 存活状态，不检查外围服务或数据库                                            |
| `GET /api/config`                                   | 读取连接配置及可写状态                                                              |
| `PUT /api/config`                                   | 校验并保存完整连接配置                                                              |
| `GET /api/services/status`                          | 检查 Agent 与 go2rtc 的接口是否可用                                                 |
| `POST /api/chat`                                    | 绑定家庭范围后转发至 Agent，透传响应与 SSE                                          |
| `GET /api/perception`                               | 本地检测、人宠跟踪、人物身份与音频的健康及最新观测                                  |
| `GET /api/perception/stream`                        | 订阅本地感知当前状态，不传输媒体片段                                                |
| `POST /api/perception/images/detect`                | 接收图片字节并返回该输入的检测结果，复用共享池                                      |
| `GET /api/perception/windows`                       | 按 `scopeEpoch`、`deviceId`、`channel` 查询轻量窗口列表及全局媒体资源用量           |
| `POST /api/perception/windows/:id/media`            | 显式申请窗口媒体表示，状态查询与读取见[窗口接口](../../docs/perception.md#本机接口) |
| `POST /api/mijia/cameras/recordings`                | 读取当前来源的 SD 卡录像索引，保留设备时间依据                                      |
| `PUT/GET/DELETE /api/mijia/recordings/playback/:id` | 申请、查询或释放经校验的 SD 卡回放资源                                              |
| `GET/HEAD /api/mijia/recordings/playback/:id/media` | 受控 MP4 读取，支持单段字节范围请求                                                 |
| `GET /api/perception/speech`                        | 有界语音片段与逐段判断状态                                                          |
| `GET /api/perception/speech/stream`                 | 订阅同一语音收件箱                                                                  |
| `POST /api/perception/retry`                        | 显式重试检测与音频计算，重新准入失败音轨                                            |

窗口详情的 `speech.segments` 保存关联转写，`frames[].identity` 保存采样帧当时的身份判断，`sampledMedia` 表示 backend 生成的采样产物。迟到转写只更新窗口历史与版本，不改写帧身份或重新编码媒体；声音与人物标签不构成说话人身份识别。

SD 卡回放由 `mijia/recordings/` 拥有申请规则、来源授权、录像生成与对外状态；窗口和 SD 回放各自使用 `src/media/resources.ts` 的独立实例管理队列、文件、容量预留、期限、读取和清理。两者的预算与队列不混用，SD 下载不会占用窗口编码名额。`mijia/media/recording-file.ts` 负责内部传输边界，`recordings/media.ts` 使用现有媒体库处理容器与编码，`src/media/ffmpeg.ts` 统一进程执行与退出等待；`recordings/alignment.ts` 保持帧匹配规则独立于 HTTP 和文件存储。接口、容量、取消与验证边界见 [SD 卡录像回放](../../docs/mijia.md#sd-卡录像读取与回放)。

图片上传接口只要求本机访问及模型可用，不要求家庭或媒体就绪；输入限额、临时文件、等待与共享计算行为见[图片上传分析](../../docs/perception.md#独立图片上传分析)。`perception/image-upload.ts` 负责 HTTP 字节与临时输入，感知服务按需准备、复用和恢复已有检测池，视频禁用不阻止图片计算恢复。

连接地址来自根目录 `config/config.yaml`，每次请求重新读取文件，内容未变时复用解析结果。配置生成、编辑和 `--config` 用法见[本地运行](../../docs/running.md#服务连接)。

`/api/mijia` 提供扫码、验证码提交、授权恢复与退出、家庭设备清单和状态订阅、按镜头预留观看连接及 SDP 信令；沿用本机管理限制。统一重试连接返回 HTTP 202，由 `/api/mijia/events` 的 SSE 展示后台进展；`/api/mijia/state` 提供诊断快照。这里的公共状态指供页面读取、且不含凭据的信息。`src/credentials/` 负责通用 AES-256-GCM 凭据存储，`src/mijia/service.ts` 管理当前 MiCloud 与 OAuth 完整账号会话、读取和观察范围，并按顺序协调凭据保存和资源清理。`account/login-flow.ts` 管理独立扫码尝试，`account/maintenance.ts` 管理账号恢复续期任务；`account/session.ts` 准备新会话，service 保存成功后才启用它。

家庭运行时保存已生效的设备清单与规格，完整规格只留在后端，通过公共 SSE 提供固定家庭、房间、设备与规格摘要。设备清单包括家庭、房间、设备及其归属信息。`DeviceDiscovery` 获取完整云端清单，并据此生成可访问设备索引；完整云端清单确认并更新到状态机后允许访问设备，缓存保存失败只报告降级。家庭模块按活动 model／URN 共享规格，后台最多三组并发准备；属性读取前只检查已准备的能力。规格协议请求不携带账号凭据，不包含当前属性值，也不执行设备动作。详见[家庭、房间与设备能力](../../docs/mijia.md#家庭房间与设备能力)。

米家账号以扫码为唯一用户登录入口，backend 复用扫码身份静默完成 OAuth 授权。MiCloud 与 OAuth 共同构成完整接入会话，由 `MijiaService` 统一负责保存、恢复、续期和退出。新会话必须符合持久家庭绑定，完成授权并保存成功后才采用，OAuth 失败不覆盖现有账号；活动会话续期最终认证失败则撤销整个账号的设备清单、读取、观察和媒体访问，进入重新认证状态。MQTT 连接认证拒绝先交账号维护强制刷新 token；普通网络、限流及单 topic 权限拒绝不直接等价于整账号失效。完整生命周期见[授权与配置](../../docs/mijia.md#授权与配置)。

`MijiaService.readProperties(properties, signal)` 直接使用当前中国大陆区 MiCloud 会话，由 service 核验账号、所选家庭归属及读取运行标识；该标识用于排除会话更新前的旧读取结果。`properties/read-request.ts` 按设备分组检查 readable 规格；所有调用共用 `PropertyReader` 的串行批次。返回逐项 `baseline`／`cloud_cache` 观测，保留部分成功和原始返回码语义；缓存读取不保证最新值，`Retry-After` 约束后续批次与新读取。应用层通过 `POST /api/mijia/properties/read` 提供一次性读取，不做周期属性轮询。

`MijiaService.observeDevices(deviceIds, onObservation, signal)` 使用同一账号保存的 OAuth 凭据，按所选家庭内显式指定的设备提供 MQTT 属性与在线观察。`AccountObservations` 管理活动观察和重连，`MiotMqtt` 管理单次连接、共享 topic 与逐 topic 订阅确认；断线后恢复活动订阅，设备清单变化通知与属性观察共享连接，取消全部观察（含设备清单变化通知）后停止连接与计时器。家庭采集模块和[限时上报日志](../../docs/household-runtime.md#设备上报日志)分别消费该入口；只有家庭运行时提交 `latest` 与有效在线状态。采集范围、必要补读与房间查询见[设备事实与房间快照](../../docs/contracts/device-facts.md)。独立设备事件尚未接入。读取、推送的协议契约及已验证范围见[米家来源契约](../../docs/contracts/mijia.md)。

`CameraSourceManager` 管理摄像头共享流的规格、注册、重试、离线保留与释放；实际连接摄像头、接收视频和维持常驻消费者由 go2rtc 执行。`PlaybackManager` 管理播放预留、协商结果和观看资源释放，实际 WebRTC 连接位于 go2rtc 与浏览器之间。浏览器预览视频不经过 backend；本地感知另从 go2rtc 私有分析出口读取视频，在 backend 的计算子进程内解码。官方能力列表声明为双摄的设备，其两个镜头的共享流在 go2rtc 内复用一个物理 MISS 连接，backend 根据小米官方通道能力列表生成通道列表，并通过 `channelCount` 将能力传给 Go；Go 不按具体型号选择双摄分支。backend 仍分别管理各镜头的源与播放资源；关闭一路观看不会关闭另一镜头的连接。

`AccountMaintenance` 调度完整账号会话的恢复续期，通过回调交由 `MijiaService` 保存并启用新会话。`DeviceDiscovery` 维护设备快照、合并并发刷新与周期设备发现，`MediaSession` 维护 go2rtc 地址巡检、绑定重试、媒体运行标识和相机／观看资源；`Go2RtcAdapter` 维护独立的 go2rtc 运行时会话和心跳租约。米家会话续期与 go2rtc 租约续期是两种不同操作。媒体运行标识 `revision` 在媒体失效或重新绑定时更换，用于拒绝旧播放请求；它不用于配置并发修改检测。源注册失败的重试由 `CameraSourceManager` 管理，媒体收包监测和取流恢复由 go2rtc 管理，网页出帧检测由浏览器管理。

`mijia/perception-source.ts` 将当前已提交的家庭与设备访问资格交给感知模块，同一家庭快照复用来源访问表，快照或家庭运行状态变化后重建。历史窗口查询不重复遍历设备清单或克隆米家状态；每次访问仍检查当前家庭快照。媒体连接的运行标识只在准备实时采集时核对，其失效信号结束对应采集；已保存片段的访问期限与撤权规则见[感知媒体说明](../../docs/perception.md#容量停止与访问期限)。

米家协议适配位于 `src/mijia/protocols/`：`micloud/` 负责扫码、设备清单与属性读取，`oauth/` 负责授权及 token 续期，`miot/` 负责 MQTT 连接与消息解析。下游通过 `src/mijia/media/go2rtc-adapter.ts` 调用 go2rtc 内部接口。资源定义、状态含义与释放规则见[米家与摄像头](../../docs/mijia.md#组件与资源)。

聊天请求最多 32 KiB，超时由 `BACKEND_REQUEST_TIMEOUT_MS` 控制，默认 130 秒；客户端取消会传递到 Agent。`threadId` 与 `X-Thread-Id` 原样透传，backend 不读写 Agent 的 checkpoint 表。

`POST /api/chat/history/list` 和 `POST /api/chat/history/read` 将历史查询转发给 Agent，校验返回结构并限制响应最多 4 MiB、请求最多 4 KiB、上游等待最多 45 秒；不直接访问 Agent 数据库。读取前后家庭运行范围变化时拒绝返回，客户端取消传递到上游。分页与未完成会话的含义见 [Agent 历史会话](../agent/README.md#历史会话)。

聊天代理要求上游为本项目 Agent；响应体原样透传，错误连接到其他服务时不会将其 HTML 等响应转换为本项目错误格式。

收到 SIGINT/SIGTERM 后停止接收请求，最多等待 `BACKEND_SHUTDOWN_TIMEOUT_MS`（默认 30 秒），再关闭数据库与追踪资源。追踪配置与生命周期见[追踪接入](../../packages/observability/README.md)。

## 家庭只读查询

`src/household/queries/` 为聊天及其他本机调用方提供精简查询，复用家庭运行时和成员仓库。原有 `GET /api/mijia/state`、`POST /api/mijia/facts/query` 和 `POST /api/household-members/list` 仍服务已有页面；查询接口不读取完整原始数据库表，不触发设备刷新、属性补读或模型分析。

| POST 接口                             | 除 `scope_epoch` 外的参数                   | 返回内容                                                       |
| ------------------------------------- | ------------------------------------------- | -------------------------------------------------------------- |
| `/api/household/queries/overview`     | `offset?`、`limit?`                         | 分页房间清单、设备总数、未分配设备数、类别数量及人物／宠物数量 |
| `/api/household/queries/devices`      | `query?`、`room_id?`、`category?`、分页参数 | 设备 ID、名称、别名、型号、房间、类别及可用状态                |
| `/api/household/queries/device-state` | `device_id`、分页参数                       | 最近属性报告、枚举说明、质量与时间、采集覆盖                   |
| `/api/household/queries/members`      | `query?`、`kind?`、分页参数                 | 登记的人物及宠物资料，不含位置或活动                           |

请求必须携带当前 `scope_epoch`，范围变化或家庭未就绪时拒绝；数据库查询前后核验访问资格及实际家庭绑定。Agent 的范围由 backend 聊天入口注入，不由模型选择。概览和成员查询需要成员数据库可用，数据库错误不会当作零成员返回。

列表默认 20 项、最多 50 项，`total` 为筛选后的总数，`next_offset` 为下一页起点，无下一页时为 `null`；概览分页仅作用于房间列表。设备文字查询对名称、别名、型号和类别做不区分大小写的子串匹配；成员文字查询匹配名字、物种和描述。`category` 精确匹配概览返回的类别代码；省略 `room_id` 查询全部，`null` 仅查询未分配房间。各页独立读取，返回 `state_version` 与 `queried_at`，不保证多次请求之间设备清单不变。

设备状态返回原始值及有效性，枚举值附 `value_label`；缺少可用规格时标签为空，不猜数字含义。属性分页保留缺值项，不能用空列表判断设备关闭。接口沿用本机访问校验，禁用缓存，请求最多 4 KiB、响应最多 128 KiB；超过响应限额返回容量错误，调用方可缩小分页大小。共享契约位于 `packages/api/src/contracts/household-queries.ts`。

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
├── household/             # 家庭状态机、设备清单存储、规格、SSE 与限时设备推送日志
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
│   └── snapshot-stream.ts  # 当前快照 SSE、通知合并、连接容量与关闭
├── credentials/
│   ├── store.ts            # 数据库授权的认证加密与读写
│   └── key.ts              # 独立密钥文件的权限与内容校验
└── db/
    ├── index.ts            # 数据库连接
    └── schema.ts           # 业务表定义
```

按功能组织代码，子路由使用 `new Hono()` 创建，由 `app.route()` 挂载。backend 与 Agent 通过 `@home-agent/api/local-access` 复用本机访问限制；前后端数据契约位于 `packages/api/src/contracts`。

`perception/identity/analysis.ts` 拥有单次来源运行中的人物身份证据与判断；`runtime.ts` 协调原帧采样、证据期限和资源，`process.ts` 与 Python 入口适配 OpenCV。`video/runtime.ts` 统一协调跟踪和身份模块的启停，`tracking/` 通过本帧回调交付结果与像素。跟踪完成时冻结的紧凑身份快照经 `identity_frame` 交给窗口，只接纳到准确对应帧的未关闭窗口；当前身份广播继续独立合并。窗口媒体保存、字节预算及读取权限复用 `media/window-media.ts`，身份模块只增加历史元数据。人体轨迹仍由 `tracking/` 拥有，家庭成员资料与权威身份归家庭领域。配置与判断规则见[持续人物身份分析](../../docs/perception.md#持续人物身份分析)，历史语义及独立保留期限见[窗口中的历史身份](../../docs/perception.md#窗口中的历史身份)。

普通 TypeScript 文件和目录使用小写短横线命名，类与类型使用 PascalCase，变量和方法使用 camelCase。对外错误码使用小写下划线；上游协议的原始字段和错误标识在适配边界转换。定时器句柄使用 `*Timer`，时间戳使用 `*At`，毫秒时长使用 `*Ms`。

业务错误使用 `AppError`，HTTP 错误通过 `packages/api/src/errors` 的 Hono 处理入口输出；错误码、文案与 SSE 约定见[错误处理](../../packages/api/README.md#错误响应)。

`main.ts` 是应用级依赖的装配入口：读取环境、创建配置仓库、数据库、凭据仓库、米家服务、家庭运行时和本地感知服务，并负责启动与关闭。`createApp` 接收这些实例、`shutdownSignal`、Agent 地址读取函数、静态资源位置和录像缓存／编码配置，组装 HTTP 应用及其录像回放资源管理器；缓存目录在首次准备录像时创建。应用暴露 `closeRecordings`，由 `main.ts` 在关闭时等待录像准备、读取与文件清理。路由工厂调用注入模块的业务方法，不负责应用级初始化与关闭；`createApp` 不读取环境，本地感知服务不接收 Agent 客户端或模型凭据；应用入口独立创建语音收件箱和 Agent 客户端，感知只接收证据交付与来源失效端口。

语音片段的短时交付、期限和判断状态归 `src/conversation/`；原生音频与转写仍归 `src/perception/`，语义模型归 Agent。配置及边界见[语音片段交付与对话判断](../../docs/perception.md#语音片段交付与对话判断)。

`src/http/snapshot-stream.ts` 负责感知与语音接口共用的当前快照 SSE 传输，只接收变更订阅、快照读取和应用关闭信号；快照内容及有效性仍由各业务模块维护。

聊天路由只接收 Agent 地址读取函数、端口与超时；米家服务接收 go2rtc 地址读取函数、凭据仓库和家庭选择存储模块。地址函数由启动入口连接到配置仓库，调用时读取当前配置，业务模块不依赖 YAML 存储结构。数据库连接由存储模块使用，不放入 HTTP 请求上下文。`environment.ts` 负责读取和校验进程环境变量。

米家内部按职责分开管理状态：`MijiaService` 管理当前 MiCloud 与 OAuth 账号会话、读取和观察范围；`LoginFlow` 与 `AccountMaintenance` 管理各自的操作状态、任务、计时器及准备中的新会话。家庭运行时管理已生效的家庭设备清单、规格和作用域；作用域指当前账号和家庭这一轮运行的范围。`DeviceDiscovery` 负责向供应商获取清单，并生成可访问设备索引；`MediaSession` 管理绑定与播放状态，`PropertyReader` 管理属性批次的串行执行和大小限制，`AccountObservations` 管理活动 MQTT 观察。协调层通过回调提供当前账号、任务有效性、凭据保存和续期操作，并将设备清单交给媒体模块；子模块不引用协调服务或 Hono Context。凭据和家庭选择保存使用账号串行队列；媒体安装与清理使用媒体模块自己的串行队列，通过账号实例、媒体实例及取消信号隔离切换后的迟到结果。媒体网络等待不阻塞账号写入。会话替换、失效、退出或关闭会使旧读取结果失效；同账号续期保留仍可访问设备的 MQTT 观察，OAuth token 改变时重建连接。属性传输失败不自动更换协议。家庭 HTTP 状态查询只读取已生效的快照；播放连接响应一次返回协商耗时与源活动状态。后台任务和播放资源可以在请求结束后继续运行。

连接配置路径由 `connections/store.ts` 解析，仓库根目录由顶层入口传入，避免移动功能目录改变用户配置位置。`drizzle/` 存放迁移，`scripts/` 存放开发与构建工具，[`tests/`](tests/README.md) 保存测试用例，范围和运行方式见该目录的说明。

## 数据库

使用 Drizzle ORM + Postgres.js 连接 PostgreSQL / TimescaleDB。数据库地址由 `DATABASE_URL` 指定，由启动入口创建连接并注入凭据存储；未配置时，米家授权操作返回存储错误。服务启动不自动执行迁移。

```sh
bun run db:up        # 启动本地数据库，需先启动 Docker
bun run db:migrate   # 执行 backend 迁移和 Agent checkpoint 初始化
bun run db:check     # 只读检查 backend 迁移、TimescaleDB 和 Agent checkpoint
bun run db:generate  # 根据 schema 生成迁移
bun run db:studio    # 数据库管理界面
bun run db:down      # 停止容器，保留数据卷
```

本地账号配置见根目录 `.env.example`。`POSTGRES_PASSWORD` 与 `DATABASE_URL` 中的密码需一致，URL 中的特殊字符需编码；修改环境变量不会更改已有数据库卷中的账号密码。

`db:check` 核对 backend 迁移时间戳、文件哈希和 TimescaleDB 扩展，再执行 Agent 检查；不写入数据，不验证写权限或完整表结构。缺少迁移时运行 `db:migrate`；已执行的迁移文件被修改时，应恢复原文件并新增迁移。

`mijia_home_selections` 表保存按区域和米家用户身份关联的家庭选择；未选择家庭时不暴露工作设备或接入摄像头。家庭列表、选择 API 与切换语义见[家庭范围](../../docs/mijia.md#家庭房间与设备能力)。

`credentials` 表保存按名称索引的加密授权及更新时间，密钥由独立文件提供；backend 每次读写授权重新读取密钥。业务表定义放在 `src/db/schema.ts`，TimescaleDB 专有 SQL 使用自定义迁移；迁移 SQL 与 `drizzle/meta` 一起提交，通过 `db:migrate` 应用，不使用 schema push。

### 家庭上下文表

家庭上下文使用三张普通 PostgreSQL 表，属于当前实例绑定的家庭，不新增账号或家庭实体表：

| 表                   | 内容与约束                                                                                                                                                                  |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `household_subjects` | 人物或宠物的稳定 UUID、类型、名称、补充资料 `details` 和登记时间；姓名不作为唯一身份。                                                                                      |
| `context_records`    | 一次观察 `observation` 或判断 `assessment` 的主题、描述、结构化 `data`、支持程度、发生时间、保存时间、可选到期时间、证据引用 `evidence` 和运行标识 `scope_epoch`。          |
| `context_entities`   | 上下文与人物、宠物、房间、设备的多对多关联；角色为主体 `subject`、参与者 `participant`、地点 `location` 或来源 `source`。同一上下文、对象类型、对象 ID 与角色组合不能重复。 |

“爸爸妈妈一起回家”只保存一条上下文，分别添加爸爸和妈妈的参与者关联。成员关联使用 `household_subjects.id` 的字符串形式；房间与设备沿用设备清单中的来源 ID。`entity_id` 同时引用不同种类的对象，因此没有指向对象表的数据库外键，也不保证关联对象存在；只有 `context_id` 具有外键，删除上下文会自动删除它的全部关联。成员移除本身不会删除历史上下文。

`certainty` 使用 `supported`（有支持）、`tentative`（暂定）、`unknown`（未知）、`conflicting`（冲突）。`occurred_at` 是证据所描述的发生／观察时间，`created_at` 是保存时间；`expires_at` 为空不代表判断永久有效。JSONB 是 PostgreSQL 的 JSON 存储类型，`details` 和 `data` 保存对象，`evidence` 保存引用和摘要数组，不存原始媒体。数据库约束检查 JSON 外层类型，不校验证据条目的业务结构。

上下文主键由提交方生成并在重试时复用，主键约束阻止重复插入；它不执行语义去重，也不自动将重复插入转为成功。时间检索使用 `(occurred_at, id)` 索引，对象检索使用 `(entity_type, entity_id, context_id)` 索引。切换家庭时，在更新绑定的同一事务中清空上下文、关联和成员，保留登录凭据。

已提供表结构、迁移、切换家庭清理及只读浏览接口；尚未接入成员管理、上下文写入或定期清理。现有房间分析不会自动写入这些表。`scope_epoch` 只是保存运行标识，数据库不会自行核对当前运行或接纳判断；这些表不构成当前情景状态机或自动控制依据。

成员资料由 `household/members/` 维护，复用 `household_subjects`，不经数据库浏览接口写入。`POST /api/household-members/list` 查询成员；`/save` 使用 `operation: create | update`、稳定 UUID `id` 和 `profile` 新增或更新；`/delete` 按 `id` 删除成员资料，保留上下文及其关联。三个接口都要求当前 `scope_epoch`、已就绪家庭和本机访问资格，返回更新后的成员列表；写入与家庭重新绑定共用事务锁，并核对数据库绑定与运行范围。

人物资料包含 `kind: person`、名称和描述，宠物使用 `kind: pet` 并要求物种；描述和物种存于 `details.description`、`details.species`，编辑时保留其他补充字段。类型登记后不可修改；名称、物种、描述分别限制为 100、50、2,000 字符，新增上限为 500 位成员，请求体限制为 16 KiB。不提供自动身份确认或行为总结。

`POST /api/household-context/browse` 为 Web 的 `/data` 页面提供三张表的只读浏览。请求包含当前 `scope_epoch`、白名单表名 `table`、从 0 开始的 `page` 和 `search`；可按 `context_id` 或 `entity: { type, id }` 查看相关上下文及关联。成员按名称搜索，上下文按描述或主题搜索，关联按对象 ID 搜索；每页 25 条、最多第 10,001 页，返回是否还有下一页。计数是各表总数，不是筛选后的记录数。字段元数据从 Drizzle 表定义生成，响应最多 2 MiB，超限拒绝返回。

接口仅允许本机访问，不提供任意 SQL、其他数据库表或写入操作。读取前后核验家庭运行资格和请求的运行标识，数据库读取与家庭切换共用绑定事务锁，并核对账号和家庭绑定。历史记录不要求其保存的 `scope_epoch` 等于当前运行；当前请求的运行标识用于隔离旧请求。该浏览器是数据检查入口，不是 Agent 的情景检索或判断接纳接口。

配置协调由后台周期任务执行，状态查询没有维护副作用。保存新的 go2rtc 地址后自动迁移连接；`POST /api/mijia/connection/retry` 只恢复未就绪部分。纯设备识别位于 `devices/mapping.ts`，摄像头共享流规格由 `media/camera-source-spec.ts` 定义。

连接重试的执行结果通过公共快照中的 `connection` 记录提供，复用 `@home-agent/api/contracts` 的操作协议和错误结构；页面通过 SSE 接收更新，不轮询米家状态。观看资源支持重复 PUT 复用协商结果，以及 GET 查询；DELETE 与服务端期限负责终止已开始的协商。

## Hono RPC 边界

`createApp` 和各功能路由工厂返回链式注册得到的路由类型。`src/client.ts` 只通过 type import 引用应用类型，并用 `hc` 导出浏览器客户端工厂。`build:rpc` 预编译客户端声明，避免前端反复推导服务端实现。客户端仅依赖 Hono 的浏览器模块；启动、数据库与米家生命周期代码不属于客户端运行时。

JSON 输入使用 `@home-agent/api/errors/hono` 的 `validateJson(schema)` middleware，handler 通过 `c.req.valid("json")` 读取。该 middleware 复用公共 JSON 读取、Zod 校验和 `AppError`，并将输入类型暴露给 RPC。聊天输入协议由 backend 与 Agent 共同引用 `packages/api`，SSE 转发保持流式响应。新增接口须接入路由链，复用公共 schema，并通过功能 API 模块调用类型化客户端。

服务探测、go2rtc 响应和 MiCloud 响应共同使用 `@home-agent/api/http/read-body` 的有界读取与 reader 清理。JSON 解码和供应商错误转换分别在对应边界处理；读取错误不吞掉传输或取消原因。
