# Agent 提示词版本管理

Agent 使用 Langfuse Chat Prompt（按消息角色组织的提示词）管理系统指令、每轮用户消息模板和工具的 `description`。工具参数定义及其字段说明、执行逻辑和业务校验由代码负责。对话压缩使用 Pi Durable 内置摘要提示词，不从 Langfuse 读取；摘要调用仍纳入追踪。

## 配置与使用

按[本地运行](../running.md#可选的本地-langfuse)配置 Langfuse 项目密钥和地址。`AGENT_PROMPT_LABEL` 指定使用的版本标签，默认 `production`；开发环境可使用 `staging`。

`bun run dev` 会检查所需提示词并初始化缺失项；手动部署时，在 Langfuse 中准备与调用方名称一致的 `chat` 提示词，并赋予所选标签。当前入口使用 `household-assistant`、`spatial-planning`、`automation-generation`、`speech-interpretation`、`media-agent` 和 `media-analysis-agent`。

各调用入口使用以下格式；消息正文支持 `{{变量}}`：

家庭助手、媒体主会话、子会话及三个 Workflow 均使用前置 `system` 消息，最后一条为 `user` 模板，正文中必须包含一次 `{{input}}`。

模板中的 `{{input}}` 由本项目适配层作为原始文字／图片内容块的插入位置处理，必须按此形式填写一次；其余文字变量由 Langfuse 编译。原始内容块的顺序、字段以及文字中的 `{{…}}` 均原样保留。不使用独立的消息占位符块。

家庭助手的 User 正文为 `{{input}}`。空间规划在同一个 User 正文中使用 `{{input}}`、`{{questions}}` 和 `{{draft}}`，后两者表示本轮提交时已保存的状态；会话开始时另提供系统变量 `mijia_rooms`。自动化生成和语音判断把序列化后的请求作为 `{{input}}` 插入的原始文字内容，自动化生成另提供系统变量 `definition_schema`。

媒体主会话使用 [`media-agent`](../../apps/agent/prompts/media-agent.json) 结合历史决定补看或交接，工具说明随提示词版本管理；独立子分析使用 [`media-analysis-agent`](../../apps/agent/prompts/media-analysis-agent.json)，接收中文背景资料、镜头描述与实际媒体，返回中文描述。两者均使用 `{{input}}` 用户模板。用法见 [Agent README](../../apps/agent/README.md#音视频分析-agent)。新环境可运行下方 `prompts:init` 命令初始化缺失项；已有版本须自行同步模板，初始化不会覆盖它。

Config 中的 `sections` 只按顺序配置前置系统消息的段落名称和 `tag`，不包含用户消息，不存放正文；省略整个配置时，各系统段落均不加标签。填写时须覆盖全部系统消息，段落名称不得重复，`tag` 省略时为 `true`。初始模板及省略 `thinkingLevel` 时默认使用 `medium`，由 Pi 按模型支持的档位映射；只有开关的思考模型会启用思考，不支持思考的模型不启用。`tools` 的配置边界见 [prompts.ts](../../apps/agent/src/prompts.ts)。模板语法见 [Langfuse 变量说明](https://langfuse.com/docs/prompt-management/features/variables)。

`tools` 按工具名配置说明，例如 `{"name":"subagent","description":"委派任务并返回结果"}`，随提示词版本一起管理。每项只填写 `name` 和 `description`，不填写参数 Schema。

业务模块负责读取数据、提供模板变量及校验结果，接入方式见 [prompts.ts](../../apps/agent/src/prompts.ts) 和 [harness.ts](../../apps/agent/src/harness.ts)。`systemVariables` 和 `userVariables` 分别用于系统模板和用户模板，均支持对象、同步函数或异步函数，变量不跨角色合并。会话入口通过 `prompt` 配置：系统变量在创建会话时求值，用户变量在每次提交时求值。系统变量函数接收执行上下文，会话的用户变量函数接收当前会话及执行上下文。用户变量配置不自动传给子会话。会话历史、工具执行和压缩由 Pi Durable 管理。

通过 Langfuse UI 或官方 CLI 编辑版本、移动标签及回退。运行服务不会创建提示词或发布版本。CLI 使用根目录 `.env` 中的密钥，须另行指定实际服务地址：

```sh
bun run --bun langfuse --env .env --host http://localhost:3001 api prompts help
```

## 初始提示词

[初始提示词文件](../../apps/agent/prompts/)保存一套可用于新环境的正文、Config、标签和 tags。每个 JSON 文件对应一个提示词，采用 Langfuse 创建接口的请求格式；工具配置只包含 `name` 和 `description`。

`bun run dev` 会在 Langfuse 就绪后、启动应用前执行提示词检查。缺失的提示词从这些文件创建为版本 1，并设置 `AGENT_PROMPT_LABEL` 指定的标签（默认 `production`，`latest` 由 Langfuse 自动设置）；已有提示词不会被覆盖或新增版本。已有提示词缺少所选标签时会报错，需在 Langfuse 中指定版本。认证、连接或 API 错误会中止启动，不会当作提示词缺失处理。

也可从仓库根目录单独执行相同检查，连接地址和项目密钥使用 `.env`：

```sh
bun run --cwd apps/agent prompts:init
```

未配置两个项目密钥时跳过检查；仅配置一个密钥时报错。应用运行期间只读取提示词，后续编辑与发布在 Langfuse 中进行。

## 使用限制

- 会话固定创建时取得的系统指令、用户消息模板及工具配置；移动标签不会改变已有会话，新会话受 SDK 缓存刷新影响。
- 缺少密钥、提示词或有效配置时，相关调用准备失败。
- 变量读取或输入编译失败、提交前关闭或取消时，不提交该轮输入。
- 调用所需工具必须配置对应说明，工具名不得重复；包装只替换工具的 `description`，保留原始参数定义和执行行为。
- 模板必须符合上述消息结构，正文不得为空白；会话历史及工具结果不在模板中重复注入。
- 输入仍受模型上下文窗口和图片能力限制；空间规划状态作为正式消息参与会话历史与压缩。
- 关闭追踪不会关闭提示词读取。生成记录关联实际使用的提示词版本，查看方式见[共享追踪说明](../../packages/observability/README.md)。
- 当前不提供自动评测、审批或持续集成发布流程。

模板结构或变量发生变化时，代码与模板须配套发布或回退，并重启 Agent Host 创建新会话。重启前保存需要保留的规划草稿。
