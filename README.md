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
cp .env.example .env  # 已有配置则跳过
```

编辑 `.env`，设置一致的 `POSTGRES_PASSWORD` 和 `DATABASE_URL` 密码，填写 `AGENT_MODEL`、`OPENAI_API_KEY`，按需设置 `OPENAI_BASE_URL`。

```sh
bun run db:up
bun run db:migrate
bun run db:agent:setup
bun run dev
```

访问 <http://127.0.0.1:5173/>。开发命令同时启动 web、backend（3000）和 Agent（1811）；go2rtc 需自行启动。

生产模式运行 `bun run start`，自动构建并启动 backend 和 Agent，访问 <http://127.0.0.1:3000/>。当前仅供可信本机使用，尚无用户认证。

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
bun run dev:web      # 单独启动前端
bun run dev:backend  # 单独启动后端
bun run dev:agent    # 单独启动 Agent
bun run check        # 格式、lint、类型检查
bun run build        # 构建
```

项目分为 `apps/web`、`apps/backend`、`apps/agent`，共享模块位于 `packages`。

更多说明：[后端与数据库](apps/backend/README.md) · [前端](apps/web/README.md) · [调用追踪](docs/observability.md) · [错误处理](docs/errors.md) · [聊天人工验收](docs/chat-verification.md)
