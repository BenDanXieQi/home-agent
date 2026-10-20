# Agent 观测维护决策

本文维护当前观测适配的保留理由、代码责任、升级核对和替换条件。配置、追踪字段、Session（多轮追踪分组）关联及实际验证范围统一由[共享追踪说明](../../packages/observability/README.md)维护；会话执行、取消及存储边界见 [Agent README](../../apps/agent/README.md)。本文不把待交付能力描述为当前功能。

## 责任边界

| 边界                                                                                                                                             | 维护责任                                                                                                                                                   |
| ------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`packages/pi-langfuse`](../../packages/pi-langfuse)                                                                                             | 根据 Pi Durable 已提交事件维护提交、运行和工具的观测生命周期，投影内容并释放观察器；来源提交和许可证由[包说明](../../packages/pi-langfuse/README.md)维护。 |
| [`observability/durable.ts`](../../packages/observability/src/durable.ts)                                                                        | 把观察器接到 OpenTelemetry（OTel）原生 span，关联提交来源、有限运行及实际模型／工具执行，处理观测错误。                                                    |
| [`durable-compaction.ts`](../../packages/observability/src/durable-compaction.ts)                                                                | 在原生摘要执行阶段恢复观测上下文，保留内置压缩算法与任务语义。                                                                                             |
| [`langfuse-exporter.ts`](../../packages/observability/src/langfuse-exporter.ts)、[`telemetry.ts`](../../packages/observability/src/telemetry.ts) | 分别配置 Langfuse 导出目的地和进程级 SDK；序列化、批量发送、重试、刷新及关闭由 OTel 组件执行。                                                             |
| Agent 应用与 workflow                                                                                                                            | 拥有会话、工作环境、领域结果、执行取消及存储；观测层不接管这些领域状态。                                                                                   |

## 工作区 Pi Durable 观察器

请求边界统一使用 [`agent-operation.ts`](../../packages/observability/src/agent-operation.ts) 管理业务 span、评测上下文及最终结果记录；Agent 的主助手与 Workflow 观察适配器负责各自输入输出的投影。共享 [`durable-execution.ts`](../../packages/observability/src/durable-execution.ts) 装配模型上下文和 Generation／Tool hooks，工具取消由框架和工具实现管理。Agent Runtime 的 [Harness 观测适配](../../apps/agent/src/harness.ts)统一接入观测扩展、附着与分离观察器、关联提交来源并随 Conversation 关闭释放追踪资源，具体 Workflow 只管理领域会话的使用时机。提交 ID 由 Durable 提交适配器记录；生命周期终态由已提交事件观察器确认。

观察器通过 `ObservationSource` 显式传递会话、提交、运行和工具身份；`observability/durable.ts` 负责将这些身份关联到原生 span，名称和 metadata 不承担接口分派。会话分离或运行时关闭遇到观察器释放、刷新错误时，仍清理本地观测及关联映射，错误继续交给调用方处理。

保留工作区适配，因为当前需要读取已提交的 Submission（输入提交）、运行及工具终态，并处理晚附着、事件重同步和观察器关闭。模型调用本身的回调不能覆盖这些状态。包名保留来源关系，但工作区代码由本项目负责，不假定来源包自动支持当前 Pi API，也不持续合入与项目无关的来源功能。

当前 Pi 版本以根 [`package.json`](../../package.json) 的统一依赖配置为准。升级 Pi 或同步来源代码时，核对以下直接使用的契约：

1. `watchEvents()` 的初始快照、事件批次、队列溢出后的快照替换、监听关闭及 `stop()` 的完成语义。工作区补丁为 `stop({ drain: true })` 增加排空停止：冻结新事件，等待已排队的批次和当前异步监听器处理完成；取消、Session 关闭及监听错误仍能中断排空。观察器释放先等待排空，再取消自身上下文；不能在监听器内等待排空停止。读取状态不得调用会启动恢复的 `wait()`。
2. `run_start`／`run_end`、运行 `inputs`、主提交 ID 与 Submission 的 `done`／`unanswered` 终态。运行结束事件与终态提交的先后不能导致提前结束或重复创建运行观测。`subscribeCommits()` 必须在提交返回前同步登记新提交，观察器释放时取消订阅；该登记区分新提交的事件积压与未覆盖的历史提交。提交等待适配依赖工具结束事件先于提交终态事件交付；只有观察器处理该终态后，正常完成的业务请求才结束评测。附着前或初始化期间无法确认覆盖的提交保守标记不完整，已完整处理的提交复用原观测结果；幂等重提不等待不存在的新事件。观察器不可用、观察失败、历史缺口及关闭必须解除观测等待，并在提交来源和关联业务评测根标记不完整。
3. 普通工具的 `ToolResultEntry.model` 与嵌套工具的 `NestedToolExecutionResult`，包括父调用标识、结构化输出、诊断、错误状态和用量。内容投影继续遵守[包内内容边界](../../packages/pi-langfuse/README.md#内容与边界)。
4. 观察器与 Harness 各自的关闭责任、单次会话附着、幂等释放及共享运行时刷新。启用追踪时，提交前必须已有观察器；缺失属于调用顺序错误，应在接纳提交前报错。已有观察器失效等观测错误必须保留原执行结果；停止观察不能取消任务。
5. Provider（模型服务提供者）拥有模型生成记录时，观察器仍只维护运行与工具，不重复导出模型调用及用量。提交来源、父子会话、多个输入来源及正文开关的核对范围见[追踪链路](../../packages/observability/README.md#追踪链路)。

只有替代方案覆盖上述实际需要的生命周期、内容控制和关闭语义，并减少总维护成本，才替换工作区观察器。Pi 的 [TelemetryContext](https://github.com/earendil-works/pi/blob/v1.2.0/packages/telemetry/README.md) 是显式传递的观测回调契约，不提供导出器；当前 pi-ai 接受并转发它，当前 Durable 的 Harness 接口没有对应的完整生命周期接入。仅增加一个 TelemetryContext 适配器不能替代提交和运行观察，也不能自动建立 Langfuse 评测材料。

## 内置压缩阶段包装

`observeDurableRegistry()` 通过公开 `RegistryReader`（Harness 读取扩展与任务定义的接口）替换内置 `CompactionTask` 的 `summarize` 阶段入口，再调用原阶段。保留这一包装，是为了把真实摘要模型调用归入对应的有限观测；仅在摘要选取前执行的 hook 不能覆盖阶段恢复和实际请求。包装不复制压缩算法、摘要提示词、重试或状态迁移。

原生注册器将内置任务声明为不可替换；这里的自定义 Reader 装饰属于本项目对固定 Pi 版本的适配，不能视为上游承诺稳定的扩展方式。相关依赖必须与阶段接口一起核对。

升级 Pi 时，核对 `CompactionTask.definition`、`phases.summarize` 的参数与返回约定、`RegistryReader.snapshot()` 的任务查询及订阅接口，并核对以下行为：

1. `task.owner`、`task.background`、`LiveDoc.run.taskId` 仍能区分阻塞当前生成的摘要与独立后台／手动摘要；执行信号与真实模型请求信号仍能关联。
2. 摘要阶段可在正常返回时提交失败或重试状态。观测必须读取已提交的任务状态，不能把正常返回一律视为摘要成功；观测读取失败不改变原任务结果。
3. 从 `summarize` 阶段恢复时仍建立正确上下文，模型记录与用量只有一份；包装继续调用目标版本的原阶段。

Pi 升级还须分别核对现有 [Pi 补丁](../../patches/@earendil-works%252Fpi-durable@1.2.0.patch)中的 SystemEntry 顺序修复与事件排空停止是否已有上游实现，再决定移除对应修改。不能因版本号变化直接删除，也不另加历史版本分支。

当 Pi 提供覆盖真实摘要调用、阶段恢复、已提交终态和显式父上下文的公开观测入口时，可用该入口替换阶段包装。单纯出现新的压缩选择 hook 不满足这一替换条件。实际压缩与恢复的验证边界仍以[共享追踪说明](../../packages/observability/README.md#追踪链路)为准。

## OTel 底层导出组件

Langfuse 出口直接组合 OTel 的导出基类、HTTP 传输和 protobuf 序列化组件。保留这一适配，是为了显式配置 Langfuse 的地址、认证和接收协议版本，同时让独立 Collector（集中接收追踪数据的服务）的 `OTEL_EXPORTER_OTLP_*` 环境配置只作用于 Collector。适配不自行实现网络重试、批量队列或序列化。

这些入口由上游包发布，但 `@opentelemetry/otlp-exporter-base` 和 `@opentelemetry/otlp-transformer` 属于上游内部组件；公开可导入不等于稳定 API。升级时统一核对根依赖配置中的 SDK、OTLP exporter、exporter-base 与 transformer，重点包括：

1. `OTLPExporterBase`、`createOtlpHttpExportDelegate`、`httpAgentFactoryFromOptions`、`ProtobufTraceSerializer` 和 `TraceExporterMetricsHelper` 的导出路径、签名及生命周期要求。
2. Langfuse 地址、Basic Auth、protobuf 内容类型和 `x-langfuse-ingestion-version` 的实际发送值。显式配置 Collector 的地址与 headers 后，Langfuse 仍使用自己的目的地配置。
3. 导出期限、连接复用、重试、`forceFlush()` 与 `shutdown()` 的默认值及责任；应用关闭顺序继续由 SDK 和现有会话所有者管理。
4. 同时启用两个目的地时，Agent 筛选仍只作用于 Langfuse，通用 Collector 保留原有采样语义；关闭 Langfuse 和关闭全部导出仍按[配置契约](../../packages/observability/README.md#配置)分别生效。

当维护中的上层 exporter 或官方 Langfuse 组件能够显式隔离目的地配置、支持当前接收字段并复用已有 NodeSDK 时，优先评估替换底层组合。替换应能删除这些内部入口依赖，并保留当前采样、Agent 筛选、取消与关闭行为；仅为隐藏底层接口增加一层项目包装不会降低维护成本。

已有 Collector 的部署也可使用[官方转发方案](https://langfuse.com/integrations/native/opentelemetry#export-from-opentelemetry-collector)：应用只向 Collector 导出，由两个处理通路分别保留通用追踪、筛选 Agent 记录并各自配置认证。该方案可移除应用内的低层 Langfuse 出口，同时把依赖转为 Collector 的部署与配置责任；当前直接导出方式不要求额外部署 Collector。

## 后台任务评测边界

Workflow 的业务 `.run` 评测根由统一执行入口的观察适配器建立，覆盖本次请求的提交、等待、结果校验和错误归一化；输入与最终结果在开始、完成回调中采集，具体 Workflow 不持有 span 或记录评测结果。模型与工具继续由 Provider 适配器、Durable hooks 及已提交事件观察器采集，避免重复生成过程记录。主助手的业务评测根覆盖本次请求的提交、等待及结果校验。HTTP 等待取消后，已经开始的 Durable 执行可以继续，但不会补写已经结束的业务评测根。因此，仍存在运行观测不等于该请求具备完整评测输入、轨迹和最终结果。字段、内容开关及 Judge（用模型对给定材料评分）的映射要求见[追踪链路](../../packages/observability/README.md#追踪链路)。

配置请求结果评测时，必须明确取消、超时和缺失结果的记录是否属于评测样本，不能把未返回结果直接计为模型回答失败。若业务开始要求评价客户端断开后的完整任务，交付条件是有限的 Durable 运行拥有完整评测生命周期、已提交输入及领域终态结果，并避免同一任务产生重复逻辑评测根。延长 HTTP span、补写已结束的 span 或只变更一个评测标记不能满足这一要求。

## Session 与重启恢复边界

Session 用于把多轮追踪归组，不能据此推导对话或任务已保存到磁盘。主助手与空间规划仍使用 `MemoryStorage`，服务重启后会话、任务及应用内会话映射清空；观察器不会重建跨进程追踪。当前 Session 关联策略及其验证范围由[共享追踪说明](../../packages/observability/README.md#追踪链路)维护。

当业务需要跨重启继续任务或保留长期会话时，恢复能力的交付范围必须包括持久存储、稳定工作环境、应用会话映射、观察器重新附着、任务恢复策略及重复提交处理。优先使用 Pi 已有的 [SQLite／JSONL 存储与恢复接口](https://github.com/earendil-works/pi/blob/v1.2.0/packages/durable/README.md#persist-and-resume)。只替换存储对象或保留 Session ID，不代表这些应用责任已经完成；也不把进程内 TelemetryContext 或 OTel 原生上下文写入持久记录。
