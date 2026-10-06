# 共享模型连接

`@home-agent/model` 提供 OpenAI 兼容模型工厂和配置 schema，供家庭助手和 backend 语音判断复用。业务提示词、输出 schema 和接纳规则留在各自领域模块。

`loadModelConfig()` 读取 `AGENT_MODEL`、`OPENAI_API_KEY`、可选 `OPENAI_BASE_URL` 与 `AGENT_THINKING`。`createModel()` 接受调用方的超时、输出预算和重试选项；缺少模型或凭据时返回 `undefined`。配置错误仅报告字段名，不输出凭据。
