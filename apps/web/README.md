# Web

使用 `create-vite@9.2.1 --template react-ts` 初始化，保留模板示例并增加 backend 连接检查。

- React 19.3.0，Vite 8.3.1，`@vitejs/plugin-react` 6.1.1。
- Vite 8 内置 Rolldown；React 插件使用 Oxc，无需 `rolldown-vite` 别名或 Babel。
- Oxlint 开启类型感知、React Hooks、Refresh 和可访问性规则；Oxfmt 统一由根目录执行。
- 版本通过根 `package.json` 的 Bun catalog 管理；TS 配置继承 `packages/typescript-config`。
- `packages/contracts` 提供浏览器和 backend 共用的 Zod schema，不引入服务端代码。

在仓库根目录执行 `bun run dev`，打开 http://127.0.0.1:5173/。Vite 本身使用 Bun 运行，浏览器中的 React 仍由浏览器执行。

`/api` 代理到 `BACKEND_HOST:BACKEND_PORT`（默认 `127.0.0.1:3000`），两边读取根目录 `.env`。不要把后端密钥放进 `VITE_*` 环境变量。

`bun run build` 后执行 `bun run start`，由 Hono 在 http://127.0.0.1:3000/ 提供页面和 API。`bun run --filter @home-agent/web preview` 仅用于本地预览前端构建，连接检查仍需要运行 backend。

React Compiler 沿用官方 react-ts 模板默认：不额外启用。Rolldown 和 Oxc 已生效，不需要开启实验性编译选项。

参考：[Vite 8](https://vite.dev/blog/announcing-vite8)、[Vite 入门](https://vite.dev/guide/)、[Oxlint](https://oxc.rs/docs/guide/usage/linter.html)、[Oxfmt](https://oxc.rs/docs/guide/usage/formatter.html)。
