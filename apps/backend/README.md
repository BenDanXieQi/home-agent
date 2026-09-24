# Backend

Hono 4.13.9 + Bun。开发入口为 `src/main.ts`，应用路由和测试入口为 `src/app.ts`。

在仓库根目录执行 `bun run dev`，Turborepo 同时运行 web、backend 和独立 Agent。也可执行 `bun run dev:backend` 单独启动 API；聊天需要 Agent 同时运行。

- 默认地址：`http://127.0.0.1:3000`。
- `GET /api/health`：本服务健康状态，不表示米家、摄像头或模型已接入。
- `POST /api/chat`：最多 32 KiB 的 JSON 请求转发到 Agent，保留上游状态并透传 SSE；客户端取消会取消上游请求。
- 对话请求的可选 `threadId` 原样传给 Agent，`X-Thread-Id` 响应头也透传。会话状态由 Agent 的 `agent_state` schema 管理；backend 不读写 checkpoint 表。
- 根目录 `.env` 中的 `BACKEND_HOST`、`BACKEND_PORT` 可调整监听地址；`AGENT_BASE_URL` 默认 `http://127.0.0.1:1811`，`BACKEND_REQUEST_TIMEOUT_MS` 默认 130 秒。
- 收到 SIGINT/SIGTERM 后停止接收新连接，最多等待 `BACKEND_SHUTDOWN_TIMEOUT_MS`（默认 30 秒）让在途请求完成，超时才强制断开。随后关闭数据库连接池并完成 telemetry 清理；这两步的耗时不包含在请求等待期限内。
- 生产构建由 Turbo 先构建 web，再复制到 `dist/public`；根目录 `bun run start` 同时启动 backend 和 Agent，由 backend 单端口提供页面和 API。
- 构建使用 Bun target，依赖保持 external；运行产物需要 workspace 与已安装的依赖，不是单文件独立分发包。
- 当前仅托管首页及真实静态资源；未知 API 或文件返回 404。增加前端 URL 路由时再配置对应 SPA fallback。

共享 `packages/observability` 负责 OpenTelemetry 与 `@hono/otel` 接入，使用 W3C 追踪上下文连接 Agent。支持关闭导出、本地 console 和 OTLP；可直接接 LangSmith 或 Collector。配置和追踪范围见 [追踪接入](../../docs/observability.md)。

参考：[Hono on Bun](https://hono.dev/docs/getting-started/bun)。

## 数据库

使用 Drizzle ORM + Postgres.js，连接 PostgreSQL / TimescaleDB。根目录 `compose.yaml` 固定使用 `timescale/timescaledb:2.30.1-pg18`，只绑定本机 `5432`，数据保存在 Docker named volume。需要先启动 Docker；命令也能找到 macOS Docker Desktop 自带的 CLI。

首次配置根目录 `.env`：从 `.env.example` 复制数据库配置，并将 `POSTGRES_PASSWORD` 和 `DATABASE_URL` 中的密码替换为同一个本地密码。URL 密码包含特殊字符时需 URL 编码。已有数据库卷不会因为修改环境变量而自动修改账号密码。

在仓库根目录执行：

```sh
bun run db:up        # 启动并等待数据库就绪
bun run db:migrate   # 应用版本化迁移，启用 TimescaleDB
bun run db:check     # 通过 Drizzle 查询 PostgreSQL 与 TimescaleDB 版本
bun run db:generate  # 根据 schema 生成迁移
bun run db:studio    # 本地数据库管理界面
bun run db:down      # 停止容器，保留数据卷
```

`src/db/index.ts` 创建一个共享连接池；`main.ts` 将 Drizzle 实例注入 Hono 的 `c.get("db")`，退出时关闭连接池。未配置 `DATABASE_URL` 时可运行原有 API，此时 `db` 为 `undefined`；数据库业务必须先检查或明确要求数据库可用。`/api/health` 仍为服务存活检查，数据库就绪状态用 `db:check` 检查。连接按需建立，启动服务不会自动执行迁移。

父应用与子路由使用 `src/env.ts` 的共享 `AppEnv` 类型；新增路由使用 `new Hono<AppEnv>()`，从上下文读取 `db` 时保留类型检查与可选性。

`src/db/schema.ts` 预留业务表定义，目前没有虚构的业务表。初始迁移只启用 TimescaleDB，不创建 hypertable。确定事件结构后，先生成表迁移，再用 `bun run db:generate --custom --name=event-hypertable` 添加 TimescaleDB 专有 SQL，并通过 `db:migrate` 执行。迁移 SQL 与 `drizzle/meta` 一起提交。hypertable 主键及唯一约束必须包含所有分区列；不要依赖 ORM 自动推导 hypertable、压缩或保留策略，也不要用 schema push 替代本项目的迁移流程。

本地容器账号用于开发和迁移。生产部署应另外配置数据库权限、备份和 TLS；连接支持在 `DATABASE_URL` 中设置 `sslmode=require` 等 PostgreSQL 参数。

依据：[Drizzle PostgreSQL](https://orm.drizzle.team/docs/get-started-postgresql)、[自定义 SQL 迁移](https://orm.drizzle.team/docs/kit-custom-migrations)、[TimescaleDB 唯一约束](https://docs.timescale.com/use-timescale/latest/hypertables/hypertables-and-unique-indexes/)。
