# Agent

## Workflow 扩展

每个 `src/workflows/<name>/workflow.ts` 必须导出 `extensions`，声明所需的运行时扩展；没有扩展时导出 `[] as const`。运行 `bun run --cwd apps/agent generate` 自动汇总声明，无需修改宿主。具体对话显式选择所需扩展。

扩展和文档定义可以在模块内复用，会话状态由对应的对话持有。浏览器通过 `backend-client` 构建边界使用 Workflow 契约；扩展定义的初始化应能在未使用时被构建工具移除。

会话的流式文本与完整回答由通用进度通路交付，完整回答先于成功结果发送。空间规划结果只包含规划状态与会话信息，不另行返回回答正文。
