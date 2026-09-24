# 聊天人工验收

聊天流程的人工验收适用于可信本机、单 Agent 进程。服务连接成功和静态检查不能证明真实模型多轮对话、重启续聊、并发、超时和取消已通过。

## 前置条件

按[运行说明](../README.md)设置 `AGENT_MODEL`、`OPENAI_API_KEY` 并完成数据库初始化，确认连接 YAML 中的 Agent 地址与实际监听地址一致，再启动服务。接口与持久化语义见 [Agent 说明](../apps/agent/README.md)。不要将 API key 放入命令行或验收记录。

## 人工步骤

1. **首次对话**：启动 backend 和 Agent，向 backend 的 `POST /api/chat` 发送一条包含随机记忆短语的消息。记录返回的 `X-Thread-Id`，确认收到 `run_started`、`token` 和唯一的 `run_completed`。
2. **同会话续聊**：只发送本次问题及前一步的 `threadId`，询问记忆短语，确认能从会话历史回答。
3. **重启续聊**：等待上一步完成，正常停止并重新启动 Agent，保持数据库不变，再用同一 ID 询问短语。确认能恢复历史。
4. **并发拒绝**：发起需要较长输出的请求，在首个请求尚未结束时向同一 ID 发送第二个请求，确认第二个返回 JSON 409。首个结束后同一 ID 应能再次接受请求。
5. **运行超时**：单独启动 Agent 时临时设置 `AGENT_RUN_TIMEOUT_MS=1000`，请求较长输出；backend 的期限应更长。若模型提前完成，增加输出需求再观察。确认收到唯一的 `run_failed`，错误为 `error.code = run_timeout`，随后 EOF；不要出现先完成再失败的双终止事件。
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
