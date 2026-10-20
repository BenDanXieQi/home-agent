# Agent Host

Agent 服务的进程入口与依赖装配工作区。业务实现、workflow Schema 和上下文状态属于 [`apps/agent`](../agent/README.md)，宿主不重复定义协议。

## 运行与构建

开发与生产脚本读取根目录 `.env`。默认监听 `127.0.0.1:1811`，Backend 默认地址为 `http://127.0.0.1:3000`，分别通过 `AGENT_HOST`、`AGENT_PORT` 和 `BACKEND_URL` 配置。模型配置见 [Agent README](../agent/README.md#模型配置)。

在仓库根目录执行：

```sh
bunx turbo run dev --filter=@home-agent/agent-host
bunx turbo run build --filter=@home-agent/agent-host
bun run --cwd apps/agent-host start
```

单独执行宿主类型检查或 lint 前，先运行 `bunx turbo run build --filter=@home-agent/backend-client`。工作区入口不自动启动 Backend。

## 资源生命周期

宿主创建一个 Chord Host（进程内服务与资源管理器），注册 `AgentModels`、`AgentRuntime`、主助手和 Workflow 本地服务。服务通过 `self.get()` 声明依赖，用 `resource()` 管理异步初始化与关闭，并由 `host.ready()` 等待启动完成。所有消费者共享同一运行时实例；业务扩展先统一注册，对话再显式选择自己的扩展。自动化生成与语音判断只依赖模型服务。关闭时先停止上下文接收，再由 `host.close()` 按依赖关系清理 Workflow 和主助手，随后关闭 Harness、执行环境并删除临时工作区。关闭单个规划不关闭公共运行时。

收到退出信号时启动 `AGENT_SHUTDOWN_TIMEOUT_MS` 计时，初始化取消、HTTP 排空和资源清理共用这段预算，默认 10,000 毫秒；重复信号不重置计时。应用装配返回失败时，后续进程资源清理也受该预算约束。没有退出信号时，工厂内部因初始化失败而触发的回收发生在装配返回之前，不受这段计时约束。

预算耗尽后记录错误并强制以退出码 1 结束进程，未完成的请求、清理与追踪刷新可能被中断；正常完成会清除计时器。应用不额外设置模型或 workflow 执行超时，退出不保证长请求完成。阻塞事件循环的同步代码会延迟计时器执行。
