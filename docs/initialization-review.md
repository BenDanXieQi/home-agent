# 初始化验收

本次收尾范围是可信本机、单 Agent 进程的开发骨架，不包含鉴权、跨进程调度或设备控制。未新增测试；保留并运行已有 backend 测试。

## 已完成的检查

- `bun install --frozen-lockfile`：通过，依赖无需变更。
- `bun run check`：格式、lint、类型检查通过。外部 `.agents/skills` 保留上游格式，不纳入项目格式化；`.pnpm-store` 同时排除格式化和 Git。
- `bun run build`、`bun run test`：通过；已有两项测试仅覆盖 backend 健康接口和未知 API。
- Hono CLI 请求检查：Agent 超限请求返回 JSON 413；缺少模型和缺少数据库配置分别返回明确的 JSON 503。
- `bun run db:check`：本机 PostgreSQL 18.6、TimescaleDB 2.30.1 可读取。
- MiLoCo 参考已改为 AGENTS.md 中的本机外部项目路径，本仓库不再包含源码副本或 submodule。

## 模型验收仍待完成

检查时 `.env` 和进程环境均无 `AGENT_MODEL`、`OPENAI_API_KEY`，因此不能声明真实模型多轮对话、重启续聊、并发、超时和取消已通过。配置凭据后，按 README 完成数据库初始化，再人工执行以下步骤。不要将 API key 放入命令行或验收记录。

1. **首次对话**：启动 backend 和 Agent，向 backend 的 `POST /api/chat` 发送一条包含随机记忆短语的消息。记录返回的 `X-Thread-Id`，确认收到 `run_started`、`token` 和唯一的 `run_completed`。
2. **同会话续聊**：只发送本次问题及前一步的 `threadId`，询问记忆短语，确认能从会话历史回答。
3. **重启续聊**：等待上一步完成，正常停止并重新启动 Agent，保持数据库不变，再用同一 ID 询问短语。确认能恢复历史。
4. **并发拒绝**：发起需要较长输出的请求，在首个请求尚未结束时向同一 ID 发送第二个请求，确认第二个返回 JSON 409。首个结束后同一 ID 应能再次接受请求。
5. **运行超时**：单独启动 Agent 时临时设置 `AGENT_RUN_TIMEOUT_MS=1000`，请求较长输出；backend 的期限应更长。若模型提前完成，增加输出需求再观察。确认收到唯一的 `run_failed`，错误为 `run_aborted_or_timed_out`，随后 EOF；不要出现先完成再失败的双终止事件。
6. **客户端取消**：在流式请求中途关闭客户端；等待执行取消完成后，再请求同一 ID。确认不会永久返回 409，Agent 仍可用。
7. **停机**：请求执行中发送 SIGTERM，确认在排空期限内完成的请求正常结束；超过期限的请求被取消，进程最终退出，重启后数据库仍可用。

请求示例（替换占位 UUID）：

```sh
curl -i -N http://127.0.0.1:3000/api/chat \
  -H 'Content-Type: application/json' \
  -d '{"message":"记住我的验收短语：蓝色纸船"}'

curl -i -N http://127.0.0.1:3000/api/chat \
  -H 'Content-Type: application/json' \
  -d '{"message":"我的验收短语是什么？","threadId":"替换为返回的 UUID"}'
```

客户端应将没有终止事件的 EOF 视为异常，而非成功；失败后自动重发可能重复写入用户输入。人工验收产生的会话包含完整消息，请仅使用无敏感内容的样例。

## 提交范围

提交应用源码、锁文件、配置、迁移、项目文档和需要共享的 skills。`.env`、依赖目录、缓存、构建产物和 `data/` 下的本地备份被忽略；无需提交 MiLoCo 源码、补丁或 submodule 指针。

代码和仓库收尾可提交为初始化骨架；模型验收完成前，提交说明应保留上述验证限制。鉴权/会话归属、多进程协调、上下文裁剪、checkpoint 保留策略、幂等和恢复调度属于后续里程碑。
