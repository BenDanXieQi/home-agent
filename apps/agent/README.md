# Agent

## 媒体分析

[媒体分析模块](src/perception/analysis.ts)接收调用方已有的 MP4 视频、M4A 音频或按时间排序的图片序列，以及结构化的场景上下文、身份候选和参考资料，流式调用 MiMo、Qwen、Gemini 并校验、归一化分析结果。媒体编码、参考图编码和调用调度由调用方负责；模块不接入 Backend 或启动持续消费。提示词 `perception` 由[现有初始化入口](../../docs/agent/prompt-management.md#初始提示词)准备。

```ts
import { createMediaPerception } from "@home-agent/agent/perception";

const perception = createMediaPerception({
  provider,
  model,
  modelCollection,
  prompts,
});
const result = await perception.analyze({
  media: {
    kind: "video",
    data: videoBytes,
    fps: 1,
    hasAudio: true,
    hasSpeech: true,
  },
  context: { homeProfile, rules },
  identity: { candidates, gallery },
  pets,
  panorama,
  signal,
});
```

成员、宠物参考图和可选全景图均使用已有的 `ImageContent`。人物框 `bbox` 必须对应主视频最后一帧或图片序列最后一张主画面，坐标归一化到 `[0, 1000]`；裁切或缩放视频时，调用方须同步调整位置。输入类型见 `MediaAnalysisInput`，结果规范见 [session.ts](src/perception/session.ts)。返回的 `usage` 统一记录输入、输出、缓存、音频和视频 token；供应商未返回的用量记为 0。响应按 MiLoCo 提取 JSON 并逐项归一化，无法解析时返回 `skipped: true`；宠物判定仅记录审计日志。

识别具体宠物需要可辨别的参考图片或 `homeProfile` 中的外观资料；只有名字和物种不足以确认身份，依据不足时使用泛称。

图片序列使用 `media: { kind: "images", frames, durationSeconds, audio, hasSpeech }`：`frames` 为非空 `ImageContent` 数组，按拍摄时间从早到晚排列；`durationSeconds` 是实际采集窗口时长（正数），模块据此计算采样率。可选 `audio` 为同一窗口的 M4A 字节，`hasSpeech` 表示其中是否有人声。参考图在主画面序列之前，独立音频在序列之后；模型须支持所用模态的组合输入。图片模式会调整模板措辞，家庭档案、规则、待续接语音和机位说明原文保持不变。已有 Langfuse `perception` 提示词须同步[初始模板](prompts/perception.json)末尾的图片序列用户模板；初始化命令不会更新已有版本。

`provider` 为 `mimo`、`qwen` 或 `gemini`。MiMo、Qwen 使用已配置的 `openai-completions` 模型，Gemini 使用原生 `google-generative-ai` 模型。Qwen 需要调用方注册实际支持媒体的百炼 Omni 端点模型；内置 Coding Plan 模型不适用。默认最大输出 512 tokens、`temperature: 0.1`、`topP: 0.95`，模型 HTTP 请求超时 30 秒，可通过 `options` 调整。超时沿用各 SDK 的原生机制，与 MiLoCo 的 httpx 分阶段超时语义不同。

Gemini 的思考配置由现有模型 SDK 按模型能力处理，也可通过 `options.reasoning` 指定支持的思考级别（仅对 Gemini 生效）；Gemini 2.5 Pro 应显式设置为 `"minimal"` 或更高级别。无法完全关闭思考的模型仍会消耗思考 tokens，最大输出预算包含这部分消耗，返回的 `usage.output_tokens` 也包含它们。`options.mediaResolution` 为 `"default"`（默认，沿用模型的媒体分辨率）或 `"high"`，同时影响主画面和参考图；适用范围见 Google 的[思考配置](https://ai.google.dev/gemini-api/docs/generate-content/thinking)与[媒体分辨率](https://ai.google.dev/gemini-api/docs/generate-content/media-resolution)说明。

提示词与供应商请求参考 [MiLoCo 固定源码](https://github.com/XiaoMi/xiaomi-miloco/tree/a48c1812562e786806647ca06abf02c0a3226485/backend/miloco/src/miloco/perception/engine/omni)。真实端点尚未完成实机验收。

## Workflow 扩展

每个 `src/workflows/<name>/workflow.ts` 必须导出 `extensions`，声明所需的运行时扩展；没有扩展时导出 `[] as const`。运行 `bun run --cwd apps/agent generate` 自动汇总声明，无需修改宿主。具体对话显式选择所需扩展。

扩展和文档定义可以在模块内复用，会话状态由对应的对话持有。浏览器通过 `backend-client` 构建边界使用 Workflow 契约；扩展定义的初始化应能在未使用时被构建工具移除。

会话的流式文本与完整回答由通用进度通路交付，完整回答先于成功结果发送。空间规划结果只包含规划状态与会话信息，不另行返回回答正文。
