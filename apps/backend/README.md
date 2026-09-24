# Backend

基于 Hono + Bun，负责 Web 静态托管、服务连接配置、连接状态检查和聊天转发。模型执行与会话持久化由独立 [Agent](../agent/README.md) 负责。

## 运行

先按[项目 README](../../README.md)安装依赖并配置根目录 `.env`。以下命令均在仓库根目录执行：

```sh
bun run dev:backend  # 单独启动 backend
bun run dev         # 等待 Docker 依赖就绪，再启动 Web、backend 和 Agent
bun run start       # 构建后启动 backend 和 Agent，提供页面与 API
```

默认监听 `http://127.0.0.1:3000`，通过 `BACKEND_HOST`、`BACKEND_PORT` 调整。当前仅供可信本机使用，尚无用户认证。构建产物需要 workspace 与已安装的依赖。

## 接口

| 接口                       | 职责                                     |
| -------------------------- | ---------------------------------------- |
| `GET /api/health`          | backend 存活状态，不检查外围服务或数据库 |
| `GET /api/config`          | 读取连接配置及可写状态                   |
| `PUT /api/config`          | 校验并保存完整连接配置                   |
| `GET /api/services/status` | 检查 Agent 与 go2rtc 的接口是否可用      |
| `POST /api/chat`           | 将 JSON 请求转发至 Agent，透传响应与 SSE |

连接地址来自根目录 `config/config.yaml`，每次请求重新读取。生成规则、`--config`、接口结构与错误处理见[服务连接配置](../../docs/service-connections.md)。

聊天请求最多 32 KiB，超时由 `BACKEND_REQUEST_TIMEOUT_MS` 控制，默认 130 秒；客户端取消会传递到 Agent。`threadId` 与 `X-Thread-Id` 原样透传，backend 不读写 Agent 的 checkpoint 表。

聊天代理要求上游为本项目 Agent；响应体原样透传，错误连接到其他服务时不会将其 HTML 等响应转换为本项目错误格式。

收到 SIGINT/SIGTERM 后停止接收请求，最多等待 `BACKEND_SHUTDOWN_TIMEOUT_MS`（默认 30 秒），再关闭数据库与追踪资源。追踪配置与生命周期见[追踪接入](../../docs/observability.md)。

## 目录与约定

```text
src/
├── main.ts                 # 启动、资源初始化与关闭
├── app.ts                  # 中间件、子路由与错误处理的组装
├── app-context.ts          # Hono 请求上下文变量的类型约定
├── environment.ts          # 环境变量解析
├── connections/
│   ├── routes.ts           # 连接配置接口
│   ├── store.ts            # YAML 路径、校验与读写
│   └── status.ts           # 服务探测与状态接口
├── chat/
│   └── routes.ts           # 聊天转发与流取消
├── middleware/
│   └── local-management.ts # 管理接口的 Host／Origin 校验
└── db/
    ├── index.ts            # 数据库连接
    └── schema.ts           # 业务表定义
```

按功能组织代码，子路由使用 `new Hono<AppContext>()` 创建，由 `app.route()` 挂载。共享 HTTP 中间件放在 `middleware/`；前后端数据契约位于 `packages/api/src/contracts`。

业务错误使用 `AppError`，HTTP 错误通过 `packages/api/src/errors` 的 Hono 处理入口输出；错误码、文案与 SSE 约定见[错误处理](../../docs/errors.md)。

`app-context.ts` 仅定义请求上下文变量的类型，目前只有 `db`，供路由和中间件共享；数据库实例在启动时创建，由 `app.ts` 注入。`environment.ts` 负责读取和校验进程环境变量。

连接配置路径由 `connections/store.ts` 解析，仓库根目录由顶层入口传入，避免移动功能目录改变用户配置位置。`drizzle/` 存放迁移，`scripts/` 存放开发与构建工具，[`tests/`](tests/README.md) 预留测试目录和约定，当前不包含测试用例。

## 数据库

使用 Drizzle ORM + Postgres.js 连接 PostgreSQL / TimescaleDB。数据库地址由 `DATABASE_URL` 指定，通过 `c.get("db")` 获取连接；未配置时为 `undefined`，依赖数据库的功能需显式检查。服务启动不自动执行迁移。

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

目前尚无业务表，初始迁移仅启用 TimescaleDB。业务表定义放在 `src/db/schema.ts`，TimescaleDB 专有 SQL 使用自定义迁移；迁移 SQL 与 `drizzle/meta` 一起提交，通过 `db:migrate` 应用，不使用 schema push。
