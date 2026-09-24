# Home Agent

从零实现的智能家居应用，使用 Bun + TypeScript（JS 技术栈）。项目运行不依赖 MiLoCo backend。

## 启动

需要 Bun 1.4.2 或更新版本；对话还需要已启动的 Docker（本地 PostgreSQL）以及模型服务凭据。

```sh
bun install --frozen-lockfile
cp .env.example .env
```

编辑 `.env`：将 `POSTGRES_PASSWORD` 与 `DATABASE_URL` 中的密码改为一致的本地密码，配置 `AGENT_MODEL`、`OPENAI_API_KEY`，按需设置 `OPENAI_BASE_URL`。然后执行：

```sh
bun run db:up
bun run db:migrate
bun run db:agent:setup
bun run db:check
bun run dev
```

打开 `http://127.0.0.1:5173/`。Turbo 同时启动 Vite web、Hono backend（默认 `127.0.0.1:3000`）和独立 Agent（默认 `127.0.0.1:1811`）。Vite 将 `/api` 转发给 backend。当前页面仅展示 backend 健康状态。

```sh
bun run build
bun run start
```

生产环境访问 `http://127.0.0.1:3000/`。backend 构建依赖 web 构建，并复制静态资源到 `apps/backend/dist/public`；`start` 会先确保构建完成，再同时启动 backend 和 Agent。产物仍需要 workspace 中已安装的依赖。

需要单独开发 Agent 时：

```sh
bun run dev:agent
```

健康接口为 `http://127.0.0.1:1811/health`。完成上述数据库初始化和模型配置后可以对话；仅启动服务或健康检查成功不代表聊天已就绪。`OPENAI_BASE_URL` 可指定兼容 OpenAI 的服务。

```sh
curl -N http://127.0.0.1:3000/api/chat \
  -H 'Content-Type: application/json' \
  -d '{"message":"你能做什么？"}'
```

backend 的 `POST /api/chat` 将请求转发到独立 Agent，并透传 SSE 响应。web 尚无聊天界面。两个服务默认仅监听本机，暂未实现鉴权。

## 结构与边界

```text
apps/web/             React + Vite 管理界面
apps/backend/         Hono 业务 API、Agent 转发与生产静态资源托管
apps/agent/src/
  main.ts             Bun 服务入口、进程退出
  config.ts           环境变量验证
  http/app.ts         Hono 应用组装、健康接口与错误响应
  http/chat.ts        请求校验、SSE 与取消信号
  graph/home-agent.ts LangGraph 模型执行与模型 span
packages/contracts/   共享 Zod API schema（当前仅 backend health）
packages/observability/  共享 OpenTelemetry 初始化、传播与导出
packages/typescript-config/  共享 TypeScript 配置
evals/                后续评估场景说明
```

backend 负责业务 API，后续承接账号、家庭、设备、事件和存储；Agent 负责模型推理与工具编排。设备接入逻辑应放在业务模块中，Agent 的工具调用这些明确的接口，避免将设备协议和账号状态塞入图节点。

backend 已接入 Drizzle + Postgres.js，提供 PostgreSQL / TimescaleDB 的连接池、版本化迁移和本地 Docker 配置；业务表尚未定义。根目录运行 `bun run db:up`、`bun run db:migrate`、`bun run db:check`。配置与更多命令见 [backend 数据库说明](apps/backend/README.md#数据库)。

Hono 的应用工厂与 Bun 服务入口分开，路由按功能使用 `app.route()` 组合。当前规模无需额外的 controller/service/repository 空目录。等出现真实业务再拆模块；需要 Hono RPC 时通过链式路由保留类型推导。

Agent 暂时仅有 `START → model → END`，会话持久化使用官方 PostgreSQL checkpointer。设备读取、控制、自动化、后台队列及断线自动续跑尚未实现。旧 Miloco 客户端与 SQLite 会话实现已移除。

## Agent 接口

- `GET /health`：服务存活、模型配置、持久化配置与追踪状态，不表示数据库已就绪。
- `POST /api/chat`：`{"message":"...","threadId":"可选 UUID"}`。首次省略会话 ID，从 `X-Thread-Id` 响应头或 `run_started` 获取，续聊携带同一 ID。缺少模型、数据库配置或 checkpoint 表不可用时返回 503。
- SSE 事件：`run_started`、`token`、`run_completed`、`run_failed`。
- LangGraph 加载会话历史，只需提交本次新消息。每次执行的 `runId` 独立，同一 Agent 进程内同一会话并发执行返回 409。客户端断开或达到 `AGENT_RUN_TIMEOUT_MS` 后取消，默认两分钟。
- 首次运行 `bun run db:agent:setup` 初始化独立 `agent_state` schema。Agent 优先读取 `AGENT_DATABASE_URL`，默认复用 `DATABASE_URL`。详见 [Agent 存储说明](apps/agent/README.md)。

## 开发命令

```sh
bun run dev          # web + backend + Agent
bun run dev:backend  # backend
bun run dev:web      # web
bun run dev:agent    # Agent
bun run check        # 格式、类型感知 lint、TypeScript
bun run test         # 已有 backend 测试
bun run format
bun run lint:fix
bun run build
bun run start        # backend + Agent，backend 托管生产静态资源
bun run start:agent
```

依赖版本通过根 `package.json` 的 catalog 统一管理。Hono CLI 作为根开发依赖用于路由检查；应用模块导出 `createApp`，加载时应显式创建应用，不导入会启动服务的 `main.ts`。

初始化检查结果及真实模型人工验收步骤见 [初始化验收](docs/initialization-review.md)。第三方 `.agents/skills` 文档保留上游格式，不纳入项目格式化。

## 追踪与评估

`packages/observability` 使用标准 OpenTelemetry JS SDK 和 `@hono/otel`，串联 backend → Agent → 模型调用。`OTEL_TRACES_EXPORTER` 支持 `none`（默认）、`console` 和 `otlp`；OTLP 可直接发送到 LangSmith，也可经过 Collector。模型输入输出默认不采集，按需设置 `OTEL_INCLUDE_CONTENT=true`。模型请求仍会将用户消息发给配置的模型服务。

配置、追踪范围与 SSE 生命周期见 [追踪接入](docs/observability.md)。评估 runner 尚未实现，见 [评估说明](evals/README.md)。

## 上游参考

MiLoCo 源码直接参考本机外部项目 `/Users/sssensational/Development/xiaomi-miloco`，具体约定见 [AGENTS.md](AGENTS.md)。本仓库不包含其源码副本或 submodule，安装、启动和构建不依赖该项目。

后续按业务需要接入原生设备能力、Agent 工具和 web 聊天，再完善会话管理与自动化任务；不再经过 MiLoCo backend 中转。
