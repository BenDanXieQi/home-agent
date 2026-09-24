# Home Agent

面向米家设备的 AI 家庭助手，目标是结合摄像头和设备状态理解家中情况，实现对话控制、自动化和主动提醒。

参考 MiLoCo 的家庭感知思路，独立实现，运行不依赖 MiLoCo。技术栈：Bun + TypeScript、React + Vite、Hono、LangGraph、PostgreSQL；摄像头计划通过 go2rtc 接入。

## 功能范围

已有流式对话、会话持久化、调用追踪和服务连接配置。Web 首页可保存 agent、go2rtc 地址并显示连接状态；米家登录、设备控制、摄像头感知和自动化尚未接入。

米家接入的产品约束是唯一绑定入口、一次用户登录覆盖设备与摄像头；凭据接入路线需验证，不预设 OAuth token 可供 go2rtc 直接使用。

## 启动

需要 Bun ≥ 1.4.2、Docker 和模型服务凭据。在仓库根目录执行：

```sh
bun install --frozen-lockfile
bun run setup
```

`setup` 从仓库模板初始化 `.env` 和 go2rtc 本机配置，保留已有文件。换机器使用同一流程，无需复制原机器的 `config/`。

编辑 `.env`，设置一致的 `POSTGRES_PASSWORD` 和 `DATABASE_URL` 密码，填写 `AGENT_MODEL`、`OPENAI_API_KEY`，按需设置 `OPENAI_BASE_URL`。个人凭据需要在每台机器自行填写。

```sh
bun run infra:up
bun run db:migrate
bun run dev
```

访问 <http://127.0.0.1:5173/>。日常只需 `bun run dev`：补齐缺失配置，启动数据库和 go2rtc，等待健康检查及只读数据库检查通过，再启动 Web、backend（3000）和 Agent（1811）。Docker 需提前运行；依赖等待上限 120 秒，检查失败则停止启动。

`bun run db:migrate` 按顺序执行 backend 的 Drizzle 迁移和 Agent checkpoint 表初始化，前一步失败即停止。首次使用、拉取新增迁移或升级 checkpoint 适配器后显式执行；`dev` 和 `start` 不自动修改数据库，也不生成迁移或填充演示数据。

## 本地基建

根目录 `compose.yaml` 管理数据库和 go2rtc 容器，应用在本机 Bun 中运行。`infra:up` 启动依赖，`infra:down` 停止依赖并保留数据；退出 `dev` 不停止容器。`docker compose down` 移除容器，但保留数据库卷和本机配置。

go2rtc 固定为 `alexxit/go2rtc:1.9.14`，管理页面为 <http://127.0.0.1:1984/>。配置模板为 `docker/go2rtc.yaml`，本机副本为 `config/go2rtc/go2rtc.yaml`，目录挂载到容器 `/config` 并忽略 Git。模板更新需手动同步到已有副本；修改后执行 `docker compose restart go2rtc`，日志用 `docker compose logs --tail=50 go2rtc` 查看。

数据库及 go2rtc 端口仅映射到本机，WebRTC 候选地址也面向本机浏览器。初始摄像头流为空，接口可用不代表真实出流。

生产模式运行 `bun run start`，自动构建并启动 backend 和 Agent，访问 <http://127.0.0.1:3000/>；依赖服务及数据库迁移需事先准备，`start` 不管理 Docker。当前仅供可信本机使用，尚无用户认证。

## 服务连接配置

backend 首次启动生成 `config/config.yaml`，修改后下次请求生效：

```yaml
services:
  agent:
    url: http://127.0.0.1:1811
  go2rtc:
    url: http://127.0.0.1:1984
```

自定义文件可向 backend 传入 `--config <path>`；相对路径按进程启动目录解析。连接成功不代表模型或摄像头已就绪。

自动生成、相邻 schema、只读配置及使用示例见[服务连接配置](docs/service-connections.md)。

## 对话

Web 暂无聊天界面，可通过 API 调用：

```sh
curl -N http://127.0.0.1:3000/api/chat \
  -H 'Content-Type: application/json' \
  -d '{"message":"你好"}'
```

续聊时携带返回的 `threadId`。接口与持久化说明见 [Agent](apps/agent/README.md)。

## 开发

```sh
bun run dev          # 启动依赖并等待就绪，再启动前后端和 Agent
bun run dev:web      # 单独启动前端
bun run dev:backend  # 单独启动后端
bun run dev:agent    # 单独启动 Agent
bun run check        # 格式、lint、类型检查
bun run build        # 构建
```

单独启动应用的命令不管理 Docker，需要时先执行 `bun run infra:up`。

项目分为 `apps/web`、`apps/backend`、`apps/agent`，共享模块位于 `packages`。

更多说明：[后端与数据库](apps/backend/README.md) · [前端](apps/web/README.md) · [调用追踪](docs/observability.md) · [错误处理](docs/errors.md) · [聊天人工验收](docs/chat-verification.md)
