# Agent Host

Agent 服务的进程入口与依赖装配工作区。业务实现、workflow Schema 和上下文状态属于 [`apps/agent`](../agent/README.md)，宿主不重复定义协议。

## 运行与构建

开发与生产脚本读取根目录 `.env`。默认监听 `127.0.0.1:1811`，Backend 默认地址为 `http://127.0.0.1:3000`，分别通过 `AGENT_HOST`、`AGENT_PORT` 和 `BACKEND_URL` 配置。主会话必需 `AGENT_DATABASE_URL`（MySQL 连接地址）；本地实例通过 `bun run db:init` 启动。模型配置见 [Agent README](../agent/README.md#模型配置)。

在仓库根目录执行：

```sh
bunx turbo run dev --filter=@home-agent/agent-host
bunx turbo run build --filter=@home-agent/agent-host
bun run --cwd apps/agent-host start
```

单独执行宿主类型检查或 lint 前，先运行 `bunx turbo run build --filter=@home-agent/backend-client`。工作区入口不自动启动 Backend。

## 资源生命周期

宿主创建一个 Chord Host（进程内服务与资源管理器），所有消费者使用同一 Agent 运行时，两个主 Agent 共用 MySQL Harness，Workflow 与子 Agent 使用内存 Harness，业务扩展在打开运行时前统一注册，对话显式选择所需扩展。同时配置 `AGENT_MODEL` 和 `AGENT_MEDIA_ANALYSIS_MODEL` 后启用音视频分析 Agent；具体配置与限制见 [Agent README](../agent/README.md#音视频分析-agent)。[Host 适配](src/context-source.ts)负责初次媒体读取、本地录像补看和动态保存，事件提交给整体主助手。

运行标识变化不触发 Agent 任务取消、Workflow 清理或主会话重置。同一家庭的重启、断线或重新授权保留两个主会话的模型上下文，由框架按容量自动压缩；上下文接收端确认切换绑定家庭时，取消旧执行、清理 Workflow 和临时媒体状态并重置所有已保存主会话的模型上下文，包括当前未启用的 Agent，历史条目保留。接收端把最近确认的绑定随主会话保存，暂时未取得绑定时保留比较依据；读取保存的绑定失败时启动失败，恢复任务须等待收到带有当前家庭绑定的完整快照。关闭时先停止上下文接收，等待媒体任务及会话清理，再按依赖关系关闭 Workflow、主助手、Harness 和执行环境并删除临时工作区。关闭单个规划不关闭公共运行时。

收到退出信号时启动 `AGENT_SHUTDOWN_TIMEOUT_MS` 计时，初始化取消、HTTP 排空和资源清理共用这段预算，默认 10,000 毫秒；重复信号不重置计时。应用装配返回失败时，后续进程资源清理也受该预算约束。没有退出信号时，工厂内部因初始化失败而触发的回收发生在装配返回之前，不受这段计时约束。

预算耗尽后记录错误并强制以退出码 1 结束进程，未完成的请求、清理与追踪刷新可能被中断；正常完成会清除计时器。应用不额外设置模型或 workflow 执行超时，退出不保证长请求完成。阻塞事件循环的同步代码会延迟计时器执行。
