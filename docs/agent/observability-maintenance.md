# Agent 观测维护决策

观测用于排查执行过程和提供评测材料，不拥有业务状态，也不替代任务存储与恢复。配置和使用限制见[共享追踪说明](../../packages/observability/README.md)。

## 适配与维护

保留工作区观察器，是因为模型回调不能覆盖会话、提交及工具的完整执行状态。来源与许可证见 [Pi Durable 观测适配](../../packages/pi-langfuse/README.md)。

Pi 摘要观测和部分 OpenTelemetry 导出适配依赖上游内部接口，升级时需结合[当前源码](../../packages/observability/src)、[依赖配置](../../package.json)及[MiMo 协议补丁](../../patches/@earendil-works%252Fpi-ai@1.5.2.patch)核对。重点是记录是否完整、模型和工具是否重复计数、关闭能否释放资源，以及观测失败是否影响业务结果。

上游提供满足现有需求的稳定接口后，优先替换本地适配；以减少总维护成本为准，不另加兼容层。具体调用顺序和接口定义直接查源码。

项目使用 [OpenTelemetry SDK 3.x](https://github.com/open-telemetry/opentelemetry-js/blob/main/doc/3.x/migration-guide.md)。[Langfuse 处理器](https://github.com/langfuse/langfuse-js/tree/main/packages/otel)的 peer dependencies（依赖版本约束）尚未声明支持这一代 SDK；当前使用自定义 OTLP exporter 接入，不能据此视为上游承诺兼容。升级时需核对处理器、导出、父子关联和媒体处理的实际行为。

## 使用边界

追踪中的 Session 仅用于多轮记录分组。两个主 Agent 的会话保存在 MySQL，恢复能力由[会话存储](../../apps/agent/README.md#会话存储)提供。

请求取消后，已经开始的后台执行可能继续；该请求的评测材料可能不完整。评测必须明确取消、超时和缺失结果的处理方式，不能直接将其计为模型回答失败。
