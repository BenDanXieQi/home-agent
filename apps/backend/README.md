# Backend

基于 Hono + Bun，负责 Web 静态托管、服务连接配置、米家授权持久化、受控摄像头播放和聊天转发。模型执行与对话会话持久化由独立 [Agent](../agent/README.md) 负责。

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

连接地址来自根目录 `config/config.yaml`，每次请求重新读取文件，内容未变时复用解析结果。生成规则、`--config`、接口结构与错误处理见[服务连接配置](../../docs/service-connections.md)。

`/api/mijia` 提供扫码、验证码提交、授权恢复与退出、设备读取、按镜头预留观看连接及 SDP 信令；沿用本机管理限制。统一重试连接返回 HTTP 202，由 `/api/mijia/state` 展示后台进展。`src/credentials/` 负责通用 AES-256-GCM 凭据存储，`src/mijia/service.ts` 拥有当前账号和串行提交边界，`login-flow.ts` 管理独立扫码尝试，`account-session.ts` 准备恢复或续期候选账号；只有候选授权持久化成功才接管当前账号。

`CameraSourceManager` 管理摄像头共享流的规格、注册、重试、离线保留与释放；实际连接摄像头、接收视频和维持常驻消费者由 go2rtc 执行。`PlaybackManager` 管理播放预留、协商结果和观看资源释放，实际 WebRTC 连接位于 go2rtc 与浏览器之间。backend 不接收或中转视频包。

账号所有者维护米家账号会话续期，`DeviceDiscovery` 维护设备快照、合并并发刷新与周期设备发现，`MediaSession` 维护 go2rtc 地址巡检、绑定重试、媒体代次和相机／观看资源；`Go2RtcAdapter` 维护独立的 go2rtc 运行时会话和心跳租约。米家会话续期与 go2rtc 租约续期是两种不同操作。媒体失效或重新绑定时更新 `revision`，使旧播放请求失效；它不用于配置并发修改检测。源注册失败的重试由 `CameraSourceManager` 管理，媒体收包监测和取流恢复由 go2rtc 管理，网页出帧检测由浏览器管理。

米家云请求来自 `src/mijia/micloud/`，下游通过 `src/mijia/go2rtc-adapter.ts` 调用 go2rtc 内部接口。资源定义、状态含义与释放规则见[米家与摄像头](../../docs/mijia.md#组件与资源)。

聊天请求最多 32 KiB，超时由 `BACKEND_REQUEST_TIMEOUT_MS` 控制，默认 130 秒；客户端取消会传递到 Agent。`threadId` 与 `X-Thread-Id` 原样透传，backend 不读写 Agent 的 checkpoint 表。

聊天代理要求上游为本项目 Agent；响应体原样透传，错误连接到其他服务时不会将其 HTML 等响应转换为本项目错误格式。

收到 SIGINT/SIGTERM 后停止接收请求，最多等待 `BACKEND_SHUTDOWN_TIMEOUT_MS`（默认 30 秒），再关闭数据库与追踪资源。追踪配置与生命周期见[追踪接入](../../docs/observability.md)。

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
│   ├── device-discovery.ts # 设备快照、发现任务、刷新合并与定时器
│   ├── media-session.ts    # 配置巡检、媒体绑定、代次与资源生命周期
│   ├── camera-sources.ts   # 共享流注册、重试、离线保留与释放
│   ├── operation.ts        # 米家操作 span、静态错误码与取消语义
│   ├── retry-timer.ts      # 失败工作拥有的可取消退避等待
│   ├── playback-manager.ts # 播放预约、观看所有权、取消与记录回收
│   ├── go2rtc-adapter.ts   # 专用 go2rtc 协议、心跳与超时
│   └── errors.ts           # 上游错误到公共错误码的转换
├── credentials/
│   ├── store.ts            # 数据库授权的认证加密与读写
│   └── key.ts              # 独立密钥文件的权限与内容校验
└── db/
    ├── index.ts            # 数据库连接
    └── schema.ts           # 业务表定义
```

按功能组织代码，子路由使用 `new Hono()` 创建，由 `app.route()` 挂载。backend 与 Agent 通过 `@home-agent/api/local-access` 复用本机访问限制；前后端数据契约位于 `packages/api/src/contracts`。

普通 TypeScript 文件和目录使用小写短横线命名，类与类型使用 PascalCase，变量和方法使用 camelCase。对外错误码使用小写下划线；上游协议的原始字段和错误标识在适配边界转换。定时器句柄使用 `*Timer`，时间戳使用 `*At`，毫秒时长使用 `*Ms`。

业务错误使用 `AppError`，HTTP 错误通过 `packages/api/src/errors` 的 Hono 处理入口输出；错误码、文案与 SSE 约定见[错误处理](../../docs/errors.md)。

`main.ts` 是应用级依赖的唯一装配入口：读取环境、创建配置仓库、数据库、凭据仓库和米家服务，并负责启动与关闭。`createApp({ environment, connectionStore, mijia, readAgentUrl, staticRoot })` 只组装 HTTP 应用，不读取环境或隐式创建资源。路由工厂通过参数接收依赖，米家路由只依赖业务操作接口 `MijiaApi`，不拥有初始化与关闭权限。

聊天路由只接收 Agent 地址读取函数、端口与超时；米家服务只接收 go2rtc 地址读取函数和凭据仓库。地址函数由启动入口连接到配置仓库，调用时读取当前配置，业务模块不依赖 YAML 存储结构。数据库由凭据存储模块持有，不放入 HTTP 请求上下文。`environment.ts` 负责读取和校验进程环境变量。

米家内部的状态与定时器随资源所有者一起封装：账号状态属于 `MijiaService`，设备状态属于 `DeviceDiscovery`，绑定与播放状态属于 `MediaSession`。协调层通过显式回调提供当前账号、任务有效性和续期能力，并将发现的设备交给媒体模块；子模块不引用协调服务或 Hono Context。凭据提交与媒体清理共用协调层的串行队列，避免退出登录、账号接管和重新绑定交错。HTTP 状态查询只组合快照；后台任务和播放资源的生命周期独立于单个请求。

连接配置路径由 `connections/store.ts` 解析，仓库根目录由顶层入口传入，避免移动功能目录改变用户配置位置。`drizzle/` 存放迁移，`scripts/` 存放开发与构建工具，[`tests/`](tests/README.md) 预留测试目录和约定，当前不包含测试用例。

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

`credentials` 表保存按名称索引的加密授权及更新时间，密钥由独立文件提供；backend 每次读写授权重新读取密钥。业务表定义放在 `src/db/schema.ts`，TimescaleDB 专有 SQL 使用自定义迁移；迁移 SQL 与 `drizzle/meta` 一起提交，通过 `db:migrate` 应用，不使用 schema push。

配置协调由后台周期任务执行，状态查询没有维护副作用。保存新的 go2rtc 地址后自动迁移连接；`POST /api/mijia/connection/retry` 只恢复未就绪部分。纯设备识别位于 `devices.ts`，摄像头共享流规格由 `camera-source.ts` 定义。

连接重试的执行结果通过快照中的 `connectionOperation` 暴露，复用 `@home-agent/api/contracts` 的操作协议和错误结构。所有快照由同一个响应函数生成轮询提示。观看资源支持重复 PUT 复用协商结果，以及 GET 查询；DELETE 与服务端期限负责终止已接受的协商。

## Hono RPC 边界

`createApp` 和各功能路由工厂返回链式注册得到的路由类型。`src/client.ts` 只通过 type import 引用应用类型，并用 `hc` 导出浏览器客户端工厂。`build:rpc` 预编译客户端声明，避免前端反复推导服务端实现。客户端仅依赖 Hono 的浏览器模块；启动、数据库与米家生命周期代码不属于客户端运行时。

JSON 输入使用 `@home-agent/api/errors/hono` 的 `validateJson(schema)` middleware，handler 通过 `c.req.valid("json")` 读取。该 middleware 复用公共 JSON 读取、Zod 校验和 `AppError`，并将输入类型暴露给 RPC。聊天输入协议由 backend 与 Agent 共同引用 `packages/api`，SSE 转发保持流式响应。新增接口须接入路由链，复用公共 schema，并通过功能 API 模块调用类型化客户端。

服务探测、go2rtc 响应和 MiCloud 响应共同使用 `@home-agent/api/http/read-body` 的有界读取与 reader 清理。JSON 解码和供应商错误转换分别在对应边界处理；读取错误不吞掉传输或取消原因。
