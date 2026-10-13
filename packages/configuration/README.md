# 共享运行配置

`@home-agent/configuration/models` 维护 agent 和 backend 共用的模型环境配置。调用方直接从 `@earendil-works/pi-ai` 导入并使用 `createModels()`、`createProvider()` 和模型请求 API。

`modelEnvironment` 与 `loadModelConfig()` 读取 `AGENT_PROVIDER`、`AGENT_MODEL`、`OPENAI_API_KEY`、可选 `OPENAI_BASE_URL`、`AGENT_THINKING` 和 `AGENT_MODEL_METADATA`。配置错误仅报告字段名，不输出凭据。

`modelProviderSettings()` 生成 pi-ai 原生的服务提供者配置；缺少模型或凭据时返回 `undefined`。`AGENT_PROVIDER` 是 pi-ai 原生 provider ID，默认 `openai`。通过 pi-ai 内置模型集合按 provider 和模型 ID 查找，保留模型的 API、输入能力、容量、成本、图像限制及思考协议参数。应用只注册所选模型，模型清单只在进程装配时加载，不在每次请求中查询或联网刷新。

当前支持 `openai-completions` 和 `openai-responses` 两种原生 API。OpenAI 模型使用清单中的 Responses API；MiMo 中国区套餐可配置：

```dotenv
AGENT_PROVIDER=xiaomi-token-plan-cn
AGENT_MODEL=mimo-v2.6-flash
OPENAI_API_KEY=你的项目密钥
```

未设置 `OPENAI_BASE_URL` 时使用所选模型的原生地址；覆盖地址时，调用方须确认该端点支持所选模型的协议及能力。`AGENT_THINKING` 合并进模型的原生采样参数，不改变模型是否具有思考能力。请求期限、重试和每次调用的输出预算由调用方通过 pi-ai 原生请求选项指定。

## 自定义模型与已验证的能力覆盖

模型不在所选 provider 清单中时，必须同时设置 `OPENAI_BASE_URL` 和 `AGENT_MODEL_METADATA`。后者是 JSON 对象，明确提供 `api`、`reasoning`、`input`、`contextWindow`、`maxTokens`、`cost` 和 `compat.supportsStrictMode`；不猜测图像支持、容量或严格工具支持。该对象也可覆盖清单中模型的这些字段，`compat` 按字段合并并保留未覆盖的原生协议参数。覆盖时 `api` 必须与清单一致；不同协议使用自定义 provider 和完整元数据，避免继承不适用的协议能力。

以下字段格式示例使用演示值，部署时替换为端点的已验证能力：

```dotenv
AGENT_PROVIDER=your-provider
AGENT_MODEL=your-model
OPENAI_BASE_URL=https://your-provider.example/v1
AGENT_MODEL_METADATA='{"api":"openai-completions","reasoning":false,"input":["text"],"contextWindow":32768,"maxTokens":4096,"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0},"compat":{"supportsStrictMode":true}}'
```

`cost` 的单位是每百万 token 的美元价格；未获得价格时可明确填写零，表示 Pi 本地未配置费用估算，不会作为供应商实际费用导出到 Langfuse。Langfuse 根据实际用量和其项目中的模型价格推算费用。

`compat` 还接受已验证的 `supportsDeveloperRole`、`supportsReasoningEffort`、`supportsStore`、`maxTokensField`、`requiresReasoningContentOnAssistantMessages` 和 `thinkingFormat`。其他协议差异使用 pi-ai 已支持的原生模型定义，不能仅凭“OpenAI 兼容”开启选项。自动化与语音判断要求严格工具输出；声明不支持严格工具的模型不能完成这两项能力。

模型 ID、元数据或 API 不受支持时，启动报告配置错误。配置能力不等于供应商请求已成功，`/health` 的 `modelConfigured` 只反映本地装配状态。
