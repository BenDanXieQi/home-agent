# Backend

基于 Hono + Bun，负责 Web 静态托管、服务连接配置、米家授权持久化、家庭设备清单与状态订阅、属性读取与 MQTT 观察、受控摄像头播放和聊天转发。模型执行与对话会话持久化由独立 [Agent](../agent/README.md) 负责。

当前设备清单与规格接入尚未形成家庭语义模型，也未实现属性集采、人物／宠物状态、空间覆盖、活动判断或生效要求管理。相关领域边界见[家庭语义目标与领域模型](../../docs/plans/household-model.md)，设备基础与场景依赖见[实施计划](../../docs/plans/backend-household-perception.md)。本文仅说明当前后端实现；设备历史与 Agent 长期记忆不是同一层能力。

## 运行

先按[项目 README](../../README.md)安装依赖并配置根目录 `.env`。以下命令均在仓库根目录执行：

```sh
bun run dev:backend  # 单独启动 backend
bun run dev         # 等待 Docker 依赖就绪，再启动 Web、backend 和 Agent
bun run start       # 构建后启动 backend 和 Agent，提供页面与 API
```

默认监听 `http://127.0.0.1:3000`，通过 `BACKEND_HOST`、`BACKEND_PORT` 调整。配置、服务检查、米家和聊天接口同时验证 TCP 对端为 loopback 及 Host／Origin 为允许的本机地址；调整监听地址不会放宽访问限制。当前仅供可信本机使用，尚无用户认证。构建产物需要 workspace 与已安装的依赖。

## 接口

| 接口                       | 职责                                     |
| -------------------------- | ---------------------------------------- |
| `GET /api/health`          | backend 存活状态，不检查外围服务或数据库 |
| `GET /api/config`          | 读取连接配置及可写状态                   |
| `PUT /api/config`          | 校验并保存完整连接配置                   |
| `GET /api/services/status` | 检查 Agent 与 go2rtc 的接口是否可用      |
| `POST /api/chat`           | 将 JSON 请求转发至 Agent，透传响应与 SSE |

连接地址来自根目录 `config/config.yaml`，每次请求重新读取文件，内容未变时复用解析结果。配置生成、编辑和 `--config` 用法见[本地运行](../../docs/running.md#服务连接)。

`/api/mijia` 提供扫码、验证码提交、授权恢复与退出、家庭设备清单和状态订阅、按镜头预留观看连接及 SDP 信令；沿用本机管理限制。统一重试连接返回 HTTP 202，由 `/api/mijia/events` 的 SSE 展示后台进展；`/api/mijia/state` 提供诊断快照。这里的公共状态指供页面读取、且不含凭据的信息。`src/credentials/` 负责通用 AES-256-GCM 凭据存储，`src/mijia/service.ts` 管理当前 MiCloud 与 OAuth 完整账号会话、读取和观察范围，并按顺序协调凭据保存和资源清理。`account/login-flow.ts` 管理独立扫码尝试，`account/maintenance.ts` 管理账号恢复续期任务；`account/session.ts` 准备新会话，service 保存成功后才启用它。

家庭运行时保存已生效的设备清单与规格，完整规格只留在后端，通过公共 SSE 提供固定家庭、房间、设备与规格摘要。设备清单包括家庭、房间、设备及其归属信息。`DeviceDiscovery` 获取完整云端清单，并据此生成可访问设备索引；完整云端清单确认并更新到状态机后允许访问设备，缓存保存失败只报告降级。家庭模块按活动 model／URN 共享规格，后台最多三组并发准备；属性读取前只检查已准备的能力。规格协议请求不携带账号凭据，不包含当前属性值，也不执行设备动作。详见[家庭、房间与设备能力](../../docs/mijia.md#家庭房间与设备能力)。

米家账号以扫码为唯一用户登录入口，backend 复用扫码身份静默完成 OAuth 授权。MiCloud 与 OAuth 共同构成完整接入会话，由 `MijiaService` 统一负责保存、恢复、续期和退出。新会话必须符合持久家庭绑定，完成授权并保存成功后才采用，OAuth 失败不覆盖现有账号；活动会话续期最终认证失败则撤销整个账号的设备清单、读取、观察和媒体访问，进入重新认证状态。MQTT 连接认证拒绝先交账号维护强制刷新 token；普通网络、限流及单 topic 权限拒绝不直接等价于整账号失效。完整生命周期见[授权与配置](../../docs/mijia.md#授权与配置)。

`MijiaService.readProperties(properties, signal)` 直接使用当前中国大陆区 MiCloud 会话，由 service 核验账号、所选家庭归属及读取运行标识；该标识用于排除会话更新前的旧读取结果。`properties/read-request.ts` 按设备分组检查 readable 规格；所有调用共用 `PropertyReader` 的串行批次。返回逐项 `baseline`／`cloud_cache` 观测，保留部分成功和原始返回码语义；缓存读取不保证最新值，`Retry-After` 约束后续批次与新读取。当前没有属性读取 HTTP 路由或周期读取。

`MijiaService.observeDevices(deviceIds, onObservation, signal)` 使用同一账号保存的 OAuth 凭据，按所选家庭内显式指定的设备提供 MQTT 属性与在线观察。`AccountObservations` 管理活动观察和重连，`MiotMqtt` 管理单次连接、共享 topic 与逐 topic 订阅确认；断线后恢复活动订阅，设备清单变化通知与属性观察共享连接，取消全部观察（含设备清单变化通知）后停止连接与计时器。该入口已用于[限时上报日志](../../docs/household.md#设备上报日志)，不提交家庭 `latest` 或 `availability`；持续采集、独立设备事件与自动补读尚未接入。读取、推送的协议契约及已验证范围见[米家来源契约](../../docs/reference/mijia-source-contract.md)。

`CameraSourceManager` 管理摄像头共享流的规格、注册、重试、离线保留与释放；实际连接摄像头、接收视频和维持常驻消费者由 go2rtc 执行。`PlaybackManager` 管理播放预留、协商结果和观看资源释放，实际 WebRTC 连接位于 go2rtc 与浏览器之间。backend 不接收或中转视频包。官方能力列表声明为双摄的设备，其两个镜头的共享流在 go2rtc 内复用一个物理 MISS 连接，backend 根据小米官方通道能力列表生成通道列表，并通过 `channelCount` 将能力传给 Go；Go 不按具体型号选择双摄分支。backend 仍分别管理各镜头的源与播放资源；关闭一路观看不会关闭另一镜头的连接。

`AccountMaintenance` 调度完整账号会话的恢复续期，通过回调交由 `MijiaService` 保存并启用新会话。`DeviceDiscovery` 维护设备快照、合并并发刷新与周期设备发现，`MediaSession` 维护 go2rtc 地址巡检、绑定重试、媒体运行标识和相机／观看资源；`Go2RtcAdapter` 维护独立的 go2rtc 运行时会话和心跳租约。米家会话续期与 go2rtc 租约续期是两种不同操作。媒体运行标识 `revision` 在媒体失效或重新绑定时更换，用于拒绝旧播放请求；它不用于配置并发修改检测。源注册失败的重试由 `CameraSourceManager` 管理，媒体收包监测和取流恢复由 go2rtc 管理，网页出帧检测由浏览器管理。

米家协议适配位于 `src/mijia/protocols/`：`micloud/` 负责扫码、设备清单与属性读取，`oauth/` 负责授权及 token 续期，`miot/` 负责 MQTT 连接与消息解析。下游通过 `src/mijia/media/go2rtc-adapter.ts` 调用 go2rtc 内部接口。资源定义、状态含义与释放规则见[米家与摄像头](../../docs/mijia.md#组件与资源)。

聊天请求最多 32 KiB，超时由 `BACKEND_REQUEST_TIMEOUT_MS` 控制，默认 130 秒；客户端取消会传递到 Agent。`threadId` 与 `X-Thread-Id` 原样透传，backend 不读写 Agent 的 checkpoint 表。

聊天代理要求上游为本项目 Agent；响应体原样透传，错误连接到其他服务时不会将其 HTML 等响应转换为本项目错误格式。

收到 SIGINT/SIGTERM 后停止接收请求，最多等待 `BACKEND_SHUTDOWN_TIMEOUT_MS`（默认 30 秒），再关闭数据库与追踪资源。追踪配置与生命周期见[追踪接入](../../packages/observability/README.md)。

## 连接配置与探测

`GET /api/config` 返回 `{ config, writable, path }`；`PUT /api/config` 接收完整配置 JSON（最多 16 KiB），保存后返回同一结构。字段、默认值、运行时校验与编辑器 schema 来自 `packages/api/src/contracts/` 的同一套 Zod 定义。配置仓库复用内容未变的解析结果，但不跳过文件访问、大小和权限检查；写入通过 `yaml` Document API 保留注释，并由 `write-file-atomic` 原子替换。

配置错误返回 503，输入错误 400，只读或不可信来源 403，非 JSON 请求 415，超大请求 413，保存失败 500；统一响应与字段错误约定见 [API 契约](../../packages/api/README.md#错误响应)。

`GET /api/services/status` 返回 `{ services: { agent, go2rtc } }`，每项包含 `url`、`status`、`checkedAt`、`reasonCode` 和可选 `params`。每次请求直接探测 Agent `/health` 与 go2rtc `/api`，不缓存；每项限时 3 秒、响应最多 16 KiB，支持客户端取消，拒绝重定向并校验 JSON。go2rtc 响应要求 `version`、`revision`、`host` 为字符串，且 `version`、`host` 非空，允许附加字段。Web 保存时取消旧查询，避免旧结果覆盖新地址；状态轮询不覆盖未保存输入。

管理接口同时校验 TCP 对端、Host 与浏览器 Origin。对端必须是 loopback（包含 IPv4 映射的 loopback），无法取得对端信息时拒绝访问。Host 与 Origin 只允许 `localhost`、`127.0.0.1`、`[::1]` 的 backend 端口及 Vite `5173`；不信任转发头，不开放 CORS。Vite 保留浏览器 Host，JSON 修改请求显式校验 Origin。Agent 复用同一规则，仅接受其配置端口对应的本机 Host／Origin。

## 目录与约定

```text
src/
├── main.ts                 # 启动、资源初始化与关闭
├── app.ts                  # 中间件、子路由与错误处理的组装
├── environment.ts          # 环境变量解析
├── connections/
│   ├── routes.ts           # 连接配置接口
│   ├── store.ts            # YAML 路径、校验与读写
│   └── status.ts           # 服务探测与状态接口
├── chat/
│   └── routes.ts           # 聊天转发与流取消
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
│   │   ├── playback-manager.ts      # 播放预约、观看资源、取消与记录回收
│   │   └── go2rtc-adapter.ts        # 专用 go2rtc 协议、心跳与超时
│   └── protocols/
│       ├── micloud/       # 扫码、Cookie、设备清单及 RC4 属性请求
│       │   └── properties.ts # 属性地址类型、每批数量上限及请求超时
│       ├── oauth/client.ts # 静默授权、token 交换与续期
│       └── miot/          # MQTT 单次连接、订阅与消息解析
├── household/             # 家庭状态机、设备清单存储、规格、SSE 与限时设备推送日志
├── credentials/
│   ├── store.ts            # 数据库授权的认证加密与读写
│   └── key.ts              # 独立密钥文件的权限与内容校验
└── db/
    ├── index.ts            # 数据库连接
    └── schema.ts           # 业务表定义
```

按功能组织代码，子路由使用 `new Hono()` 创建，由 `app.route()` 挂载。backend 与 Agent 通过 `@home-agent/api/local-access` 复用本机访问限制；前后端数据契约位于 `packages/api/src/contracts`。

普通 TypeScript 文件和目录使用小写短横线命名，类与类型使用 PascalCase，变量和方法使用 camelCase。对外错误码使用小写下划线；上游协议的原始字段和错误标识在适配边界转换。定时器句柄使用 `*Timer`，时间戳使用 `*At`，毫秒时长使用 `*Ms`。

业务错误使用 `AppError`，HTTP 错误通过 `packages/api/src/errors` 的 Hono 处理入口输出；错误码、文案与 SSE 约定见[错误处理](../../packages/api/README.md#错误响应)。

`main.ts` 是应用级依赖的唯一装配入口：读取环境、创建配置仓库、数据库、凭据仓库、米家服务和家庭运行时，并负责启动与关闭。`createApp({ environment, connectionStore, household, mijiaService, deviceLogs, readAgentUrl, staticRoot })` 只组装 HTTP 应用，不读取环境或隐式创建资源。路由工厂通过参数接收这些模块，调用其业务方法，不负责应用级初始化与关闭。

聊天路由只接收 Agent 地址读取函数、端口与超时；米家服务接收 go2rtc 地址读取函数、凭据仓库和家庭选择存储模块。地址函数由启动入口连接到配置仓库，调用时读取当前配置，业务模块不依赖 YAML 存储结构。数据库连接由存储模块使用，不放入 HTTP 请求上下文。`environment.ts` 负责读取和校验进程环境变量。

米家内部按职责分开管理状态：`MijiaService` 管理当前 MiCloud 与 OAuth 账号会话、读取和观察范围；`LoginFlow` 与 `AccountMaintenance` 管理各自的操作状态、任务、计时器及准备中的新会话。家庭运行时管理已生效的家庭设备清单、规格和作用域；作用域指当前账号和家庭这一轮运行的范围。`DeviceDiscovery` 负责向供应商获取清单，并生成可访问设备索引；`MediaSession` 管理绑定与播放状态，`PropertyReader` 管理属性批次的串行执行和大小限制，`AccountObservations` 管理活动 MQTT 观察。协调层通过回调提供当前账号、任务有效性、凭据保存和续期操作，并将设备清单交给媒体模块；子模块不引用协调服务或 Hono Context。凭据和家庭选择保存使用账号串行队列；媒体安装与清理使用媒体模块自己的串行队列，通过账号实例、媒体实例及取消信号隔离切换后的迟到结果。媒体网络等待不阻塞账号写入。会话替换、失效、退出或关闭会使旧读取结果失效；同账号续期保留仍可访问设备的 MQTT 观察，OAuth token 改变时重建连接。属性传输失败不自动更换协议。HTTP 状态查询只读取已生效的快照；后台任务和播放资源可以在请求结束后继续运行。

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

配置协调由后台周期任务执行，状态查询没有维护副作用。保存新的 go2rtc 地址后自动迁移连接；`POST /api/mijia/connection/retry` 只恢复未就绪部分。纯设备识别位于 `devices/mapping.ts`，摄像头共享流规格由 `media/camera-source-spec.ts` 定义。

连接重试的执行结果通过公共快照中的 `connection` 记录提供，复用 `@home-agent/api/contracts` 的操作协议和错误结构；页面通过 SSE 接收更新，不轮询米家状态。观看资源支持重复 PUT 复用协商结果，以及 GET 查询；DELETE 与服务端期限负责终止已开始的协商。

## Hono RPC 边界

`createApp` 和各功能路由工厂返回链式注册得到的路由类型。`src/client.ts` 只通过 type import 引用应用类型，并用 `hc` 导出浏览器客户端工厂。`build:rpc` 预编译客户端声明，避免前端反复推导服务端实现。客户端仅依赖 Hono 的浏览器模块；启动、数据库与米家生命周期代码不属于客户端运行时。

JSON 输入使用 `@home-agent/api/errors/hono` 的 `validateJson(schema)` middleware，handler 通过 `c.req.valid("json")` 读取。该 middleware 复用公共 JSON 读取、Zod 校验和 `AppError`，并将输入类型暴露给 RPC。聊天输入协议由 backend 与 Agent 共同引用 `packages/api`，SSE 转发保持流式响应。新增接口须接入路由链，复用公共 schema，并通过功能 API 模块调用类型化客户端。

服务探测、go2rtc 响应和 MiCloud 响应共同使用 `@home-agent/api/http/read-body` 的有界读取与 reader 清理。JSON 解码和供应商错误转换分别在对应边界处理；读取错误不吞掉传输或取消原因。
