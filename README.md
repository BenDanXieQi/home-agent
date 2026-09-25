# Home Agent

面向 24 小时持续运行场景的智能管家 Agent 项目，围绕家庭感知、长期记忆和主动／被动交互展开：既响应人的文字与语音请求，也持续关注家庭环境，在需要时主动提供帮助。

目前已实现米家扫码登录、设备列表、多摄像头预览，以及流式对话 API、会话持久化和调用追踪。持续自主运行、视觉感知、长期记忆、语音交互与设备控制尚未实现，Web 暂无聊天界面。当前仅供可信本机使用。

参考 MiLoCo 的家庭感知思路，独立实现，运行不依赖 MiLoCo。技术栈：Bun、TypeScript、React、Hono、LangGraph、PostgreSQL 和 go2rtc。

## 快速开始

需要 Bun ≥ 1.4.2 和已运行的 Docker。摄像头预览需要本机能访问摄像头所在局域网；Docker 模式请先完成[网络设置](docs/running.md#docker-摄像头网络)。

```sh
bun install --frozen-lockfile
bun run setup
```

编辑生成的 `.env`，使 `POSTGRES_PASSWORD` 与 `DATABASE_URL` 中的密码一致。使用对话 API 时还需配置 `AGENT_MODEL`、`OPENAI_API_KEY`，按需填写 `OPENAI_BASE_URL`。

```sh
bun run db:up
bun run db:migrate
bun run dev
```

打开 <http://127.0.0.1:5173/>，使用米家 App 扫码登录。日常运行 `bun run dev`，停止应用与依赖使用 `bun run stop`。新增数据库迁移后需重新执行 `bun run db:migrate`。

本机配置与凭据不提交 Git。恢复已有数据库授权时，还需恢复对应的凭据加密密钥；详见[米家与摄像头](docs/mijia.md)。

## 文档

- [本地运行](docs/running.md)：运行模式、Docker 网络、生产启动与开发命令
- [米家与摄像头](docs/mijia.md)：登录、预览、授权保存与支持范围
- [服务连接配置](docs/service-connections.md)
- [Agent 与对话 API](apps/agent/README.md)
- [后端与数据库](apps/backend/README.md) · [前端](apps/web/README.md)
- [go2rtc 构建](docker/go2rtc/README.md)
- [调用追踪](docs/observability.md) · [错误处理](docs/errors.md)
