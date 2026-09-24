# Web

React + Vite 本机服务连接页面，支持编辑 Agent、go2rtc 地址、保存配置和查询连接状态。backend 健康状态独立显示。

## 运行

首次准备见[项目启动说明](../../README.md#启动)。在仓库根目录执行 `bun run dev`，访问 <http://127.0.0.1:5173/>。开发服务器将 `/api` 代理到 `BACKEND_HOST:BACKEND_PORT`，默认 `127.0.0.1:3000`；配置读取根目录 `.env`。

`bun run start` 构建后由 backend 提供页面与 API，默认地址为 <http://127.0.0.1:3000/>。`bun run --filter @home-agent/web preview` 仅预览静态构建，不提供 API 代理；完整功能使用 backend 托管入口。

## 开发约定

- 依赖版本由根 `package.json` 的 Bun catalog 管理，TypeScript 配置继承 `packages/typescript-config`。
- API schema 和类型从 `@home-agent/api/contracts` 导入。
- 中文错误及连接状态文案集中在 `src/messages/zh-CN.ts`，按共享错误码显示。
- 使用 Oxlint 检查类型、React Hooks 和可访问性，Oxfmt 负责格式化；根目录执行 `bun run check`。
- `VITE_*` 环境变量会暴露给浏览器，不得存放后端密钥。

功能约定见[服务连接配置](../../docs/service-connections.md)，错误契约见[错误处理](../../docs/errors.md)。
