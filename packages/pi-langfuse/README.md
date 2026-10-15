# Pi Durable 观测适配

本包提供 `pi-durable@1.2.0` 的会话事件观察器及共享观测运行时。调用方提供 `TraceBackend`，负责把观测记录转换成所需的追踪字段并导出；本包管理会话、提交、运行和工具观测的关联及结束。

实现取自 [`@narumitw/pi-langfuse@0.52.0`](https://github.com/narumiruna/pi-extensions/tree/366c62e05394371379ec1283fdcefb5f518ceede/packages/pi-langfuse) 的 Durable 部分，固定来源提交为 `366c62e05394371379ec1283fdcefb5f518ceede`。原作者为 narumiruna，授权见 [LICENSE](LICENSE)。工作区保留事件观察、内容投影、共享运行时和后端契约，并按当前 Pi API 处理嵌套工具结果、父工具关系及异常观察器关闭。

工作区适配的保留理由、责任、依赖升级核对及替换条件见 [Agent 观测维护决策](../../docs/agent/observability-maintenance.md)。

## 使用与职责

```ts
import {
  createLangfuseRuntimeFromBackend,
  createPiLangfuseDurableConversation,
} from "@home-agent/pi-langfuse";

const runtime = createLangfuseRuntimeFromBackend(backend);
const tracing = await createPiLangfuseDurableConversation(runtime, {
  harness,
  conversationId: conversation.id,
  context: observationContext,
  sessionId: hostSessionId,
  captureContent: false,
  onError: (stage) => reportObservationFailure(stage),
});
await tracing.dispose();
await runtime.shutdown();
```

本项目的逻辑评测根输入输出与 `metadata.evaluation_context` 由共享 observability 层汇集，模型用量只记录在 Provider generation（一次模型生成记录）。这些评测材料依赖 `OTEL_INCLUDE_CONTENT=true`，不会因子观测属于同一 trace 或 Session 而自动成为 Judge（使用模型评分的评测器）的输入；调用方仍须显式映射所需字段。本包不创建评测器、生成评分或管理评测运行，Langfuse 真实入库和界面展示的验证边界见[共享追踪说明](../observability/README.md)。

## 内容与边界

`captureContent` 默认开启。已提交消息投影为 GenAI 的 `role/parts` 结构，保留角色、文字、推理、工具调用及响应标识，图片以包含 MIME 类型的省略文本表示。内容和元数据通过原生 JSON 序列化复制，保留完整消息、集合与文字；连续性签名、识别出的凭证字段及内嵌 base64 媒体被过滤，错误结果不包含原始错误正文。该投影不修改模型输入、工具结果或已提交条目。无法序列化的观测数据按观察错误报告，不生成替代消息或截断标记。

模型发起的工具结果取自提交后的 `ToolResultEntry.model`，剔除最后的诊断文本块；嵌套调用取自 `NestedToolExecutionResult`，记录结构化输出、错误状态、用量、耗时和已观察到的父工具。开启内容采集时，工具详情也经过内容投影。

观察器以附着时的快照作为起点。事件队列溢出时关闭未完成的模型和工具观测，标记历史不完整，再核对已知提交。它不重建遗漏的执行、历史重试或跨进程追踪，观测时间也不等于真实模型请求时间。模型请求输入、图片负载和首 token 时间应由调用方的模型适配器采集；若同时启用模型适配器，后端需避免重复导出模型观测与用量。

运行结果以主提交的最终状态为准。`run_end` 先记录结束时间，待收到主提交的 `done` 或 `unanswered` 状态后结束运行观测；期间可以独立观察下一次运行。模型或工具尝试失败后仍成功回答的运行保持成功，最终模型错误、缺少模型或任务故障标记为错误。停止观察时，未核对最终状态的运行按观察中断关闭，使用 `WARNING` 和 `pi.durable.observation_incomplete=true`；这表示观测不完整，不推断实际执行失败。调用方取消一次 HTTP 等待不等于取消所有 Durable 工作，观察器独立跟随已提交状态直至释放。
