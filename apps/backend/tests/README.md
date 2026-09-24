# Backend 测试

此目录用于 backend 测试，目前没有测试用例。

在仓库根目录执行 `bun run --cwd apps/backend test`。使用 Bun 内置测试运行器；没有测试文件时正常退出。

编写约定：

- 测试文件使用 `*.test.ts`，按功能组织在此目录下，使用 `bun:test`。
- HTTP 测试通过 `createApp()` 创建独立应用，使用 Hono 的 `app.request()` 校验状态码、响应头与响应体，无需启动服务器。
- 显式注入固定环境和必要依赖，避免依赖本机环境、真实配置文件或外部服务。
- 不导入 `src/main.ts`；它负责启动服务和初始化资源。
- 有实际复用需求后再提取 fixtures 或 helpers。

参考 [Hono 测试指南](https://hono.dev/docs/guides/testing)。新增测试前需遵循仓库规则，取得用户明确许可。
