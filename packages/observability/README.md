# Observability

共享 OpenTelemetry（OTel，追踪标准）接入，支持控制台、Collector 和 Langfuse。Langfuse 仅接收 Agent 执行相关记录，通用导出保留已采样的常规追踪。

## 配置

在根目录 `.env` 中配置追踪，应用启动见[本地运行](../../docs/running.md)。可选的本地 Langfuse 与依赖统一由 `home-agent` Compose 项目管理，开关及初始化见[本地 Langfuse](../../docs/running.md#可选的本地-langfuse)。

本地查看 spans：

```dotenv
OTEL_TRACES_EXPORTER=console
LANGFUSE_TRACING_ENABLED=false
```

直接导出到 Langfuse：

```dotenv
OTEL_TRACES_EXPORTER=otlp
LANGFUSE_PUBLIC_KEY=你的项目公钥
LANGFUSE_SECRET_KEY=你的项目密钥
# LANGFUSE_BASE_URL=https://cloud.langfuse.com
```

两个服务必须使用同一 Langfuse 项目的公钥、密钥和服务地址。省略 `OTEL_TRACES_EXPORTER` 时，配置通用 Collector 地址或启用 Langfuse 项目密钥会自动启用 `otlp`，否则默认关闭；显式 `none` 关闭所有追踪导出。`LANGFUSE_TRACING_ENABLED` 默认 `true`，填写两个项目密钥后启用 Langfuse；设置为 `false` 仅关闭 Langfuse，通用 console 或 Collector 导出仍按自身配置运行。该开关可写入 `.env`，也可在根启动命令前通过进程环境覆盖，例如 `LANGFUSE_TRACING_ENABLED=false OTEL_TRACES_EXPORTER=console bun run start`。默认服务地址为 `https://cloud.langfuse.com`；`COMPOSE_PROFILES` 包含 `langfuse` 时默认使用 `http://localhost:${LANGFUSE_PORT}`（端口默认 3001）。显式地址优先于本地默认；其他区域或自托管实例通过 `LANGFUSE_BASE_URL` 设置其基址，不含 API 路径。默认关闭模型输入输出采集；需要在 Langfuse 检查对话内容时设置 `OTEL_INCLUDE_CONTENT=true`，这也会包含详细异常消息。

无需 Collector（集中接收并转发追踪数据的服务）即可使用。若已经有 Collector，设置完整的 `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`，例如 `http://127.0.0.1:4318/v1/traces`，或设置不含信号路径的 `OTEL_EXPORTER_OTLP_ENDPOINT`。自定义 endpoint 使用 OTLP/HTTP protobuf exporter 和标准 `OTEL_EXPORTER_OTLP_TRACES_HEADERS` / `OTEL_EXPORTER_OTLP_HEADERS`（逗号分隔、值可 URL 编码），不会自动收到 Langfuse 密钥。应用可同时把完整的已采样记录发送到该 Collector，把 Agent 相关记录直接发送到 Langfuse；两套认证配置独立。通用 endpoint 应指向 Collector 或 APM（应用性能监控平台）。Collector 若另行转发给 Langfuse，须在该转发通路按 `home_agent.trace.agent=true` 过滤并配置认证；不要把通用 endpoint 直接指向同一个 Langfuse 接收地址，以免绕过筛选或重复发送。

媒体不单独上传到 Langfuse 对象存储；开启内容采集时图片原始 base64 随模型 span 发给目标 exporter。大图片会增大 OTLP 请求体，接收端限制及 Langfuse 媒体展示尚未实机验证；本项目不保证原生 OTLP 图片在界面中自动渲染。

## 追踪链路

使用 trace ID 排查一次调用，使用 Session 查看同一会话的多轮记录。响应头 `x-trace-id` 和 Backend 日志中的 `trace_id` 可用于关联。显式设置 `OTEL_PROPAGATORS` 时须保留 `tracecontext` 与 `baggage`。

HTTP 记录不自动采集请求和响应正文；Langfuse 的输入输出筛选可能隐藏这些记录。模型输入输出和详细错误受内容采集开关控制，提示词版本管理见[提示词说明](../../docs/agent/prompt-management.md)。用量以供应商实际返回为准，缺失时不估算；自定义模型价格需在 Langfuse 中配置。

评测需要开启内容采集，并显式映射任务、结果和 `metadata.evaluation_context` 中的材料。本包不创建评测器或评分。请求取消、追踪中断及历史缺口可能使材料不完整；Session 分组不保证任务恢复或历史完整。

普通聊天及工具失败追踪已在本机核验。大图片的接收限制及媒体展示尚未实机验证。

维护原则见[观测维护决策](../../docs/agent/observability-maintenance.md)，接口与字段以[源码](src)为准。
